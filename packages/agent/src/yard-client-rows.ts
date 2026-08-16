/**
 * Yard client-tool bookkeeping rows.
 *
 * When Yard (or a foreground aux) awaits a boundless client tool through
 * `dispatchAwaitableClientTool`, websocket.ts persists the client's output as
 * an ordinary `tool_result` row whose `tool_name` is the dispatch call id
 * (`yard-client-<uuid>`). No assistant `tool_call` ever declares that id —
 * the row exists so the awaiter can poll for the result and so the transcript
 * shows the effect — and the aggregate `yard` tool_result already carries the
 * content the model needs.
 *
 * Those rows must therefore never reach LLM context. Left in, they are
 * orphaned tool_results; the Stage 5 annotator's last-call fallback used to
 * stamp each one with the previous tool_call's first tool_use id, producing
 * N tool_results for one tool_use — Bedrock rejects the request with "each
 * tool_use must have a single result", and every cold rebuild reproduces the
 * poison (incident thread adb65d85, 2026-08-16).
 *
 * The filter applies at every seam that turns message rows into LLM context:
 *   - cold assembly Stage 1 (context-assembly.ts, both history branches)
 *   - warm delta conversion (agent-loop-utils.ts convertDeltaMessages)
 *   - the delegation-segment codec's row loader (delegation-segments.ts),
 *     which keeps producer and consumer byte-identical over the same filter
 *
 * Storage is untouched: the rows stay in the DB for the transcript,
 * Inspector, and the dispatch await path.
 */

/** Call-id prefix used by `dispatchAwaitableClientTool`. Single source of truth. */
export const YARD_CLIENT_CALL_ID_PREFIX = "yard-client-";

/**
 * True for a persisted `tool_result` row that is Yard client-dispatch
 * bookkeeping rather than a model-facing tool result.
 */
export function isYardClientBookkeepingRow(row: {
	role: string;
	tool_name?: string | null;
}): boolean {
	return (
		row.role === "tool_result" &&
		typeof row.tool_name === "string" &&
		row.tool_name.startsWith(YARD_CLIENT_CALL_ID_PREFIX)
	);
}
