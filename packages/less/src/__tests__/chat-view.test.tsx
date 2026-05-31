import { describe, expect, it, vi } from "bun:test";
import type { Message } from "@bound/shared";
import { render } from "ink-testing-library";
import React from "react";
import { PENDING_USER_MESSAGE_ID } from "../tui/hooks/useMessages";
import {
	ChatView,
	type ChatViewProps,
	buildToolResultMetaMap,
	partitionPendingMessage,
} from "../tui/views/ChatView";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

function makeProps(overrides: Partial<ChatViewProps> = {}): ChatViewProps {
	return {
		client: null,
		threadId: "thread-123",
		model: "gpt-4",
		connectionState: "connected",
		cwd: "/tmp/work",
		commitHash: "test-sha",
		messages: [],
		inFlightTools: new Map(),
		mcpServerCount: 0,
		bannerMessage: null,
		bannerType: null,
		ctrlCHint: null,
		isProcessing: false,
		onModelChange: vi.fn(),
		onModelPicker: vi.fn(),
		onAttachThread: vi.fn(),
		onMcpView: vi.fn(),
		onClear: vi.fn(),
		onBannerDismiss: vi.fn(),
		onSendMessage: vi.fn(),
		...overrides,
	};
}

async function typeAndSubmit(stdin: NodeJS.WritableStream, text: string) {
	stdin.write(text);
	await tick();
	// Carriage return submits the TextInput
	stdin.write("\r");
	await tick();
}

describe("ChatView slash commands", () => {
	it("bare /model opens the model picker", async () => {
		const onModelPicker = vi.fn();
		const onModelChange = vi.fn();
		const props = makeProps({ onModelPicker, onModelChange });

		const { stdin } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/model");

		expect(onModelPicker).toHaveBeenCalledTimes(1);
		expect(onModelChange).not.toHaveBeenCalled();
	});

	it("/model <name> sets the model directly without opening picker", async () => {
		const onModelPicker = vi.fn();
		const onModelChange = vi.fn();
		const props = makeProps({ onModelPicker, onModelChange });

		const { stdin } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/model claude-sonnet");

		expect(onModelChange).toHaveBeenCalledTimes(1);
		expect(onModelChange).toHaveBeenCalledWith("claude-sonnet");
		expect(onModelPicker).not.toHaveBeenCalled();
	});

	it("bare /attach opens the thread picker", async () => {
		const onAttachThread = vi.fn();
		const props = makeProps({ onAttachThread });

		const { stdin } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/attach");

		expect(onAttachThread).toHaveBeenCalledTimes(1);
	});

	it("/help lists /model without requiring an argument", async () => {
		const props = makeProps();
		const { stdin, lastFrame } = render(React.createElement(ChatView, props));
		await tick();

		await typeAndSubmit(stdin, "/help");

		const frame = lastFrame() ?? "";
		// Help entry for /model should not make <name> look required.
		// Accept either "/model" alone or "/model [name]" (optional-arg convention).
		expect(frame).toContain("/model");
		expect(frame).not.toContain("/model <name>");
	});
});

describe("ChatView active prop", () => {
	it("renders dynamic content by default (active=true)", async () => {
		const props = makeProps();
		const { lastFrame } = render(React.createElement(ChatView, props));
		await tick();

		const output = lastFrame() ?? "";
		// Input prompt and status bar thread ID should be present
		expect(output).toContain("❯");
		expect(output).toContain("thread-123");
	});

	it("suppresses dynamic content when active=false, keeping Static mounted", async () => {
		const props = makeProps({ active: false });
		const { lastFrame } = render(React.createElement(ChatView, props));
		await tick();

		const output = lastFrame() ?? "";
		// Dynamic area (input prompt, status bar thread ID) should be absent.
		// The <Static> splash may still appear in lastFrame() — that's expected
		// and is the whole point: Static stays mounted across view transitions.
		expect(output).not.toContain("❯");
		expect(output).not.toContain("thread-123");
	});
});

/**
 * Test fixtures for buildToolResultMetaMap. Real tool_call messages store a
 * JSON array of content blocks in `content`; tool_result messages stash the
 * matching tool_use_id in their `tool_name` column.
 */
function msg(overrides: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message {
	return {
		thread_id: "t1",
		model_id: null,
		tool_name: null,
		created_at: "2026-05-22T00:00:00Z",
		modified_at: null,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
}

function toolCall(
	id: string,
	uses: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
): Message {
	return msg({
		id,
		role: "tool_call",
		content: JSON.stringify(uses.map((u) => ({ type: "tool_use", ...u }))),
	});
}

function toolResult(id: string, toolUseId: string, content = "ok"): Message {
	return msg({ id, role: "tool_result", tool_name: toolUseId, content });
}

describe("buildToolResultMetaMap", () => {
	it("returns an empty map for an empty input", () => {
		expect(buildToolResultMetaMap([]).size).toBe(0);
	});

	it("classifies a single 1-of-1 result as last in its group", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "read", input: { file_path: "/a.ts" } }]),
			toolResult("r1", "tu1"),
		];
		const m = buildToolResultMetaMap(messages);
		expect(m.size).toBe(1);
		expect(m.get("r1")).toEqual({ filePath: "/a.ts", isLastInGroup: true });
	});

	it("marks all but the final sibling result as mid-group for parallel calls", () => {
		const messages = [
			toolCall("c1", [
				{ id: "tu1", name: "read", input: { file_path: "/a.ts" } },
				{ id: "tu2", name: "read", input: { file_path: "/b.ts" } },
				{ id: "tu3", name: "read", input: { file_path: "/c.ts" } },
			]),
			toolResult("r1", "tu1"),
			toolResult("r2", "tu2"),
			toolResult("r3", "tu3"),
		];
		const m = buildToolResultMetaMap(messages);
		expect(m.get("r1")?.isLastInGroup).toBe(false);
		expect(m.get("r2")?.isLastInGroup).toBe(false);
		expect(m.get("r3")?.isLastInGroup).toBe(true);
		// File paths flow through from each matching tool_use's input.
		expect(m.get("r1")?.filePath).toBe("/a.ts");
		expect(m.get("r3")?.filePath).toBe("/c.ts");
	});

	it("treats sequential tool_calls as independent groups", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "bash" }]),
			toolResult("r1", "tu1"),
			toolCall("c2", [{ id: "tu2", name: "bash" }]),
			toolResult("r2", "tu2"),
		];
		const m = buildToolResultMetaMap(messages);
		// Each result is the only sibling in its own group → both are "last".
		expect(m.get("r1")?.isLastInGroup).toBe(true);
		expect(m.get("r2")?.isLastInGroup).toBe(true);
	});

	it("Static-friendliness: an early result classifies correctly before siblings arrive", () => {
		// At the moment result-1 first renders, result-2 may not yet exist.
		// The call's tool_use count is the source of truth for group size, so
		// result-1 still resolves as mid-group.
		const messages = [
			toolCall("c1", [
				{ id: "tu1", name: "read" },
				{ id: "tu2", name: "read" },
			]),
			toolResult("r1", "tu1"),
		];
		const m = buildToolResultMetaMap(messages);
		expect(m.get("r1")?.isLastInGroup).toBe(false);
	});

	it("ignores orphan tool_results with no matching tool_call", () => {
		const messages = [toolResult("r1", "tu-nonexistent")];
		expect(buildToolResultMetaMap(messages).has("r1")).toBe(false);
	});

	it("skips tool_call messages whose content does not parse as JSON", () => {
		const messages = [
			msg({ id: "c1", role: "tool_call", content: "not-json{" }),
			toolResult("r1", "tu1"),
		];
		expect(buildToolResultMetaMap(messages).size).toBe(0);
	});

	it("ignores tool_call messages whose content has no tool_use blocks", () => {
		const messages = [
			msg({ id: "c1", role: "tool_call", content: JSON.stringify([{ type: "text", text: "hi" }]) }),
			toolResult("r1", "tu-nonexistent"),
		];
		expect(buildToolResultMetaMap(messages).size).toBe(0);
	});

	it("returns undefined filePath when the tool_use has no file_path input", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "bash", input: { command: "echo hi" } }]),
			toolResult("r1", "tu1"),
		];
		expect(buildToolResultMetaMap(messages).get("r1")).toEqual({
			filePath: undefined,
			isLastInGroup: true,
		});
	});
});

/**
 * #134: the optimistic "sending…" placeholder must NOT live in the <Static>
 * stream. Ink's <Static> commits each index exactly once and never repaints it,
 * so reconciling the placeholder in place (the #88 data-layer behavior, which
 * its own unit tests cover and still pass) leaves the grey line frozen in
 * scrollback while assistant replies append fresh at higher indices. The fix
 * renders the placeholder in the redrawn dynamic area and keeps it out of the
 * committed (Static) list. partitionPendingMessage is the pure seam that
 * enforces that split.
 */
describe("partitionPendingMessage (#134)", () => {
	function userMsg(id: string, content: string): Message {
		return msg({ id, role: "user", content });
	}
	function pendingMsg(content: string): Message {
		return msg({ id: PENDING_USER_MESSAGE_ID, role: "user", content });
	}

	it("excludes the pending placeholder from the committed (Static) list", () => {
		const real = userMsg("real-1", "world");
		const pending = pendingMsg("hello");
		const { committed, pending: p } = partitionPendingMessage([real, pending]);
		expect(committed).toEqual([real]);
		expect(p).toBe(pending);
	});

	it("returns null pending and the full list when no placeholder is present", () => {
		const real = userMsg("real-1", "world");
		const { committed, pending } = partitionPendingMessage([real]);
		expect(committed).toEqual([real]);
		expect(pending).toBeNull();
	});

	it("preserves committed order when the placeholder sits mid-list", () => {
		const a = userMsg("a", "first");
		const b = msg({ id: "b", role: "assistant", content: "reply" });
		const pending = pendingMsg("in-flight");
		const { committed, pending: p } = partitionPendingMessage([a, b, pending]);
		expect(committed).toEqual([a, b]);
		expect(p).toBe(pending);
	});
});
