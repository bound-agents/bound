import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import { markProcessed, readInboxByStreamId, writeOutbox } from "@bound/core";
import type { InferenceRequestPayload, StreamChunk, StreamChunkPayload } from "@bound/llm";
import type { TypedEventEmitter } from "@bound/shared";
import { errorPayloadSchema, parseJsonSafe, parseJsonUntyped } from "@bound/shared";
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
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
import { fromEventBus } from "./rx-utils";

export interface RelayStreamDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
}

export interface RelayStreamOptions {
	pollIntervalMs?: number;
	perHostTimeoutMs?: number;
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
	done: boolean;
	error: string | null;
}

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

		const streamEndEntry = inboxEntries.find((e) => e.kind === "stream_end");
		const chunkEntries = inboxEntries.filter((e) => e.kind === "stream_chunk");

		for (const entry of [...chunkEntries, ...(streamEndEntry ? [streamEndEntry] : [])]) {
			const chunkResult = parseJsonUntyped(entry.payload, entry.kind);
			markProcessed(deps.db, [entry.id]);
			if (!chunkResult.ok) continue;
			const chunkPayload = chunkResult.value as StreamChunkPayload;
			if (typeof chunkPayload.seq !== "number" || !Array.isArray(chunkPayload.chunks)) continue;
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
	const timeoutOccurred = { value: false };

	return from(eligibleHosts).pipe(
		concatMap((host, hostIndex) => {
			const streamId = randomUUID();
			const serializedPayload = JSON.stringify(payload);
			const outboxEntry = createRelayOutboxEntry(
				host.site_id,
				deps.siteId,
				"inference",
				serializedPayload,
				perHostTimeoutMs,
				undefined,
				undefined,
				streamId,
			);
			writeOutbox(deps.db, outboxEntry);

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
				done: false,
				error: null,
			};

			const pollInterval$ = interval(pollIntervalMs, options?.scheduler);
			const inboxEvents$ = fromEventBus(deps.eventBus, "relay:inbox").pipe(
				filter((event) => (event as Record<string, unknown>).stream_id === streamId),
			);

			return merge(pollInterval$, inboxEvents$).pipe(
				scan(createStreamReducer(deps, streamId, host, relayMetadataRef), initialState),
				takeWhile((s) => !s.done && !s.error, true),
				tap((s) => {
					if (s.done) hostSucceeded = true;
				}),
				mergeMap((s) => {
					const err = s.error;
					if (err) return throwError(() => new Error(err));
					return from(s.chunksToEmit);
				}),
				timeout({ first: perHostTimeoutMs, each: perHostTimeoutMs }),
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
							outboxEntry.id,
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
