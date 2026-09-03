import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { enqueueClientToolCall, findToolResultByThreadAndCallId } from "@bound/core";
import { acknowledgeToolResultForCall } from "@bound/core";
import {
	type ClientToolPayload,
	type TypedEventEmitter,
	YARD_CLIENT_CALL_ID_PREFIX,
	clientResultPayloadSchema,
	errorPayloadSchema,
	parseJsonSafe,
} from "@bound/shared";
import { injectTraceContext } from "@bound/shared";
import { context } from "@opentelemetry/api";
import { resolveClientSessionHost } from "./delegation";
import { readUnionResponseEntry } from "./relay-await-helpers";
import { type TopologyRole, routeRelayRequest } from "./relay-router";

const POLL_MS = 100;

export interface AwaitableClientToolDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	threadId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** Local WS connection, when this process holds the thread's session. */
	connectionId?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Cluster role, for the durable-relay spoke hub-hop capability gate. */
	topologyRole?: TopologyRole;
}

export interface AwaitableClientToolResult {
	content: string;
	isError: boolean;
}

/**
 * websocket.ts persists client string output as ContentBlock[] JSON. For a
 * text-only result that wire envelope is transport detail, not the guest value:
 * flatten it back to text before resuming Yard. Preserve image/document arrays
 * serialized so Yard's JSON bridge returns structured blocks rather than
 * discarding binary references.
 */
function normalizeClientContent(content: string): string {
	try {
		const parsed = JSON.parse(content) as unknown;
		if (
			Array.isArray(parsed) &&
			parsed.every(
				(block) =>
					block !== null &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
		) {
			return parsed.map((block) => (block as { text: string }).text).join("\n");
		}
	} catch {
		// Plain text: return unchanged.
	}
	return content;
}

function waitForLocalResult(
	deps: AwaitableClientToolDeps,
	callId: string,
): Promise<AwaitableClientToolResult | null> {
	const read = (): AwaitableClientToolResult | null => {
		const row = findToolResultByThreadAndCallId(deps.db, deps.threadId, callId);
		if (!row) return null;
		return { content: normalizeClientContent(row.content), isError: (row.exit_code ?? 0) !== 0 };
	};
	const existing = read();
	if (existing) return Promise.resolve(existing);

	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: AwaitableClientToolResult | null): void => {
			if (settled) return;
			settled = true;
			deps.eventBus.off("message:created", onMessage);
			deps.signal?.removeEventListener("abort", onAbort);
			clearInterval(poll);
			clearTimeout(timer);
			resolve(value);
		};
		const check = (): void => {
			if (deps.signal?.aborted) {
				finish(null);
				return;
			}
			const found = read();
			if (found) finish(found);
		};
		const onMessage = (event: { thread_id: string }): void => {
			if (event.thread_id === deps.threadId) check();
		};
		const onAbort = (): void => finish(null);
		deps.eventBus.on("message:created", onMessage);
		deps.signal?.addEventListener("abort", onAbort, { once: true });
		const poll = setInterval(check, POLL_MS);
		const timer = setTimeout(() => finish(null), deps.timeoutMs);
		check();
	});
}

function waitForRemoteResult(
	deps: AwaitableClientToolDeps,
	outboxId: string,
): Promise<AwaitableClientToolResult | null> {
	const read = (): AwaitableClientToolResult | null | undefined => {
		// 4D-D union read: consume the winning scalar response for this request,
		// whether it landed in legacy relay_inbox (pre-drop) or the durable spool
		// (post-4E). readUnionResponseEntry claims a durable row under a fresh
		// token and defers its ack to settle(); a legacy row's markProcessed is
		// likewise deferred — so we settle() only AFTER taking delivery, matching
		// awaitPlatformRequestResponse's claim → deliver → ack ordering.
		const entry = readUnionResponseEntry(deps.db, outboxId, deps.siteId);
		if (!entry) return undefined;
		if (entry.kind === "client_result") {
			const parsed = parseJsonSafe(clientResultPayloadSchema, entry.payload, entry.kind);
			// A deterministically-unparseable payload is POISON, not a transient
			// fault: leaving it claimed would let a boot-reset return it to pending
			// and re-deliver the same garbage forever until TTL. Match the reference
			// (awaitPlatformRequestResponse settle()s then throws on a parse failure):
			// settle() to consume the row — it was delivered to its only consumer —
			// then surface a parse error immediately rather than hanging until timeout.
			if (!parsed.ok) {
				entry.settle();
				return { content: "Error: malformed client_result payload", isError: true };
			}
			entry.settle();
			return {
				content: normalizeClientContent(parsed.value.content),
				isError: parsed.value.is_error,
			};
		}
		if (entry.kind === "error") {
			const parsed = parseJsonSafe(errorPayloadSchema, entry.payload, entry.kind);
			entry.settle();
			return {
				content: `Error: ${parsed.ok ? parsed.value.error : entry.payload}`,
				isError: true,
			};
		}
		entry.settle();
		return { content: `Error: unexpected relay response kind "${entry.kind}"`, isError: true };
	};

	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: AwaitableClientToolResult | null): void => {
			if (settled) return;
			settled = true;
			deps.eventBus.off("relay:inbox", onInbox);
			deps.signal?.removeEventListener("abort", onAbort);
			clearInterval(poll);
			clearTimeout(timer);
			resolve(value);
		};
		const check = (): void => {
			if (deps.signal?.aborted) {
				finish(null);
				return;
			}
			const found = read();
			if (found !== undefined) finish(found);
		};
		const onInbox = (event: { ref_id?: string }): void => {
			if (event.ref_id === outboxId) check();
		};
		const onAbort = (): void => finish(null);
		deps.eventBus.on("relay:inbox", onInbox);
		deps.signal?.addEventListener("abort", onAbort, { once: true });
		const poll = setInterval(check, POLL_MS);
		const timer = setTimeout(() => finish(null), deps.timeoutMs);
		check();
	});
}

/**
 * Execute a client-kind tool as an awaitable operation.
 *
 * Local session: enqueue into the ordinary WS dispatch, await the result row
 * persisted by websocket.ts, then acknowledge its tool-result re-wake because
 * the caller owns continuation inline (Yard/foreground aux).
 *
 * Remote session: relay `client_tool` to the session host and await
 * `client_result`; the consumer uses the same WS dispatch. The consumer is
 * responsible for acknowledging its local result wake after relaying it.
 */
export async function dispatchAwaitableClientTool(
	deps: AwaitableClientToolDeps,
): Promise<AwaitableClientToolResult | null> {
	const callId = `${YARD_CLIENT_CALL_ID_PREFIX}${randomUUID()}`;
	if (deps.connectionId) {
		const entryId = enqueueClientToolCall(
			deps.db,
			deps.threadId,
			{ call_id: callId, tool_name: deps.toolName, arguments: deps.args },
			deps.connectionId,
		);
		deps.eventBus.emit("client_tool_call:created", {
			threadId: deps.threadId,
			callId,
			entryId,
			toolName: deps.toolName,
			arguments: deps.args,
			traceContext: null,
		});
		const result = await waitForLocalResult(deps, callId);
		acknowledgeToolResultForCall(deps.db, deps.threadId, callId);
		return result;
	}

	const sessionHost = resolveClientSessionHost(deps.db, deps.threadId, deps.siteId);
	if (!sessionHost) return null;
	const payload: ClientToolPayload = {
		thread_id: deps.threadId,
		call_id: callId,
		tool_name: deps.toolName,
		args: deps.args,
		timeout_ms: deps.timeoutMs,
	};
	const dispatchContext = context.active();
	const traceContext = context.with(dispatchContext, () => injectTraceContext());
	const routed = context.with(dispatchContext, () =>
		routeRelayRequest(deps.db, {
			targetSiteId: sessionHost.site_id,
			sourceSiteId: deps.siteId,
			kind: "client_tool",
			payload: JSON.stringify(payload),
			timeoutMs: deps.timeoutMs,
			// Legacy carried no key here; the minted row id is a deterministic,
			// redelivery-stable key (R-DW5/6).
			traceContext: traceContext ? JSON.stringify(traceContext) : undefined,
			topologyRole: deps.topologyRole,
		}),
	);
	return waitForRemoteResult(deps, routed.id);
}
