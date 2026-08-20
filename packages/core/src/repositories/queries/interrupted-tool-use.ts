import type { Database } from "bun:sqlite";

export const INTERRUPTED_TOOL_USE_SCAN_SQL = `WITH thread_summary AS (
	SELECT thread_id,
		MAX(CASE
			WHEN role IN ('tool_call', 'tool_result') AND host_origin = ? THEN created_at
		END) AS last_local_tool_at,
		MAX(CASE WHEN role = 'assistant' THEN created_at END) AS last_assistant_at,
		MAX(CASE
			WHEN role IN ('system', 'developer')
			 AND (content LIKE '%interrupted%' OR content LIKE '%cancelled%')
			THEN created_at
		END) AS last_interrupt_at
	FROM messages
	WHERE deleted = 0
	GROUP BY thread_id
)
SELECT ts.thread_id FROM thread_summary ts
JOIN threads t ON t.id = ts.thread_id
WHERE t.deleted = 0
  AND t.agent_id IS NULL
  AND ts.last_local_tool_at IS NOT NULL
  AND (ts.last_assistant_at IS NULL OR ts.last_assistant_at < ts.last_local_tool_at)
  AND (ts.last_interrupt_at IS NULL OR ts.last_interrupt_at < ts.last_local_tool_at)
  AND NOT EXISTS (
	SELECT 1 FROM dispatch_queue dq
	WHERE dq.thread_id = ts.thread_id
	  AND dq.event_type = 'client_tool_call'
	  AND dq.status IN ('pending', 'processing')
  )`;

export function listInterruptedToolUseThreadIds(
	db: Database,
	siteId: string,
): Array<{ thread_id: string }> {
	return db.query(INTERRUPTED_TOOL_USE_SCAN_SQL).all(siteId) as Array<{ thread_id: string }>;
}
