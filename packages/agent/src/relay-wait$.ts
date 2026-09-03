import type { Database } from "bun:sqlite";
import { recordTurnRelayMetrics } from "@bound/core";
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
import { type UnionResponseEntry, readUnionResponseEntry } from "./relay-await-helpers";
import { type EligibleHost, routeRelayRequest } from "./relay-router";
import { fromEventBus } from "./rx-utils";
import type { TopologyRole } from "./topology";

export interface RelayWaitDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
	/** Cluster role, for the durable-relay spoke hub-hop capability gate. */
	topologyRole?: TopologyRole;
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

/**
 * 4D-D union-await read for one awaiting request. Thin adapter over the shared
 * {@link readUnionResponseEntry} primitive: the exactly-once claim → deliver →
 * ack lifecycle (with legacy-first ordering, deferred settle, and token fence)
 * lives there and is shared with the two CLI remotePlatformRequest awaiters so
 * no call site hand-rolls its own poll loop. CRITICAL ORDER (claim → deliver →
 * ack): `settle()` is deferred by the Rx pipeline until AFTER the awaiter has
 * received the value (post `take(1)` emission); a crash between delivery and
 * ack boot-resets the durable row to pending and the later duplicate ages out
 * via its 300s TTL → dead_letter → prune — at-least-once with bounded residue,
 * never silent loss.
 */
function readUnionResponse(deps: RelayWaitDeps, refId: string): UnionResponseEntry | null {
	return readUnionResponseEntry(deps.db, refId, deps.siteId);
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
				try {
					const routed = routeRelayRequest(deps.db, {
						targetSiteId: currentHost.site_id,
						sourceSiteId: deps.siteId,
						kind: "tool_call",
						payload: toolPayload,
						timeoutMs,
						// Legacy carried no key here; the minted row id is a deterministic,
						// redelivery-stable key (R-DW5/6).
						topologyRole: deps.topologyRole,
					});
					currentOutboxId = routed.id;
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

			// 4D-D union-await: a response resolves this awaiter whether it arrived
			// over the LEGACY relay_inbox (the 4D-C status quo) or the DURABLE spool
			// (this slice). readUnionResponse reads both stores; a durable row is
			// claimed + delivered + acked (exactly-once via the token fence), a legacy
			// row is markProcessed as before. A response arriving via EITHER store
			// resolves the request, so a capability flip mid-flight is transparent.
			const response$ = merge(
				defer(() => of(readUnionResponse(deps, currentOutboxId))),
				fromEventBus(deps.eventBus, "relay:inbox").pipe(
					filter((event) => event.ref_id === currentOutboxId),
					map(() => readUnionResponse(deps, currentOutboxId)),
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
				// CRITICAL ORDER (claim → deliver → ack): the durable row was CLAIMED in
				// readUnionResponse but its ack (or legacy markProcessed) is deferred to
				// entry.settle(), fired in finalize() below — which runs only AFTER take(1)
				// has emitted the value downstream and completed. A crash between delivery
				// and settle boot-resets the durable row to pending; the redelivered copy
				// finds no subscriber (take(1) done) and ages out via TTL → dead_letter →
				// prune. At-least-once with bounded residue, never silent loss.
				map((entry) => ({ result: formatResponseText(entry), settle: entry.settle })),
				tap({
					next: ({ settle }) => {
						settle();
					},
				}),
				map(({ result }) => result),
				catchError((err) => {
					if (err instanceof TimeoutError) return EMPTY;
					return throwError(() => err);
				}),
			);

			const abort$ = aborted$.pipe(
				take(1),
				tap(() => {
					// 4D-D: cancel is a directed active request — route it through the same
					// helper as the initial dispatch so it rides the durable spool when the
					// hop advertises capability. The receiving 4D-A lane dispatches a durable
					// cancel row through the handler map like any request.
					try {
						routeRelayRequest(deps.db, {
							targetSiteId: currentHost.site_id,
							sourceSiteId: deps.siteId,
							kind: "cancel",
							payload: JSON.stringify({}),
							timeoutMs,
							refId: currentOutboxId,
							topologyRole: deps.topologyRole,
						});
					} catch (error) {
						deps.logger.warn("Failed to write relay cancel entry", {
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
