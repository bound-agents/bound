import type { Message, StatusForwardPayload } from "./types.js";

export interface EventMap {
	"message:created": { message: Message; thread_id: string };
	"task:triggered": { task_id: string; trigger: string };
	"task:completed": { task_id: string; result: string | null };
	"sync:completed": { pushed: number; pulled: number; duration_ms: number };
	"sync:trigger": { reason: string };
	"file:changed": { path: string; operation: "created" | "modified" | "deleted" };
	"alert:created": { message: Message; thread_id: string };
	"agent:cancel": { thread_id: string };
	"status:forward": StatusForwardPayload;
}
