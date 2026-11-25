import type { WsStreamChunk } from "./relay-schemas.js";
import type {
	ContextDebugInfo,
	Message,
	RelayKind,
	StatusForwardPayload,
	YardExecutionEvent,
} from "./types.js";

export interface EventMap {
	"message:created": { message: Message; thread_id: string; trace_context?: string };
	/** Emitted after a local agent loop run to push the new assistant message to
	 *  WebSocket clients without re-triggering the agent loop handler. */
	"message:broadcast": { message: Message; thread_id: string };
	"task:triggered": { task_id: string; trigger: string };
	"task:completed": { task_id: string; result: string | null };
	"file:changed": { path: string; operation: "created" | "modified" | "deleted" };
	"alert:created": { message: Message; thread_id: string };
	"agent:cancel": { thread_id: string };
	"status:forward": StatusForwardPayload;
	"context:debug": { thread_id: string; turn_id: string; debug: ContextDebugInfo };
	"notify:enqueued": { thread_id: string };
	"model:fallback": {
		requested_model: string;
		fallback_model: string;
		thread_id: string;
		task_id?: string;
		reason: string;
	};
	/**
	 * A classified model refusal (slice 5, R-RT21, 2026-11-21-model-routing.md
	 * §7.4). Emitted for EVERY classified refusal, independent of HTTP error-rate
	 * monitoring, so refusal volume is observable on its own axis.
	 */
	"llm:refusal": {
		thread_id: string;
		task_id?: string;
		model: string;
		route_id: string | null;
		vendor: string;
		category: string | null;
		substitutable: boolean;
	};
	/**
	 * The outcome of a refusal-fallback walk (slice 5, R-RT21). Emitted once per
	 * substitution attempt chain: whether a substitute served the turn, which
	 * model, and whether an endpoint-bound credit was redeemed. Paired with
	 * `llm:refusal`, independent of HTTP error metrics.
	 */
	"llm:fallback": {
		thread_id: string;
		task_id?: string;
		refused_model: string;
		/** The substitute logical model that served the turn, or null when none did. */
		substitute_model: string | null;
		/** Whether an endpoint-bound fallback credit was redeemed inline. */
		credit_redeemed: boolean;
		/** Resolved policy mode that governed the walk. */
		policy_mode: "auto" | "never" | "custom";
	};
	"changelog:written": { hlc: string; tableName: string; siteId: string };
	"relay:outbox-written": { id: string; target_site_id: string };
	/** Emitted after a NEW durable_work row is committed (never on INSERT-OR-IGNORE
	 *  no-ops), so the transport can push a peer-targeted spool transfer immediately.
	 *  Mirrors relay:outbox-written for the durable-work spool (R-DW10/R-DW11). */
	"durable_work:written": { id: string; target_site_id: string };
	"relay:inbox": { ref_id?: string; stream_id?: string; kind: RelayKind };
	"client_tool_call:created": {
		threadId: string;
		callId: string;
		entryId: string;
		toolName: string;
		arguments: Record<string, unknown>;
		/**
		 * W3C trace context carrier captured at emit time on the agent-loop side.
		 * Captured at emit because event-bus listeners run outside the emitter's
		 * OTel context, so the WS handler cannot recover the active span itself.
		 * Forwarded verbatim into the `tool:call` WS frame as `trace_context`.
		 */
		traceContext?: Record<string, string> | null;
	};
	/**
	 * A nested aux loop gave up waiting on a client tool call it already
	 * expired (#278). The WS layer sends `tool:cancel` to the executing client;
	 * the aux loop has written the call's single result itself.
	 */
	"client_tool_call:cancel": {
		threadId: string;
		entryId: string;
		callId: string;
		reason: "timeout" | "aborted";
	};
	"stream:chunk": { thread_id: string; chunk: WsStreamChunk };
	/** An aux invocation created its child thread and is now executing. */
	"aux:started": { thread_id: string; parent_thread_id: string; agent_name: string };
	"aux:completed": { thread_id: string; parent_thread_id: string };
	"yard:execution": YardExecutionEvent;
	"connector:event": {
		trigger_key: string;
		task_id: string;
		handle_id: string;
		batch_size: number;
	};
	"connector:handle_synced": { handle_id: string; server_name: string };
	/**
	 * Number of background (deferred, #76) tool calls currently in flight on a
	 * thread. Recomputed from `messages` on every change rather than incremented,
	 * so a client that missed a frame resyncs to truth on the next event.
	 */
	"background:count": { thread_id: string; count: number };
}
