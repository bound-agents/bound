import type { ContextDebugInfo, Message, RelayKind, StatusForwardPayload } from "./types.js";

export interface EventMap {
	"message:created": { message: Message; thread_id: string };
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
		tier: number;
		thread_id: string;
		task_id?: string;
		reason: string;
	};
	"changelog:written": { hlc: string; tableName: string; siteId: string };
	"relay:outbox-written": { id: string; target_site_id: string };
	"relay:inbox": { ref_id?: string; stream_id?: string; kind: RelayKind };
	"client_tool_call:created": {
		threadId: string;
		callId: string;
		entryId: string;
		toolName: string;
		arguments: Record<string, unknown>;
	};
	"connector:event": {
		trigger_key: string;
		task_id: string;
		handle_id: string;
		batch_size: number;
	};
	"connector:list_changed": { server_name: string };
}
