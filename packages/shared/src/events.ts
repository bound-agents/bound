import type { Message } from "./types.js";

export interface EventMap {
	"message:created": { message: Message; thread_id: string };
	"task:triggered": { task_id: string; trigger: string };
	"task:completed": { task_id: string; result: string | null };
	"sync:completed": { peer_site_id: string; events_received: number };
	"file:changed": { path: string; operation: "created" | "modified" | "deleted" };
	"alert:created": { message: Message; thread_id: string };
}
