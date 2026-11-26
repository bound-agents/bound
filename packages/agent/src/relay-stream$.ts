import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import {
	acknowledgeDurableWork,
	claimDurableWorkByIds,
	readDurableResponsesByStreamId,
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
	Observable,
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
	startWith,
	takeUntil,
	takeWhile,
	tap,
	throwIfEmpty,
	timeout,
	timer,
} from "rxjs";
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
	/**
	 * How long a detached drain keeps polling for a `trace_data` batch the
	 * remote publishes after the stream's terminal row. Bounded and detached:
	 * it never delays user-visible completion.
	 */
	lateTraceDrainMs?: number;
	scheduler?: SchedulerLike;
}

const POLL_INTERVAL_MS = 500;
const LATE_TRACE_DRAIN_MS = 60_000;
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
	traceConsumed: boolean;
	done: boolean;
	error: string | null;
}

/**
 * Deliver a remote error downstream, then run the error row's settle callbacks.
 * `subscriber.error()` propagates synchronously through the operator chain to
 * the consumer, so the token-fenced ack lands strictly after delivery. When the
 * consumer has already gone away this inner observable is never subscribed, so
 * an undelivered error is never acknowledged.
 */
function errorThenSettle(message: string, settles: Array<() => void>): Observable<never> {
	return new Observable<never>((subscriber) => {
		subscriber.error(new Error(message));
		for (const settle of settles) settle();
	});
}

/** Re-export a claimed trace_data payload; unparseable payloads are retired unexported. */
function reExportTracePayload(deps: RelayStreamDeps, payload: string, kind: string): void {
	const spanResult = parseJsonUntyped(payload, kind);
	if (spanResult.ok) {
		reExportSpans(spanResult.value as SerializedSpan[], getTraceExporter(), deps.logger);
	}
}

/**
 * Claim, re-export, and token-fenced-ack any pending trace_data rows for the
 * stream. Returns true when at least one batch was consumed.
 */
function drainTraceRowsOnce(deps: RelayStreamDeps, streamId: string): boolean {
	const traceIds = readDurableResponsesByStreamId(deps.db, streamId, deps.siteId)
		.filter((row) => row.kind === "trace_data")
		.map((row) => row.id);
	let consumed = false;
	for (const claimed of claimDurableWorkByIds(deps.db, traceIds, deps.siteId)) {
		if (!claimed.claim_token) continue;
		reExportTracePayload(deps, claimed.payload, claimed.kind);
		acknowledgeDurableWork(deps.db, claimed.id, claimed.claim_token);
		consumed = true;
	}
	return consumed;
}

/**
 * The remote publishes trace_data from its `finally`, after the terminal
 * stream_end/error row, so the stream's own poller has usually stopped by the
 * time it lands. Poll for it on a detached subscription — bounded by
 * `windowMs`, ended by the first consumed batch (one trace_data per request) —
 * so optional telemetry never holds user-visible completion open.
 */
function startLateTraceDrain(
	deps: RelayStreamDeps,
	streamId: string,
	pollIntervalMs: number,
	windowMs: number,
	scheduler?: SchedulerLike,
): void {
	merge(
		interval(pollIntervalMs, scheduler),
		fromEventBus(deps.eventBus, "relay:inbox").pipe(
			filter((event) => (event as Record<string, unknown>).stream_id === streamId),
		),
	)
		.pipe(
			startWith(0),
			takeUntil(timer(windowMs, scheduler)),
			takeWhile(() => !drainTraceRowsOnce(deps, streamId)),
		)
		.subscribe({
			error: (error) =>
				deps.logger.warn("RELAY_STREAM: late trace drain failed", {
					streamId,
					error: error instanceof Error ? error.message : String(error),
				}),
		});
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

		// Fold the pending durable response rows targeted at self for this
		// stream_id, adapted to a { id, kind, payload, settle } shape for the
		// seq-dedup / gap-skip logic below. CRITICAL ORDER (claim → deliver →
		// ack): a durable row is CLAIMED under a fresh token now, but its ack is
		// DEFERRED to settle() — invoked only after this seq's chunks are emitted
		// downstream. A crash between emission and ack boot-resets the row → the
		// re-fold is absorbed by the seq-dedup below (any seq < nextExpectedSeq is
		// suppressed), so a late ack is harmless while an early ack would be lossy.
		type UnionEntry = { id: string; kind: string; payload: string; settle: () => void };
		const unionEntries: UnionEntry[] = [];
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

		// Handle trace_data responses (AC5.4) BEFORE the error branch: every row for
		// this stream was claimed above, and the late-trace drain only reads pending
		// rows, so a trace claimed in the error tick must be consumed here or it is
		// stranded and dead-lettered. A batch landing after the terminal row is
		// picked up by startLateTraceDrain instead.
		const traceDataEntry = unionEntries.find((e) => e.kind === "trace_data");
		if (traceDataEntry) {
			reExportTracePayload(deps, traceDataEntry.payload, traceDataEntry.kind);
			next.traceConsumed = true;
			// trace_data is fire-and-forget (no downstream chunk emission); its re-export
			// happens here, so settling it this tick keeps claim → deliver → ack order.
			next.settlesToRun.push(traceDataEntry.settle);
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
			// route each part through the router (part-scoped keys) for reassembly on
			// the receiver. Stream chunks ride back by stream_id through the consumer
			// below.
			let outboxEntry: { id: string };
			if (requestParts) {
				// One clock read for the whole part set: the receiver's envelope check
				// requires every sibling to carry the same expires_at.
				const partsNow = new Date();
				const partIds = requestParts.map((part) => {
					const routed = routeRelayRequest(deps.db, {
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
						now: partsNow,
						topologyRole: deps.topologyRole,
					});
					if (routed.path === "error") throw new Error(routed.reason);
					return routed.id;
				});
				outboxEntry = { id: partIds[0] };
			} else {
				const routed = routeRelayRequest(deps.db, {
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
				});
				if (routed.path === "error") throw new Error(routed.reason);
				outboxEntry = { id: routed.id };
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
				traceConsumed: false,
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
					// A remote terminal (stream_end or error) means the remote's `finally`
					// may still publish trace_data. Cancelled/timed-out streams never reach
					// here, so they start no drain.
					if ((s.done || s.error) && !s.traceConsumed) {
						startLateTraceDrain(
							deps,
							streamId,
							pollIntervalMs,
							options?.lateTraceDrainMs ?? LATE_TRACE_DRAIN_MS,
							options?.scheduler,
						);
					}
				}),
				mergeMap((s): Observable<RelayEmission> => {
					const err = s.error;
					const settles = s.settlesToRun;
					if (err) {
						// CRITICAL ORDER (claim → deliver → ack): deliver the error downstream,
						// then settle the error row. concat() cannot do this — it advances on
						// completion, never on error — so the error is delivered synchronously
						// through the subscriber and the token-fenced ack runs after it returns.
						return errorThenSettle(err, settles);
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
						// Cancel is a directed active request — route it through the same
						// helper as the initial dispatch. The receiving durable-work lane
						// dispatches the cancel row like any request.
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
