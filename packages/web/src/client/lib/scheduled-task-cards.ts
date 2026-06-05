// Pure extraction logic for the inline task cards (#90).
//
// When the agent calls the `task` tool with action=schedule, the tool result
// is the freshly-minted task id (a bare UUID). The chat UI renders a card for
// each such call so a user can jump to the task's thread once it runs. This
// module isolates the "which tool calls are scheduled-task cards, and what is
// their task id" decision so it can be unit-tested without a DOM.

interface ToolUseLike {
	id: string;
	name: string;
	input: unknown;
}

interface ResultLike {
	content: string;
	exit_code?: number | null;
}

export interface ScheduledTaskRef {
	/** The tool_use id of the originating `task` call (stable render key). */
	toolUseId: string;
	/** The scheduled task's id, parsed from the tool result. */
	taskId: string;
}

// A bare UUID — the only thing a successful schedule returns. Anything else
// (an error string, an `action=update` summary like "Updated task X (...)")
// must NOT produce a card, so we gate strictly on this shape.
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readAction(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const action = (input as Record<string, unknown>).action;
	return typeof action === "string" ? action : undefined;
}

/**
 * Select the `task`-tool calls in a turn that scheduled a new task and resolve
 * each to its task id. Only `action=schedule` calls with a successful result
 * whose content is a bare task UUID qualify; updates, errors, and
 * still-pending calls are skipped.
 */
export function extractScheduledTaskRefs(
	toolUses: ToolUseLike[],
	resultsByToolUseId: Record<string, ResultLike>,
): ScheduledTaskRef[] {
	const refs: ScheduledTaskRef[] = [];
	const seen = new Set<string>();
	for (const tu of toolUses) {
		if (tu.name !== "task") continue;
		if (readAction(tu.input) !== "schedule") continue;

		const result = resultsByToolUseId[tu.id];
		if (!result) continue; // still awaiting the result
		if (result.exit_code != null && result.exit_code !== 0) continue; // schedule failed

		const taskId = result.content.trim();
		if (!TASK_ID_RE.test(taskId)) continue;
		if (seen.has(tu.id)) continue;
		seen.add(tu.id);

		refs.push({ toolUseId: tu.id, taskId });
	}
	return refs;
}
