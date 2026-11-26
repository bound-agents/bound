export type ToolCancelReason = "thread_canceled" | "dispatch_expired" | "session_reset";

export type EmitToolCancel = (
	entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
	threadId: string,
	reason: ToolCancelReason,
) => void;

export type RequestConsistency = (
	tables: string[],
) => Promise<Map<string, { count: number; pks: string[] }>>;

/**
 * Minimal view of the agent's span tracker, so this package does not import
 * `@bound/agent`; the implementation lives in
 * `packages/agent/src/handle-message-tracker.ts`.
 */
export interface HandleMessageTracker {
	closeDispatch(callId: string, status?: "ok" | "error", reason?: string): void;
}
