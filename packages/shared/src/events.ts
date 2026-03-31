import type {
	ContextDebugInfo,
	Message,
	PlatformDeliverPayload,
	StatusForwardPayload,
} from "./types.js";

export interface EventMap {
	"message:created": { message: Message; thread_id: string };
	/** Emitted after a local agent loop run to push the new assistant message to
	 *  WebSocket clients without re-triggering the agent loop handler. */
	"message:broadcast": { message: Message; thread_id: string };
	"task:triggered": { task_id: string; trigger: string };
	"task:completed": { task_id: string; result: string | null };
	"sync:completed": { pushed: number; pulled: number; duration_ms: number };
	"sync:trigger": { reason: string };
	"file:changed": { path: string; operation: "created" | "modified" | "deleted" };
	"alert:created": { message: Message; thread_id: string };
	"agent:cancel": { thread_id: string };
	"status:forward": StatusForwardPayload;
	"platform:deliver": PlatformDeliverPayload;
	"platform:webhook": { platform: string; rawBody: string; headers: Record<string, string> };
	"context:debug": { thread_id: string; turn_id: number; debug: ContextDebugInfo };
}
