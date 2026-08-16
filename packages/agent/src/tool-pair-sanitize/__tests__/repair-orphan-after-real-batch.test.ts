/**
 * Regression: an orphaned tool_result that lands immediately after a REAL,
 * fully-closed tool pair used to slip through Pass 2 unrepaired.
 *
 * The `prevSanitizedRole === "tool_result"` branch assumed consecutive
 * orphans share a synthetic parent (`lastSyntheticToolCall`) — but when the
 * preceding result belonged to a real tool_call, `lastSyntheticToolCall` is
 * null and the orphan was pushed BARE, violating post-condition T3 ("no
 * tool_result in the output is orphaned"). Downstream, the Stage 5
 * annotator's fallback then stamped the orphan with the last real call's
 * tool_use id, manufacturing duplicate tool_result ids on the wire
 * (incident thread adb65d85, 2026-08-16).
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { hasOrphanedToolResult, hasUnclosedToolCall, sanitizeToolPairs } from "../index";

const NOW_ISO = "2026-08-16T07:00:00.000Z";

function msg(
	role: Message["role"],
	id: string,
	content: string,
	toolName: string | null = null,
): Message {
	return {
		id,
		thread_id: "t1",
		role,
		content,
		model_id: null,
		tool_name: toolName,
		created_at: NOW_ISO,
		modified_at: NOW_ISO,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

describe("repairPass — orphan tool_result directly after a closed real batch", () => {
	it("synthesizes a declaring tool_call instead of pushing the orphan bare", () => {
		const input: Message[] = [
			msg("user", "u1", "go"),
			msg(
				"tool_call",
				"tc1",
				JSON.stringify([{ type: "tool_use", id: "tuA", name: "think", input: {} }]),
			),
			msg("tool_result", "tr1", "done", "tuA"),
			// Orphan: no tool_call anywhere declares this id.
			msg("tool_result", "tr2", "[bookkeeping]", "yard-client-zzz"),
		];

		const out = sanitizeToolPairs({ messages: input, threadId: "t1", nowIso: NOW_ISO });

		expect(hasOrphanedToolResult(out)).toBe(false);
		expect(hasUnclosedToolCall(out)).toBe(false);

		// Idempotence must hold on the repaired output too.
		const again = sanitizeToolPairs({ messages: out, threadId: "t1", nowIso: NOW_ISO });
		expect(JSON.stringify(again)).toBe(JSON.stringify(out));
	});
});
