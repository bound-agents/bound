/**
 * Regression (#278): an aux timeout result for call A, then the real client
 * result for A, then B's result. The pair sanitizer kept both A results while
 * B was still pending, so the next inference sent one tool_use id with two
 * tool_result blocks and the provider rejected the prompt.
 */

import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { sanitizeToolPairs } from "../index";

const NOW_ISO = "2026-11-23T03:39:55.000Z";

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

const call = msg(
	"tool_call",
	"tc1",
	JSON.stringify([
		{ type: "tool_use", id: "A", name: "boundless_bash", input: {} },
		{ type: "tool_use", id: "B", name: "boundless_bash", input: {} },
	]),
);

function resultIds(out: Message[]): Array<string | null> {
	return out.filter((m) => m.role === "tool_result").map((m) => m.tool_name);
}

describe("sanitizeToolPairs — duplicate tool_result for one tool_use id", () => {
	it("keeps the first A result and drops the late duplicate in an A,A,B history", () => {
		const out = sanitizeToolPairs({
			messages: [
				msg("user", "u1", "go"),
				call,
				msg("tool_result", "rA-timeout", "Error: exceeded timeout", "A"),
				msg("tool_result", "rA-real", "real output", "A"),
				msg("tool_result", "rB", "b output", "B"),
				msg("assistant", "a1", "done"),
			],
			threadId: "t1",
			nowIso: NOW_ISO,
		});

		expect(resultIds(out)).toEqual(["A", "B"]);
		expect(out.find((m) => m.tool_name === "A" && m.role === "tool_result")?.id).toBe("rA-timeout");
	});

	it("drops a duplicate that lands after the batch already closed (A,B,A)", () => {
		const out = sanitizeToolPairs({
			messages: [
				msg("user", "u1", "go"),
				call,
				msg("tool_result", "rA", "a", "A"),
				msg("tool_result", "rB", "b", "B"),
				msg("tool_result", "rA-late", "late a", "A"),
			],
			threadId: "t1",
			nowIso: NOW_ISO,
		});

		expect(resultIds(out)).toEqual(["A", "B"]);
		expect(out.some((m) => m.role === "tool_call" && m.id !== "tc1")).toBe(false);
	});
});
