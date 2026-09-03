import type { Database } from "bun:sqlite";
import {
	type AppContext,
	DURABLE_WORK_MAX_ATTEMPTS,
	type ThreadExecutor,
	acknowledgeBatch,
	acknowledgeDurableWork,
	acknowledgeToolResultForCall,
	claimAndConsumeDurableWorkByIds,
	claimLocalDurableWork,
	claimPending,
	deadLetterClaimedDurableWork,
	enqueueClientToolCall,
	enqueueMessage,
	readDurablePartsByStreamId,
	recordRelayCycle,
	releaseDurableWorkClaim,
} from "@bound/core";
import type { InferenceRequestPayload, StreamChunk, StreamChunkPayload } from "@bound/llm";
import { LLMError, type ModelRouter } from "@bound/llm";
import type { PlatformMcpRegistry } from "@bound/platforms";
import type {
	ClientResultPayload,
	ClientToolPayload,
	ErrorPayload,
	Logger,
	PlatformRequestPayload,
	PromptInvokePayload,
	RelayConfig,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ResultPayload,
	SerializedSpan,
	ToolCallPayload,
	TypedEventEmitter,
} from "@bound/shared";
import {
	RELAY_KIND_REGISTRY,
	RELAY_RESPONSE_KINDS,
	type RelayRequestKind,
	clientToolPayloadSchema,
	createScopedTraceCollector,
	extractTraceContext,
	hostMcpToolsSchema,
	hostModelsSchema,
	inferenceRequestPartPayloadSchema,
	inferenceRequestPayloadSchema,
	injectTraceContext,
	intakePayloadSchema,
	notifyWakeupPayloadSchema,
	parseJsonSafe,
	parseJsonUntyped,
} from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import {
	EMPTY,
	type SchedulerLike,
	Subscription,
	catchError,
	exhaustMap,
	from,
	interval,
	merge,
	tap,
} from "rxjs";
import {
	calculateTurnCost,
	clampMaxOutputTokens,
	createFileRefResolver,
} from "./agent-loop-utils.js";
import { MainAgentLoop } from "./agent-loop.js";
import { stripCacheMarkersIfUnsupported } from "./cache-marker.js";
import { reconcileDarkConnectorHandles } from "./connector-handle-reconciler.js";
import { resolveSegments } from "./delegation-segments.js";
import { DURABLE_WORK_REGISTRY } from "./durable-work-registry.js";
import {
	type InferenceRequestPart,
	InferenceRequestPartAssembler,
} from "./inference-request-parts.js";
import { coerceArgsFromSchema } from "./mcp-arg-coercion.js";
import {
	resolveTopologyRole,
	routeRelayRequest,
	routeRelayResponse,
	serializeRelayTraceCarrier,
	shouldRouteRelayDurable,
} from "./relay-router.js";

/** Parse a serialized relay carrier without trusting its shape. */
function parseTraceCarrier(raw: string | null | undefined): Record<string, string> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const carrier: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === "string") carrier[key] = value;
			}
			return Object.keys(carrier).length > 0 ? carrier : null;
		}
	} catch {
		// Trace linkage is best-effort.
	}
	return null;
}
import { PASSIVE_INTAKE_KINDS } from "./intake-kind-registry.js";
import { buildMCPDispatchRegistry, formatMcpHelp, formatToolParamHint } from "./mcp-bridge.js";
import type { MCPClient } from "./mcp-client.js";
import { fromEventBus } from "./rx-utils.js";
import type { AgentLoopConfig } from "./types.js";
import { deliverNotificationWakeup } from "./wakeup-routing.js";
import { reconcileStaleWebhookIntake } from "./webhook-intake-reconciler.js";
const DEFAULT_POLL_INTERVAL_MS = 500;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DURABLE_RELAY_MAX_ATTEMPTS = DURABLE_WORK_MAX_ATTEMPTS;

/** Allow event handlers to claim pre-existing durable intake after daemon startup. */
export const INTAKE_RECONCILIATION_STARTUP_GRACE_MS = 20 * 60 * 1000;

const getTracer = () => trace.getTracer("bound.relay");

/**
 * Handler for a relay request kind. Returns a response string (written as a
 * "result" relay response) or null (handler wrote responses directly, e.g.
 * fire-and-forget kinds like process/inference).
 */
type RelayEntryHandler = (entry: RelayInboxEntry) => Promise<string | null>;

/**
 * All request kinds that processEntry dispatches to handlers.
 * - `cancel` is excluded because it is handled in the first pass of
 *   processPendingEntries (needs to run before other entries to abort in-flight
 *   work).
 * - `RelayPassiveKind` (currently `webhook_intake`) is excluded because passive
 *   kinds are durable mailbox rows owned by another consumer; the
 *   relay-processor must NOT touch them. See RELAY_KIND_REGISTRY in
 *   @bound/shared types.ts for the dispatch-mode contract.
 */
type HandledRequestKind = Exclude<
	RelayRequestKind,
	"cancel" | (typeof PASSIVE_INTAKE_KINDS)[number]
>;

/**
 * Thrown by handlers when payload parsing fails and the handler has already
 * written an error response + marked the entry as processed. processEntry's
 * catch block recognizes this and skips its normal error handling.
 */
class PayloadParseError extends Error {
	constructor() {
		super("Payload parse error (already handled)");
		this.name = "PayloadParseError";
	}
}

/**
 * Objection 3 (#253): a typed routing failure. When {@link routeRelayRequest} or
 * {@link routeRelayResponse} returns `path: "error"` (the target/requester no longer
 * advertises `work_spool_capable`), the message cannot be delivered and there is no
 * legacy fallback after release N+1. A silent consume of the claimed request row
 * would strand the sender's awaiter forever with no signal — the exact silent-drop
 * class the incident was about. Throwing this from a response writer or the intake
 * forward propagates the failure out of {@link dispatchActiveEntry} to
 * {@link processPendingDurableWork}, which dead-letters the claimed row
 * (workspool-redrivable) with {@link RelayResponseRoutingError.message} in
 * `last_error` so operators see it and can redrive after fixing capability.
 */
class RelayResponseRoutingError extends Error {
	constructor(
		readonly targetSiteId: string,
		readonly reason: string,
	) {
		super(`relay routing failed for target ${targetSiteId}: ${reason}`);
		this.name = "RelayResponseRoutingError";
	}
}

interface IdempotencyCacheEntry {
	response: string;
	expiresAt: number;
}

/**
 * Minimal view of the web-layer WS connection registry needed to wire client
 * tools into a delegated loop (issue #91). Defined here rather than imported
 * from `@bound/web` because `web` depends on `agent`, not the reverse — the
 * concrete `ConnectionRegistry` is structurally assignable and injected at
 * startup via {@link RelayProcessor.setWsRegistry}.
 */
export interface ClientToolResolver {
	getClientToolsForThread(threadId: string): AgentLoopConfig["clientTools"];
	getConnectionForTool(threadId: string, toolName: string): string | undefined;
	getSystemPromptAdditionForThread(threadId: string): string | undefined;
}

export class RelayProcessor {
	private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
	private pendingCancels = new Set<string>();
	private activeInferenceStreams = new Map<string, AbortController>();
	private readonly completedInferenceParts = new Set<string>();
	// Objection 1 round-3 (#253): the durable lane records the claim token of the part
	// row it is currently dispatching here, keyed by durable-work id, so
	// handleInferencePart can retire the WHOLE sibling set (current part + pending
	// siblings) in one transaction before launching inference. Cleared by the lane after
	// dispatch returns.
	private readonly inflightPartClaimTokens = new Map<string, string>();
	// Objection 1 round-4 (#253): when a multipart reassembly ABORTS (a concurrent
	// claimant took a sibling), handleInferencePart releases the current part's claim
	// back to `pending` and records its id here so the durable lane skips its normal
	// consume-ack — the current part must stay recoverable, not be consumed while the
	// part set is short. Cleared by the lane after it inspects it.
	private readonly releasedPartIds = new Set<string>();
	private readonly threadAffinityMap: Map<string, string>;
	private platformMcpRegistry: PlatformMcpRegistry | null = null;
	private wsRegistry: ClientToolResolver | null = null;
	private fileReader?: (path: string) => Promise<Uint8Array>;
	private threadExecutor: ThreadExecutor | null = null;
	private readonly intakeReconciliationNotBeforeMs: number;
	private readonly now: () => number;
	private mcpConfirmGates = new Map<string, string[]>();

	/**
	 * Typed handler map — every HandledRequestKind MUST have an entry.
	 * Adding a new kind to RELAY_KIND_REGISTRY with dispatch "sync" or "async"
	 * without adding a handler here is a compile error.
	 */
	private readonly handlerMap: Record<HandledRequestKind, RelayEntryHandler> = {
		tool_call: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executeToolCall(p as ToolCallPayload),
			),
		resource_read: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executeResourceRead(p as ResourceReadPayload),
			),
		prompt_invoke: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executePromptInvoke(p as PromptInvokePayload),
			),
		cache_warm: (entry) => this.executeCacheWarm(entry),
		platform_request: (entry) =>
			this.handleParsedPayload(entry, parseJsonUntyped, (p) =>
				this.executePlatformRequest(p as PlatformRequestPayload),
			),
		inference: (entry) => this.handleInference(entry),
		inference_part: (entry) => this.handleInferencePart(entry),
		intake: (entry) => this.handleIntake(entry),
		notify_wakeup: (entry) => this.handleNotifyWakeup(entry),
		client_tool: (entry) => this.handleClientTool(entry),
	};

	constructor(
		private db: Database,
		private siteId: string,
		private mcpClients: Map<string, MCPClient>,
		private modelRouter: ModelRouter | null,
		private logger: Logger,
		private eventBus: TypedEventEmitter,
		private appCtx: AppContext | null = null,
		private relayConfig?: RelayConfig,
		threadAffinityMap: Map<string, string> = new Map(),
		private agentLoopFactory?: (config: AgentLoopConfig) => MainAgentLoop,
		now: () => number = Date.now,
	) {
		this.threadAffinityMap = threadAffinityMap;
		this.now = now;
		this.intakeReconciliationNotBeforeMs = now() + INTAKE_RECONCILIATION_STARTUP_GRACE_MS;
	}

	/** Inject the agent loop factory after startup completes (avoids circular init order). */
	setMcpConfirmationGates(gates: Map<string, string[]>): void {
		this.mcpConfirmGates = gates;
	}

	setAgentLoopFactory(factory: (config: AgentLoopConfig) => MainAgentLoop): void {
		this.agentLoopFactory = factory;
	}

	/** Inject the platform MCP registry after startup completes (avoids circular init order). */
	setPlatformMcpRegistry(registry: PlatformMcpRegistry): void {
		this.platformMcpRegistry = registry;
	}

	/**
	 * Inject the WS connection registry so a delegated loop on this host can
	 * resolve client tools for threads whose live session lives here (issue #91).
	 */
	setWsRegistry(registry: ClientToolResolver): void {
		this.wsRegistry = registry;
	}

	/** Inject the thread executor for dispatch queue integration (avoids circular init order). */
	setThreadExecutor(executor: ThreadExecutor): void {
		this.threadExecutor = executor;
	}

	/** Inject the file reader (e.g. ClusterFs.readFileBuffer) for virtual FS support in platform tools. */
	setFileReader(fn: (path: string) => Promise<Uint8Array>): void {
		this.fileReader = fn;
	}

	start(
		pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
		scheduler?: SchedulerLike,
	): { stop: () => void } {
		const sub = new Subscription();

		// Main processing tick: interval + event-driven wakeup
		const tick$ = scheduler ? interval(pollIntervalMs, scheduler) : interval(pollIntervalMs);

		const wakeup$ = fromEventBus(this.eventBus, "relay:outbox-written");

		const process$ = merge(tick$, wakeup$).pipe(
			exhaustMap(() =>
				from(
					(async () => {
						await this.processPendingEntries();
						this.pruneIdempotencyCache();
					})(),
				).pipe(
					catchError((error) => {
						this.logger.error("Relay processor tick failed", { error });
						return EMPTY;
					}),
				),
			),
		);

		// Separate prune interval (~every 60s)
		const pruneInterval$ = scheduler ? interval(60_000, scheduler) : interval(60_000);

		const prune$ = pruneInterval$.pipe(
			tap(() => {
				// Catch-of-last-resort for the webhook intake pipeline. Runs against
				// the LOCAL relay_inbox (invariant #3), so it sees intake on the host
				// that received the POST. Raises a deduplicated dead-letter advisory
				// for any webhook_intake left undrained by a dark handler — turning a
				// silent multi-hour outage into something the operator can act on.
				if (this.now() >= this.intakeReconciliationNotBeforeMs) {
					try {
						const { advisoriesRaised, deadLettered } = reconcileStaleWebhookIntake(
							this.db,
							this.siteId,
							{ logger: this.logger, eventBus: this.eventBus },
						);
						if (advisoriesRaised > 0 || deadLettered > 0) {
							this.logger.warn("[relay] Webhook intake reconcile acted", {
								advisoriesRaised,
								deadLettered,
							});
						}
					} catch (error) {
						this.logger.error("Webhook intake reconcile failed", { error });
					}
				}
				// Connector-side analogue: surface live connector-handle subscriptions
				// whose backing event task has gone dark (cancelled/deleted/missing).
				// Detector only — connector push events buffer in-memory, so there is
				// no durable backlog to dead-letter, just a dark subscription to flag.
				try {
					const { advisoriesRaised } = reconcileDarkConnectorHandles(this.db, this.siteId, {
						logger: this.logger,
					});
					if (advisoriesRaised > 0) {
						this.logger.warn("[relay] Dark connector handle reconcile acted", {
							advisoriesRaised,
						});
					}
				} catch (error) {
					this.logger.error("Dark connector handle reconcile failed", { error });
				}
			}),
		);

		sub.add(process$.subscribe());
		sub.add(prune$.subscribe());

		return {
			stop: () => {
				sub.unsubscribe();
				// Abort any in-flight inference stream so its heartbeat timer and
				// flush loop unwind through their `finally` (clearInterval +
				// activeInferenceStreams.delete) instead of continuing to write
				// stream_chunk rows after the caller tears the processor down. A
				// never-completing stream (e.g. a backend that blocks until cancelled)
				// would otherwise keep writing to a DB the owner is about to close.
				for (const controller of this.activeInferenceStreams.values()) {
					controller.abort();
				}
			},
		};
	}

	private async processPendingEntries(): Promise<void> {
		// Post-N+1: the legacy relay_outbox/relay_inbox loopback and inbox scan are
		// gone — the durable_work spool is the sole store. Self-targeted requests
		// loop back as LOCAL_WORK_TARGET rows claimed by processPendingDurableWork.
		await this.processPendingDurableWork();
	}

	/**
	 * 4D-A consumer lane. The registry supplies the eligible relay kinds; rows
	 * remain local workspool entries until their handler outcome is durably
	 * reflected in the existing relay_outbox response path.
	 */
	private async processPendingDurableWork(): Promise<void> {
		for (const registration of DURABLE_WORK_REGISTRY) {
			const relayKind = RELAY_KIND_REGISTRY[registration.kind as keyof typeof RELAY_KIND_REGISTRY];
			if (registration.consumer !== "relay" || !relayKind || relayKind.dispatch === "response")
				continue;

			const claimed = claimLocalDurableWork(this.db, this.siteId, registration.kind);
			if (!claimed) continue;

			// Cancel is deliberately excluded from HandledRequestKind (its abort logic
			// runs in the first pass of processPendingEntries, not via a handler). A
			// cancel routed durable (4D-D) arrives here as a claimed row, so it must
			// fire the same abort the legacy relay_inbox first pass fires — otherwise
			// the row falls through to the `!handler` branch below and dead-letters
			// without ever stopping the running stream. Mirror the legacy abort, then
			// consume the row (token-fenced ack) since the cancel is fully handled.
			if (claimed.kind === "cancel") {
				if (claimed.ref_id) {
					this.pendingCancels.add(claimed.ref_id);
					this.activeInferenceStreams.get(claimed.ref_id)?.abort();
				}
				if (
					!claimed.claim_token ||
					!acknowledgeDurableWork(this.db, claimed.id, claimed.claim_token)
				) {
					this.logger.warn("Lost durable relay claim before cancel acknowledgement", {
						durableWorkId: claimed.id,
					});
				}
				continue;
			}

			const handler = this.handlerMap[claimed.kind as HandledRequestKind];
			if (!handler) {
				const message = `No active relay handler for durable kind ${claimed.kind}`;
				if (claimed.attempt_count >= DURABLE_RELAY_MAX_ATTEMPTS) {
					deadLetterClaimedDurableWork(this.db, claimed.id, claimed.claim_token ?? "", message);
				} else {
					this.logger.warn(message, {
						durableWorkId: claimed.id,
						attemptCount: claimed.attempt_count,
					});
				}
				continue;
			}

			// Objection 4: a kind whose handler writes a response over the outbox
			// (sync dispatch) requires a source_site to address that response. A row
			// missing it is malformed producer input, not an infrastructure failure —
			// token-fenced dead-letter it immediately (workspool-redrivable after a
			// producer fix) rather than consuming it responseless or cycling forever.
			const writesResponse = relayKind.dispatch === "sync";
			if (writesResponse && !claimed.source_site) {
				deadLetterClaimedDurableWork(
					this.db,
					claimed.id,
					claimed.claim_token ?? "",
					`durable ${claimed.kind} row missing source_site; response cannot be addressed`,
				);
				this.logger.warn("Dead-lettered durable relay row missing source_site", {
					durableWorkId: claimed.id,
					kind: claimed.kind,
				});
				continue;
			}

			const entry: RelayInboxEntry = {
				id: claimed.id,
				source_site_id: claimed.source_site ?? "",
				kind: claimed.kind as RelayInboxEntry["kind"],
				ref_id: claimed.ref_id,
				stream_id: claimed.stream_id,
				idempotency_key: claimed.idempotency_key,
				payload: claimed.payload,
				expires_at: claimed.expires_at ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
				received_at: claimed.received_at ?? claimed.created_at,
				processed: 0,
				trace_context: null,
			};
			try {
				// dispatchActiveEntry is the shared core: it owns handler dispatch,
				// idempotency-cache fencing, error responses, and result correlation.
				// Unlike processActiveEntry (the legacy wrapper), it PROPAGATES
				// pre/post-dispatch infrastructure failures — handler error-outcomes
				// are still written and consumed inside it.
				// Objection 1 round-3 (#253): expose the current part's claim token so
				// handleInferencePart can retire the whole sibling set atomically before
				// launching inference. Only inference_part uses this; cleared after dispatch.
				if (claimed.kind === "inference_part" && claimed.claim_token) {
					this.inflightPartClaimTokens.set(claimed.id, claimed.claim_token);
				}
				try {
					await this.dispatchDurableEntry(entry);
				} finally {
					this.inflightPartClaimTokens.delete(claimed.id);
				}
				// Objection 1 round-4 (#253): a multipart reassembly that ABORTED on
				// concurrent-claim contention already released this part back to `pending`
				// (handleInferencePart, so the full set stays recoverable). Acking it here
				// would flip that just-released row to `consumed`, permanently shortening the
				// set. Skip the ack for a released part; the release is its terminal disposition
				// for this tick.
				if (this.releasedPartIds.delete(claimed.id)) {
					continue;
				}
				if (
					!claimed.claim_token ||
					!acknowledgeDurableWork(this.db, claimed.id, claimed.claim_token)
				) {
					this.logger.warn("Lost durable relay claim before acknowledgement", {
						durableWorkId: claimed.id,
					});
				}
			} catch (error) {
				// Objection 3 (#253): a typed routing failure means the response (or intake
				// forward) could not be addressed — the target/requester no longer advertises
				// capability and there is no legacy fallback after release N+1. Consuming the
				// row would strand the sender's awaiter silently; dead-letter it IMMEDIATELY
				// (workspool-redrivable) with the routing reason in last_error so an operator
				// sees it and the sender's timeout tells the truth. This is a terminal address
				// failure, not a transient infra blip, so it does not wait out the attempt budget.
				if (error instanceof RelayResponseRoutingError) {
					this.logger.error("Durable relay row unroutable; dead-lettering", {
						durableWorkId: claimed.id,
						kind: claimed.kind,
						targetSiteId: error.targetSiteId,
						reason: error.reason,
					});
					deadLetterClaimedDurableWork(
						this.db,
						claimed.id,
						claimed.claim_token ?? "",
						error.message,
					);
					continue;
				}
				// Infrastructure failure: nothing was durably dispatched. Leave the row
				// `processing` (claim-owned) so boot recovery reclaims it — NO consume,
				// NO immediate dead-letter. Only after the attempt budget is exhausted
				// across successive reclaims do we token-fence it into a dead letter.
				this.logger.error("Durable relay processing failed before dispatch completion", {
					error,
					durableWorkId: claimed.id,
				});
				if (claimed.attempt_count >= DURABLE_RELAY_MAX_ATTEMPTS) {
					deadLetterClaimedDurableWork(
						this.db,
						claimed.id,
						claimed.claim_token ?? "",
						String(error),
					);
				}
			}
		}
	}

	/**
	 * Wrap {@link dispatchActiveEntry} in the same receive span the legacy
	 * `processEntry` opens, but WITHOUT its swallow: infrastructure failures
	 * propagate to the durable caller. Response/passive kinds never reach here
	 * (the registry filter in {@link processPendingDurableWork} excludes them).
	 */
	private async dispatchDurableEntry(entry: RelayInboxEntry): Promise<void> {
		const parentContext = extractTraceContext(parseTraceCarrier(entry.trace_context));
		const span = getTracer().startSpan(
			"relay.request.receive",
			{
				attributes: {
					"relay.kind": entry.kind,
					"relay.request.id": entry.id,
					"relay.source.site_id": entry.source_site_id,
					"relay.durable": true,
					...(entry.stream_id ? { "relay.stream.id": entry.stream_id } : {}),
				},
			},
			parentContext,
		);
		try {
			await context.with(trace.setSpan(parentContext, span), () =>
				this.dispatchActiveEntry(entry, span),
			);
		} finally {
			span.end();
		}
	}

	private static readonly RESPONSE_KIND_SET = new Set<string>(RELAY_RESPONSE_KINDS);
	private static readonly PASSIVE_KIND_SET = new Set<string>(PASSIVE_INTAKE_KINDS);

	/**
	 * Dispatch core shared by the legacy and durable lanes. Handler-produced
	 * error responses are outcomes — written, cached, and marked processed here.
	 * Pre/post-dispatch INFRASTRUCTURE failures (a failed `writeResponse`, a
	 * malformed row that can't be adapted) propagate to the caller so the durable
	 * lane can keep the row `processing` instead of acking it consumed.
	 */
	private async dispatchActiveEntry(
		entry: RelayInboxEntry,
		receiveSpan: import("@opentelemetry/api").Span,
	): Promise<void> {
		{
			// Authorization keys on the authenticated delivering peer, not on
			// entry.source_site_id (#50, R-SR1/R-SR2/R-SR7). The frame that produced
			// this inbox row was decoded under a keyring peer's per-peer key at the
			// transport boundary (or originated locally); its mere presence in the
			// inbox carries that delivery-time authentication. source_site_id is the
			// hub's attestation of origin, used only for response correlation and
			// audit. Re-gating on it here rejected hub-vouched spoke-to-spoke traffic
			// with "Unknown source site". See docs/design/specs/2026-06-02-spoke-relay-trust.md.

			// Step 2: Check expiry (AC9.2)
			const now = new Date();
			if (new Date(entry.expires_at) < now) {
				// Discarded without execution; the durable lane acks the consumed row.
				return;
			}

			// Step 3: Check cancel (AC7.3)
			if (this.pendingCancels.has(entry.id)) {
				// Skip execution; the durable lane acks the consumed row.
				this.pendingCancels.delete(entry.id);
				return;
			}

			// Step 4: Idempotency check (AC5.1, AC5.3)
			if (entry.idempotency_key) {
				const cached = this.idempotencyCache.get(entry.idempotency_key);
				if (cached && cached.expiresAt > Date.now()) {
					// Cache hit - return cached response
					this.writeResponse(entry, "result", cached.response);
					return;
				}
				// Cache expired or not found, proceed with execution
				if (cached) {
					this.idempotencyCache.delete(entry.idempotency_key);
				}
			}

			// Step 5: Execute via typed handler map
			const executionStartTime = Date.now();
			let response: string | null;
			try {
				const handler = this.handlerMap[entry.kind as HandledRequestKind];
				if (!handler) {
					// Unknown relay kind at runtime (e.g., from a newer node version
					// during rolling upgrade). Log and skip.
					this.logger.warn("Unknown relay kind", { kind: entry.kind });
					return;
				}
				receiveSpan.addEvent("relay.handler.started");
				response = await handler(entry);
			} catch (executionError) {
				// PayloadParseError: handler already wrote error response and marked
				// processed — just record metrics and return.
				if (executionError instanceof PayloadParseError) {
					return;
				}
				// Step 5b: Handle execution errors
				receiveSpan.recordException(
					executionError instanceof Error ? executionError : new Error(String(executionError)),
				);
				receiveSpan.setStatus({
					code: SpanStatusCode.ERROR,
					message:
						executionError instanceof Error ? executionError.message : String(executionError),
				});
				receiveSpan.addEvent("relay.outcome", { "relay.outcome": "error" });
				const errorResponse: ErrorPayload = {
					error: String(executionError),
					retriable: true,
				};
				response = JSON.stringify(errorResponse);
				this.writeResponse(entry, "error", response);
				receiveSpan.addEvent("relay.response.enqueued", { "relay.response.kind": "error" });
				// Record relay cycle for error
				const executionMs = Date.now() - executionStartTime;
				try {
					recordRelayCycle(this.db, {
						direction: "inbound",
						peer_site_id: entry.source_site_id,
						kind: entry.kind,
						delivery_method: "sync",
						latency_ms: executionMs,
						expired: false,
						success: false,
					});
				} catch (error) {
					this.logger.warn("Failed to record relay metrics", {
						kind: entry.kind,
						direction: "inbound",
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}

			// Step 6: Write response (null means handler already wrote chunks)
			if (response !== null) {
				this.writeResponse(entry, "result", response);
				receiveSpan.addEvent("relay.response.enqueued", { "relay.response.kind": "result" });
			}

			// Step 7: Cache result if idempotency key is set (AC5.1)
			if (entry.idempotency_key && response !== null) {
				this.idempotencyCache.set(entry.idempotency_key, {
					response,
					expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
				});
			}

			// Step 8: outcome recorded — the durable lane token-acks the consumed row.
			receiveSpan.addEvent("relay.outcome", { "relay.outcome": "processed" });
			receiveSpan.setStatus({ code: SpanStatusCode.OK });

			// Step 9: Record relay cycle metrics
			const executionMs = Date.now() - executionStartTime;
			try {
				recordRelayCycle(this.db, {
					direction: "inbound",
					peer_site_id: entry.source_site_id,
					kind: entry.kind,
					delivery_method: "sync",
					latency_ms: executionMs,
					expired: false,
					success: true,
				});
			} catch (error) {
				this.logger.warn("Failed to record relay metrics", {
					kind: entry.kind,
					direction: "inbound",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	// --- Handler helpers ---

	/**
	 * Common parse-then-execute pattern for simple request kinds.
	 * Parses the payload, logs and returns an error response on failure,
	 * or calls the executor and returns its result.
	 */
	private async handleParsedPayload(
		entry: RelayInboxEntry,
		// biome-ignore lint/suspicious/noExplicitAny: parse functions have varying signatures
		parseFn: (payload: string, label: string) => { ok: boolean; value?: any; error?: string },
		executor: (parsed: unknown) => Promise<string | null>,
	): Promise<string | null> {
		const payloadResult = parseFn(entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Invalid payload: ${payloadResult.error}`, retriable: false }),
			);
			// The durable lane token-acks the consumed row after this error outcome.
			throw new PayloadParseError();
		}
		return executor(payloadResult.value);
	}

	private async handleInference(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(inferenceRequestPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Invalid payload: ${payloadResult.error}`, retriable: false }),
			);
			throw new PayloadParseError();
		}
		// Objection 2 round-3 (#253): PRE-FLIGHT the response route before acking/executing.
		// executeInference is fire-and-forget (below): once it launches, the durable lane
		// acks this request row. If a later stream write throws RelayResponseRoutingError it
		// lands in the .catch logger, NEVER the typed dead-letter catch in
		// processPendingDurableWork — a silent-consume path. Catch the deterministic
		// capability-gap class HERE, synchronously, before the row is consumed: if the
		// response target (entry.source_site_id) is a peer that does not advertise
		// work_spool_capable, throw so the typed catch dead-letters the request BEFORE
		// execution. A self-targeted (loopback) response never rides the capability gate, so
		// it is exempt — mirroring routeRelayResponse's own selfTargeted short-circuit. This
		// cannot catch a capability flip AFTER pre-flight (mid-stream); that residual is
		// handled by executeInference surfacing a structured logger.error (see below).
		const responseTarget = entry.source_site_id;
		if (responseTarget && responseTarget !== this.siteId) {
			const routable = shouldRouteRelayDurable(this.db, {
				targetSiteId: responseTarget,
				localSiteId: this.siteId,
				topologyRole: this.appCtx ? resolveTopologyRole(this.appCtx.optionalConfig) : undefined,
			});
			if (!routable) {
				throw new RelayResponseRoutingError(
					responseTarget,
					`inference response target ${responseTarget} does not advertise work_spool_capable; no legacy fallback after release N+1 (stale hosts snapshot or version-skewed peer)`,
				);
			}
		}
		this.executeInference(entry, payloadResult.value as InferenceRequestPayload).catch((err) => {
			this.logger.error("executeInference failed", { error: err, entryId: entry.id });
		});
		return null;
	}

	private async handleInferencePart(entry: RelayInboxEntry): Promise<null> {
		const parsed = parseJsonSafe(inferenceRequestPartPayloadSchema, entry.payload, entry.kind);
		if (!parsed.ok || !entry.ref_id) {
			throw new Error(
				`Invalid multipart inference payload: ${parsed.ok ? "missing ref_id" : parsed.error}`,
			);
		}
		const part = parsed.value as InferenceRequestPart;
		if (part.request_id !== entry.ref_id) throw new Error("Multipart request_id/ref_id mismatch");
		if (this.completedInferenceParts.has(part.request_id)) return null;

		// Multipart inference rides the durable spool: the parts are durable_work
		// `inference_part` REQUEST rows keyed by stream_id (set by the requester in
		// relay-stream$; ref_id carries the logical request_id). Read them by
		// stream_id through a request-kind reader — readDurableResponsesByStreamId
		// filters RELAY_RESPONSE_KINDS and can never see request rows. Assemble in
		// receive order.
		if (!entry.stream_id) throw new Error("Multipart inference part missing stream_id");
		const rows = readDurablePartsByStreamId(
			this.db,
			entry.stream_id,
			this.siteId,
			"inference_part",
		).map(
			(row) =>
				({
					id: row.id,
					source_site_id: row.source_site ?? entry.source_site_id,
					kind: row.kind,
					ref_id: row.ref_id,
					idempotency_key: row.idempotency_key,
					stream_id: row.stream_id,
					payload: row.payload,
					expires_at: row.expires_at ?? entry.expires_at,
					received_at: row.received_at ?? "",
					processed: 0,
					trace_context: null,
				}) as RelayInboxEntry,
		);
		const assembler = new InferenceRequestPartAssembler();
		let serialized: string | null = null;
		for (const row of rows) {
			if (
				row.source_site_id !== entry.source_site_id ||
				row.stream_id !== entry.stream_id ||
				row.expires_at !== entry.expires_at
			) {
				throw new Error("Conflicting multipart inference request envelope");
			}
			const rowPart = parseJsonSafe(inferenceRequestPartPayloadSchema, row.payload, row.kind);
			if (!rowPart.ok) throw new Error(`Invalid multipart inference payload: ${rowPart.error}`);
			const completed = assembler.add(rowPart.value as InferenceRequestPart);
			if (completed !== null) serialized = completed;
		}
		if (serialized === null) return null;
		if (this.pendingCancels.delete(part.request_id)) return null;

		// Objection 1 round-3 (#253): consume ALL sibling part rows atomically BEFORE
		// launching inference (claim-all-then-execute). This inverts the deliver-before-ack
		// principle the RESPONSE path uses, and deliberately so: parts are REQUEST
		// fragments, and the deliverable is the LAUNCHED INFERENCE, not the row content.
		// For a response the row content IS the deliverable, so it must be delivered before
		// the row is retired; for request parts the crash-recovery story is the requester's
		// timeout+retry (the pre-existing at-least-once contract, response-side idempotency
		// via `response:<requestId>` fences a duplicate response row), NOT part replay. If
		// we consumed parts one-by-one AFTER launching (the old behavior), a crash between
		// launch and the last sibling's ack left the full part set recoverable → boot
		// recovery re-pends → the in-process completedInferenceParts Set is empty → the
		// backend runs the logical request TWICE. Consuming every sibling in one
		// transaction before launch means a crash after consumption leaves NO recoverable
		// part rows, so recovery cannot re-assemble or re-execute. The (kind,idempotency_key)
		// fence only blocks duplicate row INSERTION, never duplicate execution — this does.
		const allIds = rows.map((r) => r.id);
		const consumed = this.consumeInferenceParts(allIds);
		if (!consumed) {
			// A concurrent claimant (another tick / a peer / boot recovery) took a sibling
			// before we could retire the whole set. The atomic claim-and-consume rolled back
			// entirely: nothing was claimed, nothing consumed. Abandon this reassembly rather
			// than double-launch. The current part is still `processing` under the lane's
			// token; if we let the lane ack it (the normal post-dispatch path) the part set
			// would be permanently one short and no future reassembly could complete. Release
			// the current part back to `pending` and record its id so the lane skips its ack —
			// the whole set stays recoverable for a later tick once the contended sibling is
			// freed. The winning path owns whatever it claimed and launches exactly once.
			const currentToken = this.inflightPartClaimTokens.get(entry.id);
			if (currentToken) {
				releaseDurableWorkClaim(this.db, entry.id, currentToken);
				this.releasedPartIds.add(entry.id);
			}
			return null;
		}

		this.completedInferenceParts.add(part.request_id);
		const synthetic: RelayInboxEntry = {
			...entry,
			id: part.request_id,
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			payload: serialized,
		};
		await this.handleInference(synthetic);
		return null;
	}

	/**
	 * Retire every sibling `inference_part` row for a completed multipart request in a
	 * SINGLE transaction (Objection 1 round-4, #253). The currently-claimed part already
	 * sits in `processing` under the durable lane's own claim token (passed in via
	 * `preClaimed`); its siblings are `pending`. `claimAndConsumeDurableWorkByIds` claims
	 * the pending siblings by id AND flips the whole set — the current part included — to
	 * `consumed`, all inside one `BEGIN IMMEDIATE`, so neither a crash NOR a concurrent
	 * claimant can leave a partial set: on ANY shortfall (a sibling was claimed away) the
	 * whole transaction rolls back — nothing claimed, nothing consumed — and this returns
	 * false. Round-3 split the claim and the ack across two transactions, so a shortfall
	 * rollback undid only the acks and left the freshly-committed sibling claims stranded
	 * `processing`; folding both phases into the repository's single transaction closes
	 * that window.
	 */
	private consumeInferenceParts(allIds: readonly string[]): boolean {
		if (allIds.length === 0) return false;
		// The current part is already `processing` under a token the durable lane exposed via
		// inflightPartClaimTokens; hand it in as pre-claimed so the repository consumes it
		// under that live generation instead of trying (and failing) to re-claim it from
		// `pending`. Every other id is a `pending` sibling the repository claims itself.
		const preClaimed = new Map<string, string>();
		for (const [id, token] of this.inflightPartClaimTokens) {
			if (allIds.includes(id)) preClaimed.set(id, token);
		}
		return claimAndConsumeDurableWorkByIds(this.db, allIds, this.siteId, preClaimed);
	}

	private async handleIntake(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(intakePayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			throw new PayloadParseError();
		}
		const payload = payloadResult.value;
		this.logger.info("[relay] Intake received", {
			platform: payload.platform,
			threadId: payload.thread_id,
			messageId: payload.message_id,
			source: entry.source_site_id,
		});
		const idempotencyKey = `intake:${payload.platform}:${payload.platform_event_id}`;

		// Dedup: check idempotency cache
		const cached = this.idempotencyCache.get(idempotencyKey);
		if (cached && cached.expiresAt > Date.now()) {
			return null; // Duplicate — silently discard
		}
		this.idempotencyCache.set(idempotencyKey, {
			response: "",
			expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
		});

		// Platform affinity is handled inside selectIntakeHost (Tier 0)
		const targetSiteId = this.selectIntakeHost(payload.thread_id, payload.platform ?? undefined);
		if (!targetSiteId) {
			this.logger.warn("relay-processor", { msg: "intake: no eligible host found, dropping" });
			return null;
		}

		this.logger.info("[relay] Intake routed", {
			platform: payload.platform,
			threadId: payload.thread_id,
			targetSiteId,
			isLocal: targetSiteId === this.siteId,
		});

		// Single delegation path (R-UD1): the selected host runs the agent loop
		// LOCALLY — it producer-assembles from its own authoritative state and
		// relays only the inference (and any tool calls) outward. There is no
		// whole-loop `process` delegation and no consumer that re-assembles from
		// an un-synced replica. When the selected host is remote, forward the
		// SAME `intake` entry to it; that host re-runs selectIntakeHost, selects
		// itself, and runs the loop locally. Affinity (platform-connector host)
		// is an optimization the selector applies, never a correctness gate
		// (R-UD12). See docs/design/specs/2026-06-29-unified-delegation.md.
		if (targetSiteId === this.siteId) {
			this.runLocalThreadLoop({
				threadId: payload.thread_id,
				messageId: payload.message_id,
				userId: `platform:${payload.platform}`,
				platform: payload.platform,
			}).catch((err) => {
				this.logger.error("Local intake loop failed", {
					error: err,
					threadId: payload.thread_id,
				});
			});
		} else {
			const routed = routeRelayRequest(this.db, {
				targetSiteId,
				sourceSiteId: entry.source_site_id ?? this.siteId,
				kind: "intake",
				payload: entry.payload,
				timeoutMs: 5 * 60 * 1000,
				refId: entry.id,
				idempotencyKey,
				traceContext: serializeRelayTraceCarrier(injectTraceContext()) ?? undefined,
				topologyRole: this.appCtx ? resolveTopologyRole(this.appCtx.optionalConfig) : undefined,
			});
			// Objection 3 (#253): an unroutable intake forward must NOT ack the claimed
			// intake row consumed — that silently drops the platform event. Propagate so
			// the durable lane dead-letters the row with the routing reason.
			if (routed.path === "error") {
				throw new RelayResponseRoutingError(routed.targetSiteId, routed.reason);
			}
		}

		return null;
	}

	/**
	 * Receiving side of a routed notify/introspect wakeup (#91 under unified
	 * delegation). The sender resolved THIS host as the holder of the thread's
	 * live WS session and shipped the notification payload here instead of
	 * enqueueing into its own local dispatch_queue — so exactly one host wakes
	 * the thread, beside its session. Delivery is UNCONDITIONAL (no re-routing):
	 * a session row churning mid-flight must not ping-pong the wakeup between
	 * hosts. Worst case (session died in flight) the wakeup runs where the
	 * session was last seen — the pre-#91 behavior for a just-dropped client.
	 */
	private async handleNotifyWakeup(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(notifyWakeupPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			throw new PayloadParseError();
		}
		const payload = payloadResult.value;
		this.logger.info("[relay] Notify wakeup received", {
			threadId: payload.thread_id,
			sourceSiteId: entry.source_site_id,
		});
		deliverNotificationWakeup(this.db, this.eventBus, {
			thread_id: payload.thread_id,
			payload: payload.payload,
			idempotency_key: entry.idempotency_key ?? payload.idempotency_key,
		});
		return null;
	}

	/**
	 * Cross-host client-tool relay consumer (R-UD5/R-UD8/R-UD12).
	 *
	 * Runs on the SESSION host — the node holding the thread's live WS
	 * (boundless) connection. The producer loop on a different node relayed a
	 * `client_tool` request here because IT could not reach the client. We:
	 *   1. Verify a live LOCAL WS connection actually has this tool. If not, the
	 *      session moved/dropped between the producer's resolve and our receipt —
	 *      relay back a retriable `error` with `definitely_not_executed: true`
	 *      so the producer can re-resolve/retry safely (never ran here).
	 *   2. Enqueue the call into the LOCAL WS dispatch via the SAME machinery the
	 *      local path uses (`enqueueClientToolCall` + `client_tool_call:created`),
	 *      so `websocket.ts` pushes the `tool:call` frame to the connected client.
	 *      The enqueue is idempotent-safe under re-drive (a duplicated relay just
	 *      re-emits; the WS layer dedups on call_id).
	 *   3. Await the client's `tool_result` (the WS `handleToolResult` persists a
	 *      `messages` row with `role='tool_result'` and `tool_name=call_id`, then
	 *      calls `enqueueToolResult`). We watch for that row, then relay a
	 *      `client_result` (ClientResultPayload) back to the producer.
	 *   4. On timeout / session drop mid-call, relay a retriable `error` (AC.7b).
	 *
	 * Returns `null` — the handler writes its own response(s) directly (like
	 * `handleInference`), so processEntry must not wrap the return as a `result`.
	 */
	private async handleClientTool(entry: RelayInboxEntry): Promise<null> {
		const payloadResult = parseJsonSafe(clientToolPayloadSchema, entry.payload, entry.kind);
		if (!payloadResult.ok) {
			this.logger.error("Invalid relay payload", {
				kind: entry.kind,
				error: payloadResult.error,
				entryId: entry.id,
			});
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: `Invalid payload: ${payloadResult.error}`, retriable: false }),
			);
			throw new PayloadParseError();
		}
		const payload = payloadResult.value as ClientToolPayload;

		// Step 1: confirm a live LOCAL WS connection holds this tool. The producer
		// resolved us from the synced `client_sessions` table, which can lag a
		// session move/drop; the authoritative check is the in-memory registry.
		const connectionId = this.wsRegistry?.getConnectionForTool(
			payload.thread_id,
			payload.tool_name,
		);
		if (!connectionId) {
			this.logger.warn("[relay] client_tool: no live local WS session for thread/tool", {
				threadId: payload.thread_id,
				tool: payload.tool_name,
				entryId: entry.id,
			});
			this.relayClientError(entry, "No live client session on this host for the requested tool", {
				retriable: true,
				definitely_not_executed: true,
			});
			return null;
		}

		// Step 2: enqueue into the LOCAL WS dispatch + emit the creation event so
		// websocket.ts pushes the `tool:call` frame to the connected client. Reuse
		// the exact machinery the local (same-host) deferred path uses. Idempotent
		// under re-drive: a duplicated relay re-enqueues, and the WS handler dedups
		// the result on call_id (AC.7c) while enqueueToolResult is idempotent on
		// (thread_id, call_id).
		let dispatchEntryId: string;
		try {
			dispatchEntryId = enqueueClientToolCall(
				this.db,
				payload.thread_id,
				{
					call_id: payload.call_id,
					tool_name: payload.tool_name,
					arguments: payload.args,
				},
				connectionId,
			);
		} catch (error) {
			this.logger.error("[relay] client_tool: enqueue failed", {
				threadId: payload.thread_id,
				callId: payload.call_id,
				error: error instanceof Error ? error.message : String(error),
			});
			this.relayClientError(entry, `Failed to enqueue client tool: ${String(error)}`, {
				retriable: true,
				definitely_not_executed: true,
			});
			return null;
		}

		this.eventBus.emit("client_tool_call:created", {
			threadId: payload.thread_id,
			callId: payload.call_id,
			entryId: dispatchEntryId,
			toolName: payload.tool_name,
			arguments: payload.args,
			// Forward the W3C trace carrier (a {header: value} record) the producer
			// injected into the relay entry, so the WS `tool:call` frame stays on
			// the same trace. Parsed defensively — a missing/garbled carrier just
			// means no parent linkage, never a dropped tool call.
			traceContext: parseTraceCarrier(entry.trace_context),
		});

		// Step 3: await the client's tool_result (persisted by WS handleToolResult
		// as a messages row with role='tool_result' and tool_name=call_id), then
		// relay a client_result back. Run async so the processor tick is not
		// blocked; we mark the inbox entry processed up front (the dispatch row is
		// the durable handoff to the WS layer) so a re-driven client_tool re-emits
		// cleanly rather than wedging here.
		const timeoutMs = payload.timeout_ms > 0 ? payload.timeout_ms : 30_000;
		this.awaitClientResult(entry, payload, timeoutMs).catch((err) => {
			this.logger.error("[relay] client_tool: awaitClientResult failed", {
				threadId: payload.thread_id,
				callId: payload.call_id,
				error: err instanceof Error ? err.message : String(err),
			});
		});
		return null;
	}

	/**
	 * Read the persisted client `tool_result` content for a call, or null when
	 * none exists yet. The WS layer persists it with role='tool_result' and
	 * tool_name=call_id (host-parity with the native dispatch return).
	 */
	private readClientToolResult(
		threadId: string,
		callId: string,
	): { content: string; isError: boolean } | null {
		const row = this.db
			.query(
				`SELECT content, exit_code FROM messages
				 WHERE thread_id = ? AND role = 'tool_result' AND tool_name = ? AND deleted = 0
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(threadId, callId) as { content: string; exit_code: number | null } | null;
		if (!row) return null;
		return { content: row.content, isError: (row.exit_code ?? 0) !== 0 };
	}

	/**
	 * Wait (event-driven, with a polling backstop and a hard timeout) for the
	 * client's tool_result, then relay a `client_result` back to the producer.
	 * On timeout — including a session dropped mid-call — relay a retriable
	 * `error` (AC.7b) so the producer's relay-wait sees a transient failure.
	 */
	private async awaitClientResult(
		entry: RelayInboxEntry,
		payload: ClientToolPayload,
		timeoutMs: number,
	): Promise<void> {
		// Fast path: a re-driven client_tool whose result already landed (AC.7c).
		const existing = this.readClientToolResult(payload.thread_id, payload.call_id);
		if (existing) {
			this.relayClientResult(entry, payload.call_id, existing.content, existing.isError);
			return;
		}

		const result = await new Promise<{ content: string; isError: boolean } | null>((resolve) => {
			let settled = false;
			const finish = (value: { content: string; isError: boolean } | null): void => {
				if (settled) return;
				settled = true;
				this.eventBus.off("message:created", onMessage);
				clearInterval(poll);
				clearTimeout(timer);
				resolve(value);
			};
			const check = (): void => {
				const found = this.readClientToolResult(payload.thread_id, payload.call_id);
				if (found) finish(found);
			};
			const onMessage = (data: { thread_id: string }): void => {
				if (data.thread_id === payload.thread_id) check();
			};
			this.eventBus.on("message:created", onMessage);
			// Polling backstop: covers the case where the WS handler persists the
			// row without an observable event reaching this listener (and any race
			// between the on() registration and the emit).
			const poll = setInterval(check, 200);
			const timer = setTimeout(() => finish(null), timeoutMs);
			// Immediate re-check after wiring listeners (closes the registration
			// race above before the first poll tick).
			check();
		});

		if (result) {
			// The WS handler enqueues a local tool-result wake for ordinary agent
			// continuation. This relay consumer owns continuation upstream, so close
			// that wake here or the session host starts a detached second loop.
			acknowledgeToolResultForCall(this.db, payload.thread_id, payload.call_id);
			this.relayClientResult(entry, payload.call_id, result.content, result.isError);
		} else {
			this.logger.warn("[relay] client_tool: timed out waiting for client result", {
				threadId: payload.thread_id,
				callId: payload.call_id,
				timeoutMs,
			});
			this.relayClientError(entry, "Timed out waiting for client tool result", {
				retriable: true,
			});
		}
	}

	/** Relay a `client_result` response back to the producer that sent `entry`. */
	private relayClientResult(
		entry: RelayInboxEntry,
		callId: string,
		content: string,
		isError: boolean,
	): void {
		const targetSiteId = entry.source_site_id;
		if (!targetSiteId) {
			this.logger.warn("[relay] client_result: request entry has no source_site_id", {
				entryId: entry.id,
			});
			return;
		}
		const resultPayload: ClientResultPayload = { call_id: callId, content, is_error: isError };
		// 4D-D: client_result rides the same response transport. Key `response:<reqId>`.
		const routed = routeRelayResponse(this.db, {
			targetSiteId,
			sourceSiteId: this.siteId,
			kind: "client_result",
			refId: entry.id,
			idempotencyKey: `response:${entry.id}`,
			streamId: entry.stream_id ?? undefined,
			payload: JSON.stringify(resultPayload),
			timeoutMs: 5 * 60 * 1000,
			traceContext: serializeRelayTraceCarrier(injectTraceContext()) ?? undefined,
			topologyRole: this.appCtx ? resolveTopologyRole(this.appCtx.optionalConfig) : undefined,
		});
		if (routed.path === "error") {
			throw new RelayResponseRoutingError(routed.targetSiteId, routed.reason);
		}
	}

	/** Relay an `error` response back to the producer that sent a `client_tool`. */
	private relayClientError(
		entry: RelayInboxEntry,
		message: string,
		opts: { retriable: boolean; definitely_not_executed?: boolean },
	): void {
		const errorPayload: ErrorPayload = {
			error: message,
			retriable: opts.retriable,
			...(opts.definitely_not_executed !== undefined
				? { definitely_not_executed: opts.definitely_not_executed }
				: {}),
		};
		this.writeResponse(entry, "error", JSON.stringify(errorPayload));
	}

	private async executeToolCall(payload: ToolCallPayload): Promise<string> {
		// Under the subcommand dispatch model:
		// payload.tool = server name (e.g., "github")
		// payload.args = { subcommand: "create_issue", ...toolArgs }
		// The subcommand is dispatched to the appropriate MCP server.

		const serverName = payload.tool;
		this.logger.info("[relay] Tool call executing", {
			server: serverName,
			subcommand: payload.args.subcommand,
		});
		const client = this.mcpClients.get(serverName);
		if (!client) {
			throw new Error(`MCP server not found: ${serverName}`);
		}

		// Extract subcommand from args
		const subcommand = payload.args.subcommand;
		const hasHelp = payload.args.help !== undefined;

		// Help request — answer it here, on the host where the server actually
		// lives, from a live listTools. Renders via the shared formatMcpHelp so
		// `<server> --help` and `<server> <sub> --help` look byte-identical to the
		// local dispatch path regardless of which host executes (host-parity).
		// Triggers: missing/empty subcommand, subcommand="help", or a --help flag.
		const isHelpRequest =
			typeof subcommand !== "string" ||
			subcommand.trim().length === 0 ||
			subcommand === "help" ||
			hasHelp;
		if (isHelpRequest) {
			const helpTarget =
				hasHelp &&
				typeof subcommand === "string" &&
				subcommand.trim().length > 0 &&
				subcommand !== "help"
					? subcommand
					: undefined;
			let tools: Tool[] = [];
			try {
				tools = await client.listTools();
			} catch (error) {
				this.logger.debug("[relay] listTools failed for help request", {
					server: serverName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			const help = formatMcpHelp(serverName, tools, helpTarget);
			const helpResult: ResultPayload = {
				stdout: help.stdout,
				stderr: help.stderr,
				exit_code: help.exitCode,
				execution_ms: 0,
			};
			return JSON.stringify(helpResult);
		}

		if (typeof subcommand !== "string" || subcommand.trim().length === 0) {
			throw new Error(`Missing or invalid subcommand in args for server: ${serverName}`);
		}

		// A relay request is untrusted input. Resolve it through the same filtered
		// registry as local MCP dispatch; never forward an unadvertised subcommand.
		const tools = await client.listTools();
		const dispatchTable = buildMCPDispatchRegistry(
			tools,
			client.getConfig(),
			this.mcpConfirmGates.get(serverName) ?? [],
		);
		const entry = dispatchTable.get(subcommand);
		if (!entry) throw new Error(`Unknown subcommand: ${subcommand}`);
		// Relay calls are autonomous: there is no human at this host to confirm one.
		if (entry.isConfirmed) {
			throw new Error(
				`Subcommand ${subcommand} requires confirmation and cannot be used in autonomous mode`,
			);
		}
		const { subcommand: _, ...toolArgs } = payload.args;
		const inputSchema = entry.tool.inputSchema;
		const coercedArgs = coerceArgsFromSchema(toolArgs, inputSchema);
		const result = await client.callTool(subcommand, coercedArgs);
		const resultPayload: ResultPayload = {
			stdout: result.content,
			// Mirror the local dispatch path: a failed call echoes the tool's
			// parameter summary so the calling host's model can self-correct
			// instead of blind-mutating args across retries.
			stderr: result.isError ? result.content + formatToolParamHint(subcommand, inputSchema) : "",
			exit_code: result.isError ? 1 : 0,
			execution_ms: 0,
		};
		return JSON.stringify(resultPayload);
	}

	private async executePlatformRequest(payload: PlatformRequestPayload): Promise<string> {
		if (!this.platformMcpRegistry) {
			throw new Error("Platform MCP registry not available on this host");
		}
		const client = this.platformMcpRegistry.getClient(payload.server_name);
		if (!client) {
			throw new Error(`Platform server '${payload.server_name}' not found on this host`);
		}

		// MCP SDK client.request() requires a Zod schema as second arg for response
		// validation. Use a permissive passthrough schema to accept any response shape.
		// Must be a real Zod v4 schema (has ._zod) so the SDK's isZ4Schema check passes.
		const { z } = await import("zod");
		const result = await client.request(
			{ method: payload.method, params: payload.params },
			z.object({}).passthrough(),
		);
		const resultPayload: ResultPayload = {
			stdout: JSON.stringify(result),
			stderr: "",
			exit_code: 0,
			execution_ms: 0,
		};
		return JSON.stringify(resultPayload);
	}

	private async executeResourceRead(payload: ResourceReadPayload): Promise<string> {
		// Try to find a client that can read this resource
		// Iterate through clients and try readResource
		let lastError: Error | null = null;
		for (const client of this.mcpClients.values()) {
			try {
				const resource = await client.readResource(payload.resource_uri);
				const resultPayload: ResultPayload = {
					stdout: resource.content,
					stderr: "",
					exit_code: 0,
					execution_ms: 0,
				};
				return JSON.stringify(resultPayload);
			} catch (error) {
				lastError = error as Error;
			}
		}

		throw lastError || new Error(`Could not read resource: ${payload.resource_uri}`);
	}

	private async executePromptInvoke(payload: PromptInvokePayload): Promise<string> {
		// Prompt names typically include server prefix (e.g., "server-name:prompt-name")
		// Try each client
		let lastError: Error | null = null;
		for (const client of this.mcpClients.values()) {
			try {
				const result = await client.invokePrompt(
					payload.prompt_name,
					payload.prompt_args as Record<string, string>,
				);
				const resultPayload: ResultPayload = {
					stdout: result.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
					stderr: "",
					exit_code: 0,
					execution_ms: 0,
				};
				return JSON.stringify(resultPayload);
			} catch (error) {
				lastError = error as Error;
			}
		}

		throw lastError || new Error(`Could not invoke prompt: ${payload.prompt_name}`);
	}

	private async executeCacheWarm(_entry: RelayInboxEntry | RelayOutboxEntry): Promise<string> {
		// Prompt-cache warming is performed by local cache_warm_poke notification turns.
		// This legacy relay request deliberately ignores payload data: a relay peer
		// must never turn it into a host filesystem read.
		const resultPayload: ResultPayload = {
			stdout: "cache_warm acknowledged",
			stderr: "",
			exit_code: 0,
			execution_ms: 0,
		};
		return JSON.stringify(resultPayload);
	}

	private writeResponse(
		requestEntry: RelayInboxEntry | RelayOutboxEntry,
		kind: "result" | "error",
		payload: string,
	): void {
		const targetSiteId = requestEntry.source_site_id;
		if (!targetSiteId) {
			throw new Error("Request entry has no source_site_id");
		}
		// 4D-D: responses ride the same RPC transport as requests. routeRelayResponse
		// flips to the durable spool when the toggle is on AND every hop to the
		// requester advertises capability; otherwise legacy relay_outbox, byte-
		// identical to before. The durable dedup key is `response:<requestId>` — one
		// request yields exactly one response outcome (result XOR error), so a
		// redelivered transfer of the SAME row is fenced by (kind, idempotency_key).
		const routed = routeRelayResponse(this.db, {
			targetSiteId,
			sourceSiteId: this.siteId,
			kind,
			refId: requestEntry.id,
			idempotencyKey: `response:${requestEntry.id}`,
			streamId: requestEntry.stream_id ?? undefined,
			payload,
			timeoutMs: 5 * 60 * 1000,
			traceContext:
				serializeRelayTraceCarrier(parseTraceCarrier(requestEntry.trace_context)) ?? undefined,
			topologyRole: this.appCtx ? resolveTopologyRole(this.appCtx.optionalConfig) : undefined,
		});
		if (routed.path === "error") {
			throw new RelayResponseRoutingError(routed.targetSiteId, routed.reason);
		}
	}

	private writeStreamChunk(
		requestEntry: RelayInboxEntry,
		kind: "stream_chunk" | "stream_end",
		streamId: string,
		seq: number,
		chunks: StreamChunk[],
	): void {
		if (!requestEntry.source_site_id) return;
		const chunkPayload: StreamChunkPayload = { chunks, seq };
		// 4D-D: chunk rows are seq-scoped (stream:<streamId>:<seq>) so distinct seqs
		// coexist while a redelivered chunk transfer dedupes on the fence. Chunk rows
		// are kind-scoped short-TTL (5min registry class); the consumer
		// (relay-stream$) folds the durable union into its seq-dedup loop.
		const routed = routeRelayResponse(this.db, {
			targetSiteId: requestEntry.source_site_id,
			sourceSiteId: this.siteId,
			kind,
			refId: requestEntry.id,
			idempotencyKey: `stream:${streamId}:${seq}`,
			streamId,
			payload: JSON.stringify(chunkPayload),
			timeoutMs: 10 * 60 * 1000, // 10 min expiry for chunks
			traceContext:
				serializeRelayTraceCarrier(parseTraceCarrier(requestEntry.trace_context)) ?? undefined,
			topologyRole: this.appCtx ? resolveTopologyRole(this.appCtx.optionalConfig) : undefined,
		});
		if (routed.path === "error") {
			throw new RelayResponseRoutingError(routed.targetSiteId, routed.reason);
		}
	}

	private pruneIdempotencyCache(): void {
		const now = Date.now();
		for (const [key, value] of this.idempotencyCache) {
			if (value.expiresAt <= now) {
				this.idempotencyCache.delete(key);
			}
		}
	}

	/**
	 * Look up which host runs a given platform connector by querying the synced
	 * hosts.platforms column. Returns the site_id or null if no host advertises
	 * that platform. This is the single source of truth for cross-host platform
	 * routing — all intake, process, and deliver paths call this instead of
	 * checking the in-process connector registry.
	 */
	private findPlatformHost(platform: string): string | null {
		try {
			const rows = this.db
				.query<{ site_id: string; platforms: string }, []>(
					"SELECT site_id, platforms FROM hosts WHERE deleted = 0 AND platforms IS NOT NULL",
				)
				.all();
			for (const row of rows) {
				try {
					const platforms = JSON.parse(row.platforms) as string[];
					if (Array.isArray(platforms) && platforms.includes(platform)) {
						return row.site_id;
					}
				} catch {
					// Corrupted JSON — skip this host
				}
			}
		} catch {
			// Table missing or other DB error — fall through
		}
		return null;
	}

	/**
	 * Select the best host to process an intake message.
	 * Tiers (in order): platform affinity → thread affinity → model match → tool match → least-loaded fallback.
	 */
	private selectIntakeHost(threadId: string, platform?: string): string | null {
		// Tier 0: Platform affinity — if the intake specifies a platform, route to
		// the host that advertises it so platform tools are available locally.
		if (platform) {
			const platformHost = this.findPlatformHost(platform);
			if (platformHost) return platformHost;
		}

		// Tier 1: Thread affinity — use host that most recently processed this thread
		const affinityHost = this.threadAffinityMap.get(threadId);
		if (affinityHost) {
			try {
				const alive = this.db
					.query<{ site_id: string }, [string]>(
						"SELECT site_id FROM hosts WHERE site_id = ? AND deleted = 0",
					)
					.get(affinityHost);
				if (alive) return alive.site_id;
			} catch {
				// Table missing or other error — fall through
			}
			// Affinity host gone — fall through
		}

		// Tier 2: Model match — use threads.model_hint (authoritative model preference)
		try {
			const threadHint = this.db
				.query<{ model_hint: string | null }, [string]>(
					"SELECT model_hint FROM threads WHERE id = ?",
				)
				.get(threadId);

			if (threadHint?.model_hint) {
				const hosts = this.db
					.query<{ site_id: string; models: string }, []>(
						"SELECT site_id, models FROM hosts WHERE deleted = 0 AND models IS NOT NULL",
					)
					.all();
				for (const host of hosts) {
					const modelsResult = parseJsonSafe(hostModelsSchema, host.models, "Tier 2 models");
					if (!modelsResult.ok) {
						this.logger.warn(
							`selectIntakeHost Tier 2: Skipping host ${host.site_id} with corrupted models`,
							{ error: modelsResult.error },
						);
						continue;
					}
					const models = modelsResult.value;
					// Check if any model entry matches (handle both string[] and HostModelEntry[] formats)
					const hasMatch = models.some((m) =>
						typeof m === "string" ? m === threadHint.model_hint : m.id === threadHint.model_hint,
					);
					if (hasMatch) return host.site_id;
				}
			}
		} catch {
			// turns table missing or other error — fall through
		}

		// Tier 3: Tool match — find the host with the most tools matching this thread's tool usage.
		// Uses the tool_name column on messages (populated for role='tool' result messages).
		let threadTools: string[] = [];
		try {
			threadTools = this.db
				.query<{ tool_name: string }, [string]>(
					`SELECT DISTINCT tool_name
					 FROM messages
					 WHERE thread_id = ? AND role = 'tool' AND tool_name IS NOT NULL
					 LIMIT 50`,
				)
				.all(threadId)
				.map((r) => r.tool_name);
		} catch {
			// messages table missing or other error — fall through
		}

		if (threadTools.length > 0) {
			const hosts = this.db
				.query<{ site_id: string; mcp_tools: string | null }, []>(
					"SELECT site_id, mcp_tools FROM hosts WHERE deleted = 0",
				)
				.all();

			let bestHost: string | null = null;
			let bestScore = 0;
			for (const host of hosts) {
				if (!host.mcp_tools) continue;
				const toolsResult = parseJsonSafe(hostMcpToolsSchema, host.mcp_tools, "Tier 3 mcp_tools");
				if (!toolsResult.ok) {
					this.logger.warn(
						`selectIntakeHost Tier 3: Skipping host ${host.site_id} with corrupted mcp_tools`,
						{ error: toolsResult.error },
					);
					continue;
				}
				const hostToolNames = toolsResult.value;
				const score = threadTools.filter((t) => hostToolNames.includes(t)).length;
				if (score > bestScore) {
					bestScore = score;
					bestHost = host.site_id;
				}
			}
			if (bestHost) return bestHost;
		}

		// Tier 4: fallback to the first live host. Post-N+1 there is no relay_outbox
		// to rank pending depth by, so the load-ranked JOIN is gone.
		const anyHost = this.db
			.query<{ site_id: string }, []>(
				"SELECT site_id FROM hosts WHERE deleted = 0 ORDER BY site_id ASC LIMIT 1",
			)
			.get();
		return anyHost?.site_id ?? null;
	}

	private async executeInference(
		entry: RelayInboxEntry,
		payload: InferenceRequestPayload,
	): Promise<void> {
		this.logger.info("[relay] Inference started", {
			model: payload.model,
			source: entry.source_site_id,
			streamId: entry.stream_id,
			segmentCount: payload.segments?.length ?? 0,
			hasTools: !!payload.tools?.length,
		});
		const FLUSH_INTERVAL_MS = 200;
		const FLUSH_BUFFER_BYTES = 4096;

		// Extract trace context from relay entry if present (AC5.2)
		const traceContextStr = entry.trace_context;
		let traceCarrier: Record<string, string> | null = null;
		if (traceContextStr) {
			try {
				traceCarrier = JSON.parse(traceContextStr) as Record<string, string>;
			} catch {
				this.logger?.warn("relay-processor: malformed trace_context, skipping tracing", {
					entryId: entry.id,
				});
			}
		}
		const parentContext = extractTraceContext(traceCarrier);
		let collectedSpans: SerializedSpan[] = [];

		// stream_id comes from the inbox entry (set by the requester in RELAY_STREAM)
		const streamId = entry.stream_id;
		if (!streamId) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: "Missing stream_id on inference request", retriable: false }),
			);
			return;
		}

		// Check model availability
		if (!this.modelRouter) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({ error: "No model router configured on this host", retriable: false }),
			);
			return;
		}

		const backend = this.modelRouter.tryGetBackend(payload.model);
		if (!backend) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({
					error: `Model not available on this host: ${payload.model}`,
					retriable: false,
				}),
			);
			return;
		}

		// Resolve the delegated context from segments (R-UD2 / R-UD10). The
		// consumer NEVER re-assembles: it resolves inline segments verbatim and
		// rebuilds each range segment byte-for-byte from its OWN confirmed-synced
		// message rows via the same Stage-1 finder + annotator the producer used.
		// `resolveSegments` has no access to assembleContext / an AssemblyAuthority
		// — consumer re-assembly is structurally unrepresentable. A range that
		// points past available rows throws (cannot happen by construction since
		// the producer gates on last_confirmed, R-UD6).
		let messages: ReturnType<typeof resolveSegments>;
		try {
			messages = resolveSegments(payload.segments, this.db, payload.nowMs);
		} catch (err) {
			this.writeResponse(
				entry,
				"error",
				JSON.stringify({
					error: `Failed to resolve context segments: ${err instanceof Error ? err.message : String(err)}`,
					// Retriable: a range row may simply not have synced yet on this
					// consumer. By construction (last_confirmed gate) this should not
					// happen, but if it does, a retry after sync converges can succeed.
					retriable: true,
				}),
			);
			return;
		}

		// Defense-in-depth: strip `{role:"cache"}` markers if the local backend
		// can't cache. Requesters gate placement on the remote host's advertised
		// capabilities, but stale hosts-table data or pre-fix requester binaries
		// can still send markers to a non-caching backend. Without this strip,
		// those markers reach AWS as providerOptions.bedrock.cachePoint and
		// trigger 403 "unsupported model or your request did not allow prompt
		// caching." See docs/design/sync-protocol.md for the capability flow.
		const backendCaps = this.modelRouter.getEffectiveCapabilities(payload.model) ?? undefined;
		messages = stripCacheMarkersIfUnsupported(messages, backendCaps);

		// AC4.3: Record relay cycle for inference request receipt
		try {
			recordRelayCycle(this.db, {
				direction: "inbound",
				peer_site_id: entry.source_site_id,
				kind: "inference",
				delivery_method: "sync",
				latency_ms: null, // not known yet at request start
				expired: false,
				success: true,
			});
		} catch (error) {
			this.logger.warn("Failed to record relay metrics", {
				kind: "inference",
				direction: "inbound",
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// Set up AbortController for cancel support (AC3.4)
		const abortController = new AbortController();
		this.activeInferenceStreams.set(entry.id, abortController);

		let seq = 0;
		let chunkBuffer: StreamChunk[] = [];
		let bufferBytes = 0;
		let lastFlushTime = Date.now();
		const inferenceStartTime = Date.now();
		const heartbeatTimer = setInterval(() => {
			// Empty sequenced payload: proves the relay consumer and backend call are
			// alive without fabricating a model chunk. The requester consumes it as
			// first/in-flight activity and emits nothing to the agent loop.
			this.writeStreamChunk(entry, "stream_chunk", streamId, seq++, []);
		}, 1_000);

		const flush = (isFinal: boolean): void => {
			if (chunkBuffer.length === 0 && !isFinal) return;
			const kind = isFinal ? "stream_end" : "stream_chunk";
			this.logger.info("[relay] Inference flush", {
				kind,
				seq,
				chunks: chunkBuffer.length,
				bytes: bufferBytes,
				streamId,
				elapsedMs: Date.now() - inferenceStartTime,
			});
			this.writeStreamChunk(entry, kind, streamId, seq, [...chunkBuffer]);
			// Record relay cycle for each flush
			try {
				recordRelayCycle(this.db, {
					direction: "inbound",
					peer_site_id: entry.source_site_id,
					kind,
					delivery_method: "sync",
					latency_ms: Date.now() - inferenceStartTime,
					expired: false,
					success: true,
				});
			} catch (error) {
				this.logger.warn("Failed to record relay metrics", {
					kind,
					direction: "inbound",
					error: error instanceof Error ? error.message : String(error),
				});
			}
			seq++;
			chunkBuffer = [];
			bufferBytes = 0;
			lastFlushTime = Date.now();
		};

		// Set up scoped trace collector if trace context is present (AC5.2, AC5.3)
		const runInferenceWithTracing = async (): Promise<void> => {
			// Do not pass payload.model to chat() — it's a logical ID (e.g., "opus")
			// that the model router already resolved to this backend. The backend has
			// its own configured model identifier (e.g., the full Bedrock ARN).
			// Passing the alias would override the ARN and cause Bedrock to reject it.
			// Fall back to the local model router's thinking / effort config when
			// the requester doesn't include them in the payload — the remote host
			// knows its own backend capabilities better than a distant caller.
			if (!this.modelRouter) {
				throw new Error("Model router is not available");
			}
			const effectiveThinking =
				payload.thinking ?? this.modelRouter.getThinkingConfig(payload.model);
			const effectiveEffort = payload.effort ?? this.modelRouter.getEffort(payload.model);
			// Defense-in-depth: clamp the requester's max_tokens to this host's
			// per-backend cap. Without this, a stale requester binary (or a hub
			// routing decision made against stale peer capabilities) can send an
			// invalid ceiling. When both values are absent, the helper supplies the
			// same conservative 8k fallback reserved by context assembly — never a
			// provider-defined model maximum.
			const localMaxOutputTokens = this.modelRouter.getMaxOutputTokens(payload.model);
			const effectiveMaxTokens = clampMaxOutputTokens(payload.max_tokens, localMaxOutputTokens);
			const chatStream = backend.chat({
				messages,
				tools: payload.tools,
				system: payload.system,
				max_tokens: effectiveMaxTokens,
				temperature: payload.temperature,
				top_p: payload.top_p,
				tool_choice: payload.tool_choice,
				thinking: effectiveThinking,
				effort: effectiveEffort,
				cache_ttl: payload.cache_ttl ?? this.modelRouter.getCacheTtl(payload.model),
				resolveFileRef: createFileRefResolver(this.db),
				signal: abortController.signal,
			});

			for await (const chunk of chatStream) {
				// AC3.4: Check abort signal (cancel from requester)
				if (abortController.signal.aborted) break;

				// Stamp authoritative cost on the done chunk before it leaves
				// the hub. The spoke that initiated this delegated turn will
				// often be hub-only mode (empty model_backends.backends) and
				// its local calculateTurnCost would return 0 — we hold the
				// real pricing config, so we compute it here. Mirrors the
				// per-backend hand-off pattern used for cache_ttl/thinking/
				// effort/max_tokens (CONTRIBUTING.md invariant #17).
				let outChunk: StreamChunk = chunk;
				if (chunk.type === "done") {
					const backends = this.appCtx?.config.modelBackends.backends ?? [];
					const cost_usd = calculateTurnCost(
						payload.model,
						{
							inputTokens: chunk.usage.input_tokens,
							outputTokens: chunk.usage.output_tokens,
							cacheReadTokens: chunk.usage.cache_read_tokens,
							cacheWriteTokens: chunk.usage.cache_write_tokens,
						},
						backends,
					);
					outChunk = { ...chunk, cost_usd };
				}

				chunkBuffer.push(outChunk);
				const chunkBytes = new TextEncoder().encode(JSON.stringify(outChunk)).byteLength;
				bufferBytes += chunkBytes;

				const elapsed = Date.now() - lastFlushTime;
				if (elapsed >= FLUSH_INTERVAL_MS || bufferBytes >= FLUSH_BUFFER_BYTES) {
					flush(false);
				}
			}

			if (abortController.signal.aborted) {
				// AC3.4: Write error response indicating cancellation
				this.writeResponse(
					entry,
					"error",
					JSON.stringify({ error: "cancelled by requester", retriable: false }),
				);
			} else {
				// Normal completion — final flush as stream_end (AC3.3)
				flush(true);
			}
		};

		try {
			if (traceCarrier) {
				// Create scoped collector for hub-side tracing (AC5.2, AC5.3).
				// Stamp the executing hub's site ID on every span (issue #152) so the
				// re-exported delegated-inference spans arrive on the requesting spoke
				// tagged with the site that actually ran the loop.
				const collector = createScopedTraceCollector(this.appCtx?.siteId);
				const tracer = collector.getTracer("bound.relay-hub");

				await context.with(parentContext, async () => {
					const span = tracer.startSpan("relay.hub-inference");
					await context.with(trace.setSpan(context.active(), span), async () => {
						const providerSpan = tracer.startSpan("llm.provider.request", {
							attributes: { "llm.model": payload.model },
						});
						try {
							await context.with(trace.setSpan(context.active(), providerSpan), () =>
								runInferenceWithTracing(),
							);
							providerSpan.setStatus({ code: SpanStatusCode.OK });
							span.setStatus({ code: SpanStatusCode.OK });
						} catch (inferenceErr) {
							const error =
								inferenceErr instanceof Error ? inferenceErr : new Error(String(inferenceErr));
							providerSpan.recordException(error);
							providerSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
							span.recordException(error);
							span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
							throw inferenceErr;
						} finally {
							providerSpan.end();
							span.end();
						}
					});
				});

				collectedSpans = await collector.flush();
			} else {
				await runInferenceWithTracing();
			}
		} catch (err) {
			this.logger.error("[relay] Inference failed", {
				model: payload.model,
				source: entry.source_site_id,
				streamId: entry.stream_id,
				elapsedMs: Date.now() - inferenceStartTime,
				error: err instanceof Error ? err.message : String(err),
				statusCode: err instanceof LLMError ? err.statusCode : undefined,
			});
			this.writeResponse(entry, "error", JSON.stringify({ error: String(err), retriable: true }));
			try {
				recordRelayCycle(this.db, {
					direction: "inbound",
					peer_site_id: entry.source_site_id,
					kind: "inference",
					delivery_method: "sync",
					latency_ms: Date.now() - inferenceStartTime,
					expired: false,
					success: false,
				});
			} catch (error) {
				this.logger.warn("Failed to record relay metrics", {
					kind: "inference",
					direction: "inbound",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			clearInterval(heartbeatTimer);
			this.activeInferenceStreams.delete(entry.id);
			// Write trace_data response if spans were collected (AC5.3)
			if (collectedSpans.length > 0) {
				if (entry.source_site_id) {
					// 4D-D: trace_data rides the same response transport. Key `response:<reqId>`
					// — one trace_data per request, redelivered transfer fenced.
					routeRelayResponse(this.db, {
						targetSiteId: entry.source_site_id,
						sourceSiteId: this.siteId,
						kind: "trace_data",
						refId: entry.id,
						idempotencyKey: `response:${entry.id}`,
						streamId: entry.stream_id ?? undefined,
						payload: JSON.stringify(collectedSpans),
						timeoutMs: 5 * 60 * 1000,
						traceContext:
							serializeRelayTraceCarrier(parseTraceCarrier(entry.trace_context)) ?? undefined,
						topologyRole: this.appCtx ? resolveTopologyRole(this.appCtx.optionalConfig) : undefined,
					});
				}
			}
		}
	}

	/**
	 * Run an agent loop LOCALLY for an intake-routed thread (R-UD1). This is the
	 * platform-intake leg of the single delegation path: the host the intake
	 * selector chose (the platform-connector host as an optimization, R-UD12)
	 * runs the whole loop here, against its OWN authoritative state. It assembles
	 * locally (so it can never re-assemble from an un-synced replica — the old
	 * `process` bug class) and relays only the inference outward.
	 *
	 * Unlike the deleted `process` consumer, there is no waiting cross-host
	 * requester: platform intake is fire-and-forget, so there is no
	 * status_forward / result relayed back. The loop's own output (assistant
	 * messages, platform tool calls) is the observable effect.
	 */
	private async runLocalThreadLoop(req: {
		threadId: string;
		messageId: string;
		userId: string;
		platform: string | null;
	}): Promise<void> {
		if (!this.modelRouter) {
			this.logger.error("[relay] Local intake loop: no model router configured", {
				threadId: req.threadId,
			});
			return;
		}

		const thread = this.db
			.query("SELECT id FROM threads WHERE id = ? AND deleted = 0")
			.get(req.threadId) as { id: string } | null;
		if (!thread) {
			this.logger.error("[relay] Local intake loop: thread not found", {
				threadId: req.threadId,
			});
			return;
		}

		if (!this.appCtx) {
			this.logger.error("[relay] Local intake loop: AppContext not available", {
				threadId: req.threadId,
			});
			return;
		}
		const localCtx = this.appCtx;

		// Thread executor serializes concurrent intakes for the same thread
		// (prevents N concurrent inferences when N rapid platform messages
		// arrive). Mirrors the prior executeProcess concurrency control.
		if (this.threadExecutor) {
			enqueueMessage(this.db, req.messageId, req.threadId);
			await this.threadExecutor.execute(
				req.threadId,
				async (shouldYield) => {
					const claimed = claimPending(this.db, req.threadId, this.siteId);
					if (claimed.length === 0) return {};
					const claimedIds = claimed.map((e) => e.message_id);
					try {
						const result = await this.runLocalLoop(req, localCtx, shouldYield);
						if (result.yielded) return { yielded: true };
						acknowledgeBatch(this.db, claimed);
						return result;
					} catch (error) {
						try {
							acknowledgeBatch(this.db, claimed);
						} catch (ackError) {
							this.logger.warn("Failed to acknowledge batch after error", {
								claimedIds: claimedIds.length,
								error: ackError instanceof Error ? ackError.message : String(ackError),
							});
						}
						throw error;
					}
				},
				async () => {},
			);
			return;
		}

		// Fallback: no executor (tests / standalone relay).
		await this.runLocalLoop(req, localCtx);
	}

	/**
	 * Run a single local agent loop for an intake-routed thread. The loop reads
	 * the thread's authoritative state from the local DB and assembles its own
	 * context — never re-assembling from a relay payload (R-UD1/R-UD2).
	 */
	private async runLocalLoop(
		req: { threadId: string; messageId: string; userId: string; platform: string | null },
		localCtx: AppContext,
		shouldYield?: () => boolean,
	): Promise<Record<string, unknown>> {
		const entryId = req.messageId;
		// Resolve thread's preferred model from the authoritative threads.model_hint column.
		let threadModelId: string | undefined;
		const threadRow = this.db
			.query("SELECT model_hint FROM threads WHERE id = ?")
			.get(req.threadId) as { model_hint: string | null } | null;
		if (threadRow?.model_hint) {
			threadModelId = threadRow.model_hint;
		}

		// Resolve task-level settings (type, no_history, system_prompt_addition) from the owning task, if any.
		const owningTask = this.db
			.query(
				"SELECT id, type, no_history, system_prompt_addition FROM tasks WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
			)
			.get(req.threadId) as {
			id: string;
			type: string;
			no_history: number;
			system_prompt_addition: string | null;
		} | null;

		const loopConfig: AgentLoopConfig = {
			threadId: req.threadId,
			userId: req.userId,
			taskId: owningTask?.id ?? `intake-${entryId}`,
			// Surface-gating for volatile rendering (#70): a delegated heartbeat
			// keeps its resolved-advisory operator-acks; all other surfaces strip
			// them. Undefined when no owning task row resolves.
			taskType: owningTask?.type,
			modelId: threadModelId,
			noHistory: owningTask?.no_history === 1,
			systemPromptAddition: owningTask?.system_prompt_addition ?? undefined,
			shouldYield,
		};

		if (req.platform) {
			loopConfig.platform = req.platform;
		}

		// Inject platform tools if registry is available
		if (this.platformMcpRegistry) {
			const platformToolsMap = this.platformMcpRegistry.getToolsForThread(req.threadId);
			if (platformToolsMap.size > 0) {
				loopConfig.platformTools = Array.from(platformToolsMap.values());
			}
		}

		// Inject client tools when a live WS session for this thread lives on
		// THIS host (issue #91). Client tool calls defer over this host's local
		// event bus + dispatch queue, so the loop must run where the connection
		// is — which is why handleThread routed the wakeup here. Mirrors the
		// local-path resolution in start/server.ts.
		if (this.wsRegistry) {
			const clientToolsFromRegistry = this.wsRegistry.getClientToolsForThread(req.threadId);
			if (clientToolsFromRegistry && clientToolsFromRegistry.size > 0) {
				loopConfig.clientTools = clientToolsFromRegistry;
				const firstToolName = clientToolsFromRegistry.keys().next().value;
				loopConfig.connectionId = firstToolName
					? this.wsRegistry.getConnectionForTool(req.threadId, firstToolName)
					: undefined;
			}
			// A live boundless session's per-connection systemPromptAddition is
			// more current than any owning-task value; prefer it when present.
			const sessionSysPrompt = this.wsRegistry.getSystemPromptAdditionForThread(req.threadId);
			if (sessionSysPrompt !== undefined) {
				loopConfig.systemPromptAddition = sessionSysPrompt;
			}
		}

		const agentLoop = this.agentLoopFactory
			? this.agentLoopFactory(loopConfig)
			: new MainAgentLoop(
					localCtx,
					{
						/* sandbox not available — no tools in context */
					} as object,
					// biome-ignore lint/style/noNonNullAssertion: modelRouter checked before entering runLocalThreadLoop
					this.modelRouter!,
					loopConfig,
				);

		const tracer = getTracer();
		const rootSpan = tracer.startSpan("relay.run-local-thread-loop", {
			attributes: {
				"thread.id": req.threadId,
				"user.id": req.userId ?? "",
				platform: req.platform ?? "",
			},
		});

		let result: Awaited<ReturnType<typeof agentLoop.run>>;
		try {
			result = await context.with(trace.setSpan(context.active(), rootSpan), () => agentLoop.run());
			rootSpan.setStatus({ code: SpanStatusCode.OK });
		} catch (err) {
			rootSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			rootSpan.end();
		}

		return {
			yielded: result.yielded,
			error: result.error,
			messagesCreated: result.messagesCreated,
		};
	}
}
