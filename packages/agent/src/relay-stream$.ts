import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import {
	acknowledgeDurableWork,
	claimDurableWorkByIds,
	hasDroppedLegacyRelayTables,
	markProcessed,
	readDurableResponsesByStreamId,
	readInboxByStreamId,
} from "@bound/core";
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
	concat,
	concatMap,
	defer,
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
import { type EligibleHost, routeRelayRequest } from "./relay-router";
import { fromEventBus } from "./rx-utils";
import type { TopologyRole } from "./topology";

export interface RelayStreamDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
	maxPayloadBytes?: number;
	/** Cluster role, for the durable-relay spoke hub-hop capability gate. */
	topologyRole?: TopologyRole;
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

interface BufferedChunk {
	payload: StreamChunkPayload;
	// Deferred consumer: the durable ack (token-fenced) or legacy markProcessed for
	// the row this seq came from. Invoked ONLY after this seq's chunks are emitted
	// downstream (claim → deliver → ack), so a crash between delivery and ack
	// boot-resets the row and the re-fold is absorbed by seq-dedup below.
	settle: () => void;
}

interface ScanOutput {
	buffer: Map<number, BufferedChunk>;
	nextExpectedSeq: number;
	gapCyclesWaited: number;
	streamEndSeq: number | null;
	streamEndConsumed: boolean;
	firstChunkReceived: boolean;
	hostStartTime: number;
	chunksToEmit: StreamChunk[];
	// Settle callbacks whose rows were emitted (or terminally consumed) THIS tick,
	// invoked by the pipeline AFTER the tick's chunks are emitted downstream.
	settlesToRun: Array<() => void>;
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
			settlesToRun: [],
			activity: false,
		};

		// 4D-D union: fold the UNION of legacy relay_inbox rows and pending durable
		// response rows targeted at self for this stream_id. Both are adapted to a
		// common { id, kind, payload, settle } shape; the seq-dedup / gap-skip logic
		// below is identical for either source. CRITICAL ORDER (claim → deliver →
		// ack): a durable row is CLAIMED under a fresh token now, but its ack is
		// DEFERRED to settle() — invoked only after this seq's chunks are emitted
		// downstream. A crash between emission and ack boot-resets the row → the
		// re-fold is absorbed by the seq-dedup below (any seq < nextExpectedSeq is
		// suppressed), so a late ack is harmless while an early ack would be lossy.
		type UnionEntry = { id: string; kind: string; payload: string; settle: () => void };
		// Post-drop (slice 4E): relay_inbox is gone on this host, so read only the
		// durable spool for stream chunks; the legacy read would throw on the
		// missing table. A capability flip already forced spool-only delivery here.
		const legacyRows = hasDroppedLegacyRelayTables(deps.db)
			? []
			: readInboxByStreamId(deps.db, streamId);
		const unionEntries: UnionEntry[] = legacyRows.map((e) => ({
			id: e.id,
			kind: e.kind,
			payload: e.payload,
			settle: () => markProcessed(deps.db, [e.id]),
		}));
		for (const durable of readDurableResponsesByStreamId(deps.db, streamId, deps.siteId)) {
			// Claim under a fresh token now so settle() acks exactly this generation.
			const claimed = claimDurableWorkByIds(deps.db, [durable.id], deps.siteId)[0];
			if (!claimed || !claimed.claim_token) continue; // lost the race; a later tick re-reads
			const token = claimed.claim_token;
			unionEntries.push({
				id: claimed.id,
				kind: claimed.kind,
				payload: claimed.payload,
				settle: () => acknowledgeDurableWork(deps.db, claimed.id, token),
			});
		}

		const errorEntry = unionEntries.find((e) => e.kind === "error");
		if (errorEntry) {
			const errResult = parseJsonSafe(errorPayloadSchema, errorEntry.payload, errorEntry.kind);
			// The error is delivered downstream as a thrown Error in mergeMap; settle
			// only after that emission (queued into settlesToRun, run post-emission).
			next.settlesToRun.push(errorEntry.settle);
			next.error = !errResult.ok
				? `Remote inference error: ${errorEntry.payload}`
				: (errResult.value.error ?? "Remote inference error");
			return next;
		}

		// Handle trace_data responses (AC5.4)
		// Handle trace_data responses (AC5.4)
		const traceDataEntry = unionEntries.find((e) => e.kind === "trace_data");
		if (traceDataEntry) {
			const spanResult = parseJsonUntyped(traceDataEntry.payload, traceDataEntry.kind);
			if (spanResult.ok) {
				const spans = spanResult.value as SerializedSpan[];
				reExportSpans(spans, getTraceExporter(), deps.logger);
			}
			// trace_data is fire-and-forget (no downstream chunk emission); its re-export
			// happens here, so settling it this tick keeps claim → deliver → ack order.
			next.settlesToRun.push(traceDataEntry.settle);
			// continue processing other entries
		}

		const streamEndEntry = unionEntries.find((e) => e.kind === "stream_end");
		const chunkEntries = unionEntries.filter((e) => e.kind === "stream_chunk");

		for (const entry of [...chunkEntries, ...(streamEndEntry ? [streamEndEntry] : [])]) {
			const chunkResult = parseJsonUntyped(entry.payload, entry.kind);
			if (!chunkResult.ok) {
				// Unparseable row: retire it now (its content is discarded, so there is
				// no downstream emission to order the ack after).
				next.settlesToRun.push(entry.settle);
				continue;
			}
			const chunkPayload = chunkResult.value as StreamChunkPayload;
			if (typeof chunkPayload.seq !== "number" || !Array.isArray(chunkPayload.chunks)) {
				next.settlesToRun.push(entry.settle);
				continue;
			}
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
			if (next.buffer.has(chunkPayload.seq)) {
				// Duplicate seq already buffered (or already emitted via a prior tick):
				// retire this copy without re-buffering. seq-dedup keeps output clean.
				next.settlesToRun.push(entry.settle);
			} else {
				// Carry the row's settle WITH its payload: it fires only when this seq's
				// chunks are emitted downstream (or skipped by the gap logic), never before.
				next.buffer.set(chunkPayload.seq, { payload: chunkPayload, settle: entry.settle });
			}
			if (entry.kind === "stream_end") {
				next.streamEndSeq = chunkPayload.seq;
			}
		}

		while (next.buffer.has(next.nextExpectedSeq)) {
			// biome-ignore lint/style/noNonNullAssertion: checked with buffer.has() above
			const buffered = next.buffer.get(next.nextExpectedSeq)!;
			const chunkPayload = buffered.payload;
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

			// This seq's chunks are now queued for downstream emission this tick, so its
			// row may be acked — but only AFTER the pipeline emits chunksToEmit. Queue
			// the settle; the pipeline runs it post-emission (claim → deliver → ack).
			next.settlesToRun.push(buffered.settle);

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
						if (seq < next.nextExpectedSeq) {
							// biome-ignore lint/style/noNonNullAssertion: seq came from buffer.keys()
							const dropped = next.buffer.get(seq)!;
							// Skipped-behind seq: its content is discarded, so there is no
							// emission to order its ack after — retire it now so the row does
							// not linger pending and re-fold forever.
							next.settlesToRun.push(dropped.settle);
							next.buffer.delete(seq);
						}
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
			// Multi-part inference REQUESTs (payload exceeds the transport ceiling)
			// stay 100% legacy for reassembly on the receiver, but the individual part
			// REQUESTs flip through the router (part-scoped keys) so they ride the durable
			// spool when toggle + per-hop capability permit. Stream chunks still ride back
			// by stream_id through the union-aware consumer below.
			let outboxEntry: { id: string };
			if (requestParts) {
				const partIds = requestParts.map(
					(part) =>
						routeRelayRequest(deps.db, {
							targetSiteId: host.site_id,
							sourceSiteId: deps.siteId,
							kind: "inference_part",
							payload: JSON.stringify(part),
							timeoutMs: perHostTimeoutMs,
							refId: requestId,
							// Verbatim #254 key: part-scoped so a redelivered part transfer dedupes.
							idempotencyKey: `inference-part:${requestId}:${part.index}`,
							streamId,
							traceContext: traceContext ? JSON.stringify(traceContext) : undefined,
							topologyRole: deps.topologyRole,
							maxPayloadBytes,
						}).id,
				);
				outboxEntry = { id: partIds[0] };
			} else {
				outboxEntry = routeRelayRequest(deps.db, {
					targetSiteId: host.site_id,
					sourceSiteId: deps.siteId,
					kind: "inference",
					payload: serializedPayload,
					timeoutMs: perHostTimeoutMs,
					// Verbatim #254 key: inference-stream:<streamId>.
					idempotencyKey: `inference-stream:${streamId}`,
					streamId,
					traceContext: traceContext ? JSON.stringify(traceContext) : undefined,
					topologyRole: deps.topologyRole,
					maxPayloadBytes,
				});
			}
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
				settlesToRun: [],
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
					const settles = s.settlesToRun;
					if (err) {
						// CRITICAL ORDER (claim → deliver → ack): run the error row's settle only
						// AFTER the error has been thrown downstream. defer() ensures the ack
						// fires on subscription to the tail, after the throwError emission.
						return concat(
							throwError(() => new Error(err)),
							defer(() => {
								for (const settle of settles) settle();
								return EMPTY;
							}),
						);
					}
					const emissions: RelayEmission[] = s.activity
						? [RELAY_ACTIVITY, ...s.chunksToEmit]
						: [...s.chunksToEmit];
					// CRITICAL ORDER (claim → deliver → ack): emit this tick's chunks FIRST,
					// then run each emitted row's settle in a trailing defer() — so the durable
					// ack (or legacy markProcessed) lands only after the chunk content has been
					// delivered downstream. A crash between emission and settle boot-resets the
					// row → re-fold → seq-dedup (nextExpectedSeq guard) suppresses the replay.
					return concat(
						from(emissions),
						defer(() => {
							for (const settle of settles) settle();
							return EMPTY;
						}),
					);
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
						// 4D-D: cancel is a directed active request — route it through the same
						// helper as the initial dispatch so it rides the durable spool when the
						// hop advertises capability. The receiving 4D-A lane dispatches a durable
						// cancel row through the handler map like any request.
						try {
							routeRelayRequest(deps.db, {
								targetSiteId: host.site_id,
								sourceSiteId: deps.siteId,
								kind: "cancel",
								payload: JSON.stringify({}),
								timeoutMs: 30_000,
								refId: logicalRequestId,
								traceContext: traceContext ? JSON.stringify(traceContext) : undefined,
								topologyRole: deps.topologyRole,
							});
						} catch (error) {
							deps.logger.warn("Failed to write relay cancel entry", {
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
