import type { Database } from "bun:sqlite";
import { markProcessed, readInboxByRefId, recordTurnRelayMetrics, writeOutbox } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { errorPayloadSchema, parseJsonSafe, resultPayloadSchema } from "@bound/shared";
import type { Logger } from "@bound/shared";
import {
	EMPTY,
	type Observable,
	TimeoutError,
	catchError,
	concat,
	concatMap,
	defer,
	filter,
	from,
	map,
	merge,
	of,
	race,
	take,
	tap,
	throwError,
	timeout,
} from "rxjs";
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

/**
 * Result of a relay wait. `content` is the formatted response text the agent
 * loop will render into the tool_result message; `retriable` propagates the
 * structured retry hint from `ErrorPayload.retriable` so higher layers can
 * decide whether to re-dispatch. Result responses set `retriable=false`;
 * timeouts set `retriable=true` (transient by definition).
 *
 * `definitely_not_executed` is set when the failure source can attest that
 * the target tool DEFINITELY did not run (e.g. hub fast-fail because the
 * target spoke was offline). Lets the agent loop retry safely even for
 * non-idempotent tools. Undefined for ambiguous errors and full timeouts.
 */
export interface RelayWaitResult {
	content: string;
	retriable: boolean;
	definitely_not_executed?: boolean;
}

function formatResponseText(response: { kind: string; payload: string }): RelayWaitResult {
	if (response.kind === "error") {
		const result = parseJsonSafe(errorPayloadSchema, response.payload, response.kind);
		if (!result.ok) {
			return { content: `Remote error: ${response.payload}`, retriable: false };
		}
		return {
			content: `Remote error: ${result.value.error || response.payload}`,
			retriable: result.value.retriable,
			definitely_not_executed: result.value.definitely_not_executed,
		};
	}
	if (response.kind === "result") {
		const result = parseJsonSafe(resultPayloadSchema, response.payload, response.kind);
		if (!result.ok) {
			return { content: `Remote result: ${response.payload}`, retriable: false };
		}
		return {
			content: buildCommandOutput(result.value.stdout, result.value.stderr, result.value.exit_code),
			retriable: false,
		};
	}
	return { content: `Unknown response kind: ${response.kind}`, retriable: false };
}

export function createRelayWait$(
	deps: RelayWaitDeps,
	params: RelayWaitParams,
	aborted$: Observable<unknown>,
	options?: RelayWaitOptions,
): Observable<RelayWaitResult> {
	const timeoutMs = options?.timeoutMs ?? 30_000;
	const relayStartTime = Date.now();
	const totalHosts = params.eligibleHosts.length;

	const hostObservables = from(params.eligibleHosts.slice(params.currentHostIndex)).pipe(
		concatMap((currentHost, relativeIndex) => {
			let currentOutboxId = params.outboxEntryId;

			if (relativeIndex > 0) {
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
					return EMPTY;
				}
			}

			deps.logger.info("Relay wait", {
				tool: params.toolName,
				host: currentHost.host_name,
			});

			const response$ = merge(
				defer(() => of(readInboxByRefId(deps.db, currentOutboxId))),
				fromEventBus(deps.eventBus, "relay:inbox").pipe(
					filter((event) => event.ref_id === currentOutboxId),
					map(() => readInboxByRefId(deps.db, currentOutboxId)),
				),
			).pipe(
				filter(
					(entry): entry is NonNullable<typeof entry> => entry !== null && entry !== undefined,
				),
				take(1),
				timeout(timeoutMs),
				tap(() => {
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
				}),
				tap((response) => markProcessed(deps.db, [response.id])),
				map((response) => formatResponseText(response)),
				catchError((err) => {
					if (err instanceof TimeoutError) return EMPTY;
					return throwError(() => err);
				}),
			);

			const abort$ = aborted$.pipe(
				take(1),
				tap(() => {
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
				}),
				map(() => ({
					content: "Cancelled: relay request was cancelled by user",
					retriable: false,
				})),
			);

			return race(response$, abort$);
		}),
	);

	return concat(
		hostObservables,
		of({
			content: `Timeout: all ${totalHosts} eligible host(s) did not respond within ${timeoutMs}ms`,
			retriable: true,
		}),
	);
}
