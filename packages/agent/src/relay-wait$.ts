import type { Database } from "bun:sqlite";
import { markProcessed, readInboxByRefId, recordTurnRelayMetrics, writeOutbox } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { errorPayloadSchema, parseJsonSafe, resultPayloadSchema } from "@bound/shared";
import type { Logger } from "@bound/shared";
import { Observable, concat, concatMap, filter, from, map, of, take, takeUntil } from "rxjs";
import { buildCommandOutput } from "./agent-loop-utils";
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
import { fromEventBus } from "./rx-utils";

export interface RelayWaitDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
}

export interface RelayWaitParams {
	outboxEntryId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	eligibleHosts: EligibleHost[];
	currentHostIndex: number;
	currentTurnId: string | null;
	threadId: string;
}

export interface RelayWaitOptions {
	timeoutMs?: number;
}

export function createRelayWait$(
	deps: RelayWaitDeps,
	params: RelayWaitParams,
	aborted$: Observable<unknown>,
	options?: RelayWaitOptions,
): Observable<string> {
	const timeoutMs = options?.timeoutMs ?? 30_000;
	const relayStartTime = Date.now();
	const totalHosts = params.eligibleHosts.length;

	const hostObservables = from(
		Array.from(
			{ length: totalHosts - params.currentHostIndex },
			(_, i) => i + params.currentHostIndex,
		),
	).pipe(
		concatMap((hostIndex) => {
			return new Observable<string>((subscriber) => {
				const currentHost = params.eligibleHosts[hostIndex];
				let currentOutboxId = params.outboxEntryId;

				// For failover hosts, create new outbox entry
				if (hostIndex > params.currentHostIndex) {
					const toolPayload = JSON.stringify({
						kind: "tool_call",
						toolName: params.toolName,
						args: params.toolInput,
					});
					const newEntry = createRelayOutboxEntry(
						currentHost.site_id,
						deps.siteId,
						"tool_call",
						toolPayload,
						timeoutMs,
					);
					try {
						writeOutbox(deps.db, newEntry);
						currentOutboxId = newEntry.id;
					} catch (error) {
						deps.logger.warn("Failed to write relay outbox entry for failover host", {
							host: currentHost.host_name,
							error: error instanceof Error ? error.message : String(error),
						});
						// Complete without emitting to try next host
						subscriber.complete();
						return;
					}
				}

				deps.logger.info("Relay wait", {
					tool: params.toolName,
					host: currentHost.host_name,
				});

				let timeoutId: number | null = null;
				let isAborted = false;
				let completed = false;

				// Handle abort signal
				const abortSub = aborted$.subscribe({
					next: () => {
						isAborted = true;
						if (timeoutId !== null) {
							clearTimeout(timeoutId);
						}
						// Write cancel entry
						const cancelEntry = createRelayOutboxEntry(
							currentHost.site_id,
							deps.siteId,
							"cancel",
							JSON.stringify({}),
							timeoutMs,
							currentOutboxId,
						);
						try {
							writeOutbox(deps.db, cancelEntry);
						} catch (error) {
							deps.logger.warn("Failed to write relay cancel outbox entry", {
								refId: currentOutboxId,
								error: error instanceof Error ? error.message : String(error),
							});
						}
						completed = true;
						subscriber.next("Cancelled: relay request was cancelled by user");
						subscriber.complete();
					},
				});

				// Check for existing response before setting up event listener
				const existingResponse = readInboxByRefId(deps.db, currentOutboxId);

				if (existingResponse && !isAborted) {
					// Process existing response immediately
					processResponse(existingResponse);
					abortSub.unsubscribe();
					return;
				}

				// Set up timeout
				timeoutId = setTimeout(() => {
					if (!completed && !isAborted) {
						completed = true;
						// Empty observable on timeout causes concatMap to try next host
						subscriber.complete();
					}
				}, timeoutMs) as unknown as number;

				// Set up event listener
				const eventSub = fromEventBus(deps.eventBus, "relay:inbox")
					.pipe(
						filter((event) => event.ref_id === currentOutboxId),
						map(() => readInboxByRefId(deps.db, currentOutboxId)),
						filter((entry) => entry !== null),
						take(1),
						takeUntil(aborted$),
					)
					.subscribe({
						next: (response) => {
							if (!completed && !isAborted && timeoutId !== null && response) {
								clearTimeout(timeoutId);
								completed = true;
								processResponse(response);
							}
						},
						complete: () => {
							// Event stream completed without emitting (shouldn't happen normally)
							if (!completed && !isAborted && timeoutId !== null) {
								clearTimeout(timeoutId);
								completed = true;
								subscriber.complete();
							}
						},
					});

				function processResponse(response: { id: string; kind: string; payload: string }) {
					// Record latency
					const latencyMs = Date.now() - relayStartTime;
					if (params.currentTurnId !== null) {
						try {
							recordTurnRelayMetrics(
								deps.db,
								params.currentTurnId,
								currentHost.host_name,
								latencyMs,
								deps.siteId,
							);
						} catch (error) {
							deps.logger.warn("Failed to record turn relay metrics", {
								threadId: params.threadId,
								turnId: params.currentTurnId,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}

					// Parse response
					if (response.kind === "error") {
						const payloadResult = parseJsonSafe(
							errorPayloadSchema,
							response.payload,
							response.kind,
						);
						markProcessed(deps.db, [response.id]);
						if (!payloadResult.ok) {
							subscriber.next(`Remote error: ${response.payload}`);
						} else {
							subscriber.next(`Remote error: ${payloadResult.value.error || response.payload}`);
						}
					} else if (response.kind === "result") {
						const payloadResult = parseJsonSafe(
							resultPayloadSchema,
							response.payload,
							response.kind,
						);
						markProcessed(deps.db, [response.id]);
						if (!payloadResult.ok) {
							subscriber.next(`Remote result: ${response.payload}`);
						} else {
							subscriber.next(
								buildCommandOutput(
									payloadResult.value.stdout,
									payloadResult.value.stderr,
									payloadResult.value.exit_code,
								),
							);
						}
					} else {
						markProcessed(deps.db, [response.id]);
						subscriber.next(`Unknown response kind: ${response.kind}`);
					}

					subscriber.complete();
				}

				return () => {
					if (timeoutId !== null) {
						clearTimeout(timeoutId);
					}
					eventSub.unsubscribe();
					abortSub.unsubscribe();
				};
			});
		}),
	);

	// Append timeout message if all hosts exhaust without emitting
	return concat(
		hostObservables,
		of(`Timeout: all ${totalHosts} eligible host(s) did not respond within ${timeoutMs}ms`),
	);
}
