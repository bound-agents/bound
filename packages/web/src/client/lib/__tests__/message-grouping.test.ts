import { describe, expect, it } from "bun:test";
import {
	type GroupableMessage,
	groupMessages,
	messageHasUserFacingText,
} from "../message-grouping";

// Helpers to build persisted-message fixtures. A tool_call message's content
// is a JSON-stringified ContentBlock[] = [thinking?, text?, ...tool_use].
function toolCall(
	id: string,
	opts: { text?: string; thinking?: string; tool?: string } = {},
): GroupableMessage {
	const blocks: unknown[] = [];
	if (opts.thinking) blocks.push({ type: "thinking", thinking: opts.thinking });
	if (opts.text) blocks.push({ type: "text", text: opts.text });
	blocks.push({ type: "tool_use", id: `tu_${id}`, name: opts.tool ?? "bash", input: {} });
	return { role: "tool_call", content: JSON.stringify(blocks), id, created_at: id };
}

function toolResult(id: string, name = "bash"): GroupableMessage {
	return { role: "tool_result", content: "ok", id, tool_name: name, created_at: id };
}

function userMsg(id: string, text = "hi"): GroupableMessage {
	return { role: "user", content: text, id, created_at: id };
}

function assistantMsg(id: string, text = "done"): GroupableMessage {
	return { role: "assistant", content: text, id, created_at: id };
}

describe("messageHasUserFacingText", () => {
	it("detects a non-empty text block", () => {
		expect(messageHasUserFacingText(JSON.stringify([{ type: "text", text: "hello" }]))).toBe(true);
	});

	it("ignores whitespace-only text", () => {
		expect(messageHasUserFacingText(JSON.stringify([{ type: "text", text: "   " }]))).toBe(false);
	});

	it("ignores thinking-only content", () => {
		expect(messageHasUserFacingText(JSON.stringify([{ type: "thinking", thinking: "hmm" }]))).toBe(
			false,
		);
	});

	it("ignores tool-use-only content", () => {
		expect(
			messageHasUserFacingText(JSON.stringify([{ type: "tool_use", id: "x", name: "bash" }])),
		).toBe(false);
	});

	it("returns false on malformed JSON", () => {
		expect(messageHasUserFacingText("not json")).toBe(false);
		expect(messageHasUserFacingText(null)).toBe(false);
		expect(messageHasUserFacingText("")).toBe(false);
	});
});

describe("groupMessages — base grouping", () => {
	it("passes plain user/assistant messages through as message items", () => {
		const items = groupMessages([userMsg("1"), assistantMsg("2")]);
		expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
	});

	it("collapses a consecutive tool_call run into a single group", () => {
		const items = groupMessages([toolCall("1"), toolResult("2"), toolCall("3"), toolResult("4")]);
		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("toolGroup");
		if (items[0].kind === "toolGroup") {
			expect(items[0].messages.map((m) => m.id)).toEqual(["1", "3"]);
		}
	});

	it("never emits a standalone tool_result item", () => {
		const items = groupMessages([toolCall("1"), toolResult("2")]);
		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("toolGroup");
	});

	it("keys a group on its first member id (stable across appends)", () => {
		const before = groupMessages([toolCall("1"), toolResult("2")]);
		const after = groupMessages([toolCall("1"), toolResult("2"), toolCall("3")]);
		expect(before[0].key).toBe("1");
		expect(after[0].key).toBe("1");
	});
});

describe("groupMessages — issue #66: break on user-facing text", () => {
	it("breaks the group before a 2nd-or-later tool_call carrying user-facing text", () => {
		// tc1 has text -> it must lead a fresh group so its text renders up front.
		const items = groupMessages([
			toolCall("a", { thinking: "plan" }),
			toolResult("ar"),
			toolCall("b", { text: "Here's what I found:" }),
			toolResult("br"),
			toolCall("c"),
		]);
		expect(items).toHaveLength(2);
		expect(items[0].kind).toBe("toolGroup");
		expect(items[1].kind).toBe("toolGroup");
		if (items[0].kind === "toolGroup") {
			expect(items[0].messages.map((m) => m.id)).toEqual(["a"]);
		}
		if (items[1].kind === "toolGroup") {
			// The text-bearing message leads the new group (index 0 → rendered up front).
			expect(items[1].messages.map((m) => m.id)).toEqual(["b", "c"]);
		}
	});

	it("does NOT break when the FIRST group member carries text (already up front)", () => {
		const items = groupMessages([
			toolCall("a", { text: "starting now" }),
			toolResult("ar"),
			toolCall("b"),
		]);
		expect(items).toHaveLength(1);
		if (items[0].kind === "toolGroup") {
			expect(items[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
		}
	});

	it("does NOT break on a 2nd member that only has reasoning (no user-facing text)", () => {
		const items = groupMessages([
			toolCall("a"),
			toolResult("ar"),
			toolCall("b", { thinking: "still thinking" }),
		]);
		expect(items).toHaveLength(1);
		if (items[0].kind === "toolGroup") {
			expect(items[0].messages.map((m) => m.id)).toEqual(["a", "b"]);
		}
	});

	it("splits a long run into one group per text-bearing turn", () => {
		const items = groupMessages([
			toolCall("a"),
			toolResult("ar"),
			toolCall("b", { text: "step one done" }),
			toolResult("br"),
			toolCall("c", { text: "step two done" }),
			toolResult("cr"),
		]);
		expect(items.map((i) => i.kind)).toEqual(["toolGroup", "toolGroup", "toolGroup"]);
		const ids = items.map((i) => (i.kind === "toolGroup" ? i.messages.map((m) => m.id) : []));
		expect(ids).toEqual([["a"], ["b"], ["c"]]);
	});
});
