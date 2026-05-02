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
	concatMap,
	from,
	interval,
	merge,
	scan,
	takeUntil,
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
				const inboxEvents$ = fromEventBus(deps.eventBus, "relay:inbox");

				// Filter to events for this specific stream
				const thisStreamEvents$ =
					inboxEvents$.pipe(
						// in RxJS, just filter in the map - but we need to ensure events pass through
						// The event-driven wakeup is not strictly necessary, just nice-to-have
					);

				const source$ = merge(pollInterval, thisStreamEvents$);

				const subscription = source$
					.pipe(
						takeUntil(aborted$),
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
									subscriber.error(new Error(`Remote inference error: ${errorEntry.payload}`));
								} else {
									subscriber.error(new Error(errResult.value.error ?? "Remote inference error"));
								}
								completed = true;
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
							if (!completed) {
								if (hostSucceeded) {
									subscriber.complete();
								} else {
									// Timeout occurred, try next host by completing without error
									subscriber.complete();
								}
							}
						},
					});

				return () => {
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
	);
}
