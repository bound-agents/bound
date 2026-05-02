import { randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import { markProcessed, readInboxByStreamId, writeOutbox } from "@bound/core";
import type { InferenceRequestPayload, StreamChunk, StreamChunkPayload } from "@bound/llm";
import type { TypedEventEmitter } from "@bound/shared";
import { errorPayloadSchema, parseJsonSafe, parseJsonUntyped } from "@bound/shared";
import type { Logger } from "@bound/shared";
import {
	Observable,
	type SchedulerLike,
	Subject,
	catchError,
	concatMap,
	filter,
	from,
	interval,
	merge,
	scan,
	takeUntil,
	throwIfEmpty,
} from "rxjs";
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

interface PerHostState {
	buffer: Map<number, StreamChunkPayload>;
	nextExpectedSeq: number;
	gapCyclesWaited: number;
	streamEndSeq: number | null;
	streamEndConsumed: boolean;
	firstChunkReceived: boolean;
	hostStartTime: number;
	lastActivityTime: number;
	hostSucceeded: boolean;
	timedOut: boolean;
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

	// Track if any host timed out (vs. observable completed due to abort before timeout)
	// Mutable object so it can be updated during subscription
	const timeoutOccurred = { value: false };

	return from(eligibleHosts).pipe(
		concatMap((host, hostIndex) => {
			const streamId = randomUUID();

			// Write inference request to outbox
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

			// Create per-host observable
			return new Observable<StreamChunk>((subscriber) => {
				const hostStartTime = Date.now();
				let hostSucceeded = false;
				let completed = false;
				let errorMsg: string | null = null;
				const stop$ = new Subject<void>();

				const initialState: PerHostState = {
					buffer: new Map(),
					nextExpectedSeq: 0,
					gapCyclesWaited: 0,
					streamEndSeq: null,
					streamEndConsumed: false,
					firstChunkReceived: false,
					hostStartTime,
					lastActivityTime: hostStartTime,
					hostSucceeded: false,
					timedOut: false,
				};

				// Merge polling interval with relay inbox events for this stream
				const pollInterval = interval(pollIntervalMs, options?.scheduler);
				const inboxEvents$ = fromEventBus(deps.eventBus, "relay:inbox").pipe(
					filter((event) => (event as Record<string, unknown>).stream_id === streamId),
				);

				const source$ = merge(pollInterval, inboxEvents$);

				const subscription = source$
					.pipe(
						takeUntil(aborted$),
						takeUntil(stop$),
						scan<unknown, PerHostState>((state, _tick) => {
							if (completed) return state;

							// Check per-host timeout
							const now = Date.now();
							const timeoutSource = state.firstChunkReceived
								? state.lastActivityTime
								: state.hostStartTime;
							const elapsedMs = now - timeoutSource;

							if (elapsedMs > perHostTimeoutMs) {
								deps.logger.warn("RELAY_STREAM: timeout, failing over", {
									host: host.host_name,
									elapsedMs,
									nextHostAvailable: hostIndex + 1 < eligibleHosts.length,
								});
								state.timedOut = true;
								completed = true;
								// Track timeout at the closure level for error reporting
								// Use a mutable object so it can be updated during subscription
								timeoutOccurred.value = true;
								stop$.next(); // Signal processing to stop
								return state;
							}

							// Fetch all unprocessed entries
							const inboxEntries = readInboxByStreamId(deps.db, streamId);

							// Check for errors
							const errorEntry = inboxEntries.find((e) => e.kind === "error");
							if (errorEntry) {
								const errResult = parseJsonSafe(
									errorPayloadSchema,
									errorEntry.payload,
									errorEntry.kind,
								);
								markProcessed(deps.db, [errorEntry.id]);
								if (!errResult.ok) {
									errorMsg = `Remote inference error: ${errorEntry.payload}`;
								} else {
									errorMsg = errResult.value.error ?? "Remote inference error";
								}
								completed = true;
								stop$.next(); // Signal processing to stop
								return state;
							}

							// Buffer stream_chunk and stream_end entries
							const streamEndEntry = inboxEntries.find((e) => e.kind === "stream_end");
							const chunkEntries = inboxEntries.filter((e) => e.kind === "stream_chunk");
							let streamEndSeq = state.streamEndSeq;

							for (const entry of [...chunkEntries, ...(streamEndEntry ? [streamEndEntry] : [])]) {
								const chunkResult = parseJsonUntyped(entry.payload, entry.kind);
								markProcessed(deps.db, [entry.id]);
								if (!chunkResult.ok) {
									continue;
								}
								const chunkPayload = chunkResult.value as StreamChunkPayload;

								// MINOR Issue 3: Validate payload structure before use
								if (typeof chunkPayload.seq !== "number" || !Array.isArray(chunkPayload.chunks)) {
									continue;
								}

								if (!state.buffer.has(chunkPayload.seq)) {
									state.buffer.set(chunkPayload.seq, chunkPayload);
								}
								if (entry.kind === "stream_end") {
									streamEndSeq = chunkPayload.seq;
								}
							}

							state.streamEndSeq = streamEndSeq;

							// Emit all in-order chunks
							while (state.buffer.has(state.nextExpectedSeq)) {
								// biome-ignore lint/style/noNonNullAssertion: checked with buffer.has() above
								const chunkPayload = state.buffer.get(state.nextExpectedSeq)!;
								state.buffer.delete(state.nextExpectedSeq);
								state.nextExpectedSeq++;

								for (const chunk of chunkPayload.chunks) {
									if (!state.firstChunkReceived) {
										state.firstChunkReceived = true;
										const firstChunkLatencyMs = Date.now() - state.hostStartTime;
										if (relayMetadataRef) {
											relayMetadataRef.hostName = host.host_name;
											relayMetadataRef.firstChunkLatencyMs = firstChunkLatencyMs;
										}
										deps.logger.info("RELAY_STREAM: first chunk", {
											host: host.host_name,
											latencyMs: firstChunkLatencyMs,
										});
									}
									state.lastActivityTime = Date.now();
									subscriber.next(chunk);
								}

								// Check if stream_end has been fully consumed
								if (streamEndSeq !== null && state.nextExpectedSeq > streamEndSeq) {
									state.streamEndConsumed = true;
								}

								state.gapCyclesWaited = 0;
							}

							// Stream complete when stream_end consumed and buffer drained
							if (state.streamEndConsumed && state.buffer.size === 0) {
								state.hostSucceeded = true;
								hostSucceeded = true;
								completed = true;
								stop$.next(); // Signal processing to stop
								subscriber.complete();
								return state;
							}

							// Detect gap — buffer has entries but next seq missing
							if (state.buffer.size > 0) {
								state.gapCyclesWaited++;
								if (state.gapCyclesWaited >= MAX_GAP_CYCLES) {
									const sortedSeqs = Array.from(state.buffer.keys()).sort((a, b) => a - b);
									const lowestBuffered = sortedSeqs[0];
									deps.logger.warn("RELAY_STREAM: seq gap detected, skipping", {
										expectedSeq: state.nextExpectedSeq,
										bufferedSeqs: sortedSeqs,
									});
									if (lowestBuffered < state.nextExpectedSeq) {
										// Stale duplicates — discard
										for (const seq of sortedSeqs) {
											if (seq < state.nextExpectedSeq) state.buffer.delete(seq);
										}
									} else {
										// Forward gap — skip to next buffered seq
										state.nextExpectedSeq = lowestBuffered;
									}
									state.gapCyclesWaited = 0;
								}
							}

							return state;
						}, initialState),
					)
					.subscribe({
						complete: () => {
							// CRITICAL Issue 1: Timeout must complete the subscriber so concatMap
							// can advance to the next host
							if (!hostSucceeded) {
								if (errorMsg) {
									// Remote inference error occurred
									subscriber.error(new Error(errorMsg));
								} else {
									// Timeout or other completion without success - complete normally
									// so concatMap can try the next host
									subscriber.complete();
								}
							}
							// If hostSucceeded, subscriber.complete() was already called in the scan callback
						},
					});

				return () => {
					stop$.complete();
					subscription.unsubscribe();
					// Write cancel on cleanup if stream didn't complete successfully
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
				};
			});
		}),
		// Throw error only if a host timed out or if no eligible hosts provided
		// If abort$ completed before any timeout, the observable completed with no emissions
		// but timeoutOccurred.value will be false, so we suppress the error
		throwIfEmpty(
			() =>
				new Error(`inference-relay.AC1.5: all ${eligibleHosts.length} eligible host(s) timed out`),
		),
		// Suppress throwIfEmpty errors in abort scenarios
		catchError((err) => {
			// Only suppress if: (1) this is throwIfEmpty error, (2) no timeout occurred,
			// (3) we had eligible hosts. This indicates abort$ completed before timeout.
			if (
				err instanceof Error &&
				err.message?.includes("all ") &&
				err.message?.includes("eligible host(s) timed out") &&
				!timeoutOccurred.value &&
				eligibleHosts.length > 0
			) {
				// abort$ completed before any timeout — complete silently
				return new Observable<StreamChunk>((subscriber) => {
					subscriber.complete();
				});
			}
			// Other errors (from hosts, parse errors, etc.) propagate
			throw err;
		}),
	);
}
