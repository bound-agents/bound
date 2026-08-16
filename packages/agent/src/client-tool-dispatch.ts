import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	acknowledgeToolResultForCall,
	enqueueClientToolCall,
	findToolResultByThreadAndCallId,
	markProcessed,
	readInboxByRefId,
	writeOutbox,
} from "@bound/core";
import {
	type ClientToolPayload,
	type TypedEventEmitter,
	YARD_CLIENT_CALL_ID_PREFIX,
	clientResultPayloadSchema,
	errorPayloadSchema,
	parseJsonSafe,
} from "@bound/shared";
import { resolveClientSessionHost } from "./delegation";
import { createRelayOutboxEntry } from "./relay-router";

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
		const entry = readInboxByRefId(deps.db, outboxId);
		if (!entry) return undefined;
		markProcessed(deps.db, [entry.id]);
		if (entry.kind === "client_result") {
			const parsed = parseJsonSafe(clientResultPayloadSchema, entry.payload, entry.kind);
			return parsed.ok
				? { content: normalizeClientContent(parsed.value.content), isError: parsed.value.is_error }
				: { content: "Error: malformed client_result payload", isError: true };
		}
		if (entry.kind === "error") {
			const parsed = parseJsonSafe(errorPayloadSchema, entry.payload, entry.kind);
			return {
				content: `Error: ${parsed.ok ? parsed.value.error : entry.payload}`,
				isError: true,
			};
		}
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
	const outbox = createRelayOutboxEntry(
		sessionHost.site_id,
		deps.siteId,
		"client_tool",
		JSON.stringify(payload),
		deps.timeoutMs,
	);
	writeOutbox(deps.db, outbox);
	return waitForRemoteResult(deps, outbox.id);
}
