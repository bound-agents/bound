import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import { markProcessed, readInboxByStreamId, writeOutbox } from "@bound/core";
import type { InferenceRequestPayload, StreamChunk, StreamChunkPayload } from "@bound/llm";
import type { TypedEventEmitter } from "@bound/shared";
import {
	type SerializedSpan,
	errorPayloadSchema,
	getTraceExporter,
	injectTraceContext,
	parseJsonSafe,
	parseJsonUntyped,
	reExportSpans,
} from "@bound/shared";
import type { Logger } from "@bound/shared";
import {
	EMPTY,
	type SchedulerLike,
	TimeoutError,
	catchError,
	concatMap,
	filter,
	finalize,
	from,
	interval,
	merge,
	mergeMap,
	scan,
	takeUntil,
	takeWhile,
	tap,
	throwError,
	throwIfEmpty,
	timeout,
} from "rxjs";
import type { Observable } from "rxjs";
import { splitInferenceRequest } from "./inference-request-parts";
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
import { fromEventBus } from "./rx-utils";

export interface RelayStreamDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
	maxPayloadBytes?: number;
}

export interface RelayStreamOptions {
	pollIntervalMs?: number;
	/**
	 * Per-chunk inactivity timeout: max gap allowed *between* chunks once the
	 * stream is live. Heartbeats emitted by the source during extended thinking
	 * count as chunks and reset this, so it stays generous.
	 */
	perHostTimeoutMs?: number;
	/**
	 * First-token timeout: max wait for the first real model chunk from a target.
	 * Source heartbeats reset the inactivity timeout but do not satisfy this
	 * deadline, so a live backend that makes no progress fails over promptly.
	 */
	firstTokenTimeoutMs?: number;
	scheduler?: SchedulerLike;
}

const POLL_INTERVAL_MS = 500;
const MAX_GAP_CYCLES = 6;

interface ScanOutput {
	buffer: Map<number, StreamChunkPayload>;
	nextExpectedSeq: number;
	gapCyclesWaited: number;
	streamEndSeq: number | null;
	streamEndConsumed: boolean;
	firstChunkReceived: boolean;
	hostStartTime: number;
	chunksToEmit: StreamChunk[];
	activity: boolean;
	done: boolean;
	error: string | null;
}

const RELAY_ACTIVITY = Symbol("relay-activity");
type RelayEmission = StreamChunk | typeof RELAY_ACTIVITY;

function createStreamReducer(
	deps: RelayStreamDeps,
	streamId: string,
	host: EligibleHost,
	relayMetadataRef?: { hostName?: string; firstChunkLatencyMs?: number },
): (state: ScanOutput, tick: unknown) => ScanOutput {
	return (state, _tick) => {
		if (state.done || state.error) return state;

		const next: ScanOutput = {
			...state,
			buffer: new Map(state.buffer),
			chunksToEmit: [],
			activity: false,
		};

		const inboxEntries = readInboxByStreamId(deps.db, streamId);

		const errorEntry = inboxEntries.find((e) => e.kind === "error");
		if (errorEntry) {
			const errResult = parseJsonSafe(errorPayloadSchema, errorEntry.payload, errorEntry.kind);
			markProcessed(deps.db, [errorEntry.id]);
			next.error = !errResult.ok
				? `Remote inference error: ${errorEntry.payload}`
				: (errResult.value.error ?? "Remote inference error");
			return next;
		}

		// Handle trace_data responses (AC5.4)
		const traceDataEntry = inboxEntries.find((e) => e.kind === "trace_data");
		if (traceDataEntry) {
			const spanResult = parseJsonUntyped(traceDataEntry.payload, traceDataEntry.kind);
			markProcessed(deps.db, [traceDataEntry.id]);
			if (spanResult.ok) {
				const spans = spanResult.value as SerializedSpan[];
				reExportSpans(spans, getTraceExporter(), deps.logger);
			}
			// trace_data is fire-and-forget; continue processing other entries
		}

		const streamEndEntry = inboxEntries.find((e) => e.kind === "stream_end");
		const chunkEntries = inboxEntries.filter((e) => e.kind === "stream_chunk");

		for (const entry of [...chunkEntries, ...(streamEndEntry ? [streamEndEntry] : [])]) {
			const chunkResult = parseJsonUntyped(entry.payload, entry.kind);
			markProcessed(deps.db, [entry.id]);
			if (!chunkResult.ok) continue;
			const chunkPayload = chunkResult.value as StreamChunkPayload;
			if (typeof chunkPayload.seq !== "number" || !Array.isArray(chunkPayload.chunks)) continue;
			// An empty stream_chunk is a source heartbeat. Receiving a valid,
			// sequenced payload proves the target is alive even before its backend
			// emits the first model token, so it satisfies the first-activity timeout.
			next.activity = true;
			if (!next.firstChunkReceived) {
				next.firstChunkReceived = true;
				const firstChunkLatencyMs = Date.now() - next.hostStartTime;
				if (relayMetadataRef) {
					relayMetadataRef.hostName = host.host_name;
					relayMetadataRef.firstChunkLatencyMs = firstChunkLatencyMs;
				}
				deps.logger.info("RELAY_STREAM: first chunk", {
					host: host.host_name,
					latencyMs: firstChunkLatencyMs,
				});
			}
			if (!next.buffer.has(chunkPayload.seq)) {
				next.buffer.set(chunkPayload.seq, chunkPayload);
			}
			if (entry.kind === "stream_end") {
				next.streamEndSeq = chunkPayload.seq;
			}
		}

		while (next.buffer.has(next.nextExpectedSeq)) {
			// biome-ignore lint/style/noNonNullAssertion: checked with buffer.has() above
			const chunkPayload = next.buffer.get(next.nextExpectedSeq)!;
			next.buffer.delete(next.nextExpectedSeq);
			next.nextExpectedSeq++;

			for (const chunk of chunkPayload.chunks) {
				if (!next.firstChunkReceived) {
					next.firstChunkReceived = true;
					const firstChunkLatencyMs = Date.now() - next.hostStartTime;
					if (relayMetadataRef) {
						relayMetadataRef.hostName = host.host_name;
						relayMetadataRef.firstChunkLatencyMs = firstChunkLatencyMs;
					}
					deps.logger.info("RELAY_STREAM: first chunk", {
						host: host.host_name,
						latencyMs: firstChunkLatencyMs,
					});
				}
				next.chunksToEmit.push(chunk);
			}

			if (next.streamEndSeq !== null && next.nextExpectedSeq > next.streamEndSeq) {
				next.streamEndConsumed = true;
			}
			next.gapCyclesWaited = 0;
		}

		if (next.streamEndConsumed && next.buffer.size === 0) {
			next.done = true;
			return next;
		}

		if (next.buffer.size > 0) {
			next.gapCyclesWaited++;
			if (next.gapCyclesWaited >= MAX_GAP_CYCLES) {
				const sortedSeqs = Array.from(next.buffer.keys()).sort((a, b) => a - b);
				const lowestBuffered = sortedSeqs[0];
				deps.logger.warn("RELAY_STREAM: seq gap detected, skipping", {
					expectedSeq: next.nextExpectedSeq,
					bufferedSeqs: sortedSeqs,
				});
				if (lowestBuffered < next.nextExpectedSeq) {
					for (const seq of sortedSeqs) {
						if (seq < next.nextExpectedSeq) next.buffer.delete(seq);
					}
				} else {
					next.nextExpectedSeq = lowestBuffered;
				}
				next.gapCyclesWaited = 0;
			}
		}

		return next;
	};
}

export function createRelayStream$(
	deps: RelayStreamDeps,
	payload: InferenceRequestPayload,
	eligibleHosts: EligibleHost[],
	aborted$: Observable<unknown>,
	relayMetadataRef?: { hostName?: string; firstChunkLatencyMs?: number },
	options?: RelayStreamOptions,
): Observable<StreamChunk> {
	const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
	const perHostTimeoutMs = options?.perHostTimeoutMs ?? 300_000;
	const firstTokenTimeoutMs = options?.firstTokenTimeoutMs ?? 60_000;
	const timeoutOccurred = { value: false };

	return from(eligibleHosts).pipe(
		concatMap((host, hostIndex) => {
			const streamId = randomUUID();
			const serializedPayload = JSON.stringify(payload);
			const traceContext = injectTraceContext();
			const maxPayloadBytes = deps.maxPayloadBytes ?? 2 * 1024 * 1024;
			const serializedBytes = new TextEncoder().encode(serializedPayload).byteLength;
			const requestId = randomUUID();
			const requestParts =
				serializedBytes <= maxPayloadBytes
					? null
					: splitInferenceRequest(serializedPayload, requestId, maxPayloadBytes);
			const outboxEntries = requestParts
				? requestParts.map((part) =>
						createRelayOutboxEntry(
							host.site_id,
							deps.siteId,
							"inference_part",
							JSON.stringify(part),
							perHostTimeoutMs,
							requestId,
							`inference-part:${requestId}:${part.index}`,
							streamId,
							traceContext ? JSON.stringify(traceContext) : undefined,
						),
					)
				: [
						createRelayOutboxEntry(
							host.site_id,
							deps.siteId,
							"inference",
							serializedPayload,
							perHostTimeoutMs,
							undefined,
							undefined,
							streamId,
							traceContext ? JSON.stringify(traceContext) : undefined,
						),
					];
			for (const entry of outboxEntries) writeOutbox(deps.db, entry, maxPayloadBytes);
			const outboxEntry = outboxEntries[0];
			const logicalRequestId = requestParts ? requestId : outboxEntry.id;

			deps.logger.info("RELAY_STREAM: connecting", {
				host: host.host_name,
				model: payload.model,
				streamId,
			});

			let hostSucceeded = false;
			const hostStartTime = Date.now();

			const initialState: ScanOutput = {
				buffer: new Map(),
				nextExpectedSeq: 0,
				gapCyclesWaited: 0,
				streamEndSeq: null,
				streamEndConsumed: false,
				firstChunkReceived: false,
				hostStartTime,
				chunksToEmit: [],
				activity: false,
				done: false,
				error: null,
			};

			const pollInterval$ = interval(pollIntervalMs, options?.scheduler);
			const inboxEvents$ = fromEventBus(deps.eventBus, "relay:inbox").pipe(
				filter((event) => (event as Record<string, unknown>).stream_id === streamId),
			);

			const relayEmissions$ = merge(pollInterval$, inboxEvents$).pipe(
				scan(createStreamReducer(deps, streamId, host, relayMetadataRef), initialState),
				takeWhile((s) => !s.done && !s.error, true),
				tap((s) => {
					if (s.done) hostSucceeded = true;
				}),
				mergeMap((s): Observable<RelayEmission> => {
					const err = s.error;
					if (err) return throwError(() => new Error(err));
					const emissions: RelayEmission[] = s.activity
						? [RELAY_ACTIVITY, ...s.chunksToEmit]
						: [...s.chunksToEmit];
					return from(emissions);
				}),
				// Per-chunk inactivity clock: heartbeats (RELAY_ACTIVITY) reset this,
				// so a live backend mid-thinking is never falsely failed over.
				timeout({ each: perHostTimeoutMs }),
			);

			return relayEmissions$.pipe(
				// Strip heartbeats BEFORE the first-token deadline: liveness must not
				// satisfy progress. The deadline arms at host subscribe and is cleared
				// by the first real model chunk; on expiry the TimeoutError below
				// fails this host over to the next eligible one (#223).
				filter((value): value is StreamChunk => value !== RELAY_ACTIVITY),
				timeout({ first: firstTokenTimeoutMs }),
				takeUntil(aborted$),
				catchError((err) => {
					if (err instanceof TimeoutError) {
						deps.logger.warn("RELAY_STREAM: timeout, failing over", {
							host: host.host_name,
							nextHostAvailable: hostIndex + 1 < eligibleHosts.length,
						});
						timeoutOccurred.value = true;
						return EMPTY;
					}
					throw err;
				}),
				finalize(() => {
					if (!hostSucceeded) {
						const cancelEntry = createRelayOutboxEntry(
							host.site_id,
							deps.siteId,
							"cancel",
							JSON.stringify({}),
							30_000,
							logicalRequestId,
							undefined,
							undefined,
							traceContext ? JSON.stringify(traceContext) : undefined,
						);
						try {
							writeOutbox(deps.db, cancelEntry);
						} catch (error) {
							deps.logger.warn("Failed to write relay cancel outbox entry", {
								streamId,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
				}),
			);
		}),
		throwIfEmpty(
			() =>
				new Error(`inference-relay.AC1.5: all ${eligibleHosts.length} eligible host(s) timed out`),
		),
		catchError((err) => {
			if (
				err instanceof Error &&
				err.message?.includes("all ") &&
				err.message?.includes("eligible host(s) timed out") &&
				!timeoutOccurred.value &&
				eligibleHosts.length > 0
			) {
				return EMPTY;
			}
			throw err;
		}),
	);
}
