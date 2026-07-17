import { describe, expect, it, vi } from "bun:test";
import type { Message } from "@bound/shared";
import { render } from "ink-testing-library";
import React from "react";
import { MessageBlock } from "../tui/components/MessageBlock";
import { PENDING_USER_MESSAGE_ID } from "../tui/hooks/useMessages";
import {
	ChatView,
	type ChatViewProps,
	buildToolResultMetaMap,
	buildTranscriptMargins,
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

	it("lists the Esc hint in the action bar", async () => {
		const props = makeProps();
		const { lastFrame } = render(React.createElement(ChatView, props));
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("Esc");
		expect(frame).toContain("clear input");
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
		expect(m.get("r1")).toEqual({
			filePath: "/a.ts",
			isLastInGroup: true,
			toolName: "read",
			input: { file_path: "/a.ts" },
			callMsgId: "c1",
			total: 1,
			callCreatedAt: "2026-05-22T00:00:00Z",
		});
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
			toolName: "bash",
			input: { command: "echo hi" },
			callMsgId: "c1",
			total: 1,
			callCreatedAt: "2026-05-22T00:00:00Z",
		});
	});

	it("carries the parent tool_use's name through to each result", () => {
		const messages = [
			toolCall("c1", [
				{ id: "tu1", name: "boundless_read", input: { file_path: "/a.ts" } },
				{ id: "tu2", name: "tavily" },
			]),
			toolResult("r1", "tu1"),
			toolResult("r2", "tu2"),
		];
		const m = buildToolResultMetaMap(messages);
		expect(m.get("r1")?.toolName).toBe("boundless_read");
		expect(m.get("r2")?.toolName).toBe("tavily");
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

/**
 * The tool_result row's `tool_name` column holds the opaque tool_use_id, not a
 * human name. The header must render the resolved tool name (via the `toolName`
 * prop) and never leak that id to the screen.
 */
describe("MessageBlock tool_result header", () => {
	const toolUseId = "tooluse_01ABCdefGHIjklMNOpqrST";

	function resultMsg(): Message {
		return msg({
			id: "r1",
			role: "tool_result",
			tool_name: toolUseId,
			content: "ok",
			exit_code: 0,
		});
	}

	it("renders the resolved tool name, not the tool_use_id", () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: resultMsg(),
				toolName: "boundless_read",
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("read");
		expect(out).not.toContain(toolUseId);
	});

	it("omits the header label entirely when no tool name resolves", () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: resultMsg(),
				terminalColumns: 80,
			}),
		);
		expect(lastFrame() ?? "").not.toContain(toolUseId);
	});
});

/**
 * Compact read/search grouping: consecutive read/search invocations collapse
 * to one line each with no blank lines between them. Because Ink's <Static>
 * commits each row once and never repaints, all margins here are derived
 * only from PRECEDING messages (marginTop on the follower, never a
 * retroactive marginBottom on the last row of a run).
 */
describe("buildTranscriptMargins (compact read/search grouping)", () => {
	function marginsFor(messages: Message[]) {
		return buildTranscriptMargins(messages, buildToolResultMetaMap(messages));
	}

	it("stacks consecutive read/search invocations with no gaps and flags the open run", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "boundless_read", input: { file_path: "/a.ts" } }]),
			toolResult("r1", "tu1"),
			toolCall("c2", [{ id: "tu2", name: "boundless_search", input: { pattern: "foo" } }]),
			toolResult("r2", "tu2"),
		];
		const { margins, endsInCompactRun } = marginsFor(messages);
		expect(margins.get("c1")).toEqual({ top: 0, bottom: 0 });
		expect(margins.get("r1")).toEqual({ top: 0, bottom: 0 });
		expect(margins.get("c2")).toEqual({ top: 0, bottom: 0 });
		expect(margins.get("r2")).toEqual({ top: 0, bottom: 0 });
		expect(endsInCompactRun).toBe(true);
	});

	it("separates the message after a compact run with a top margin", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "boundless_read", input: { file_path: "/a.ts" } }]),
			toolResult("r1", "tu1"),
			msg({ id: "a1", role: "assistant", content: "done" }),
		];
		const { margins, endsInCompactRun } = marginsFor(messages);
		expect(margins.get("a1")).toEqual({ top: 1, bottom: 1 });
		expect(endsInCompactRun).toBe(false);
	});

	it("keeps legacy margins for non-compact tools (call abuts results, last result closes)", () => {
		const messages = [
			toolCall("c1", [
				{ id: "tu1", name: "bash" },
				{ id: "tu2", name: "bash" },
			]),
			toolResult("r1", "tu1"),
			toolResult("r2", "tu2"),
		];
		const { margins, endsInCompactRun } = marginsFor(messages);
		expect(margins.get("c1")).toEqual({ top: 0, bottom: 0 });
		expect(margins.get("r1")).toEqual({ top: 0, bottom: 0 });
		expect(margins.get("r2")).toEqual({ top: 0, bottom: 1 });
		expect(endsInCompactRun).toBe(false);
	});

	it("treats a compact-tool error result as full-width: closes the run, keeps group abutment", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "boundless_read", input: { file_path: "/a.ts" } }]),
			msg({
				id: "r1",
				role: "tool_result",
				tool_name: "tu1",
				content: "Error: ENOENT",
				exit_code: 1,
			}),
		];
		const { margins, endsInCompactRun } = marginsFor(messages);
		// Same owning call as the suppressed row before it — no stray top gap.
		expect(margins.get("r1")).toEqual({ top: 0, bottom: 1 });
		expect(endsInCompactRun).toBe(false);
	});

	it("a tool_call with inline text is not suppressed and takes the gap after a run", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "boundless_read", input: { file_path: "/a.ts" } }]),
			toolResult("r1", "tu1"),
			msg({
				id: "c2",
				role: "tool_call",
				content: JSON.stringify([
					{ type: "text", text: "checking b too" },
					{ type: "tool_use", id: "tu2", name: "boundless_read", input: { file_path: "/b.ts" } },
				]),
			}),
			toolResult("r2", "tu2"),
		];
		const { margins } = marginsFor(messages);
		expect(margins.get("c2")).toEqual({ top: 1, bottom: 0 });
		// Its result is compact again and re-opens the run.
		expect(margins.get("r2")).toEqual({ top: 0, bottom: 0 });
	});
});

/**
 * Compact read/search result rendering: one line per invocation carrying the
 * target (path / pattern) and a volume summary (lines read / matches found).
 * The ⏵ call row for compact-only calls is suppressed entirely.
 */
describe("MessageBlock compact read/search rendering", () => {
	it("renders a read result as one line with path and line count, no body", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "1:aaaa|const a = 1;\n2:bbbb|const b = 2;\n3:cccc|const c = 3;",
			exit_code: 0,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_read",
				filePath: "/x/y.ts",
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("read");
		expect(out).toContain("y.ts");
		expect(out).toContain("3 lines");
		expect(out).not.toContain("const a");
	});

	it("renders a search result with the parsed match summary and pattern", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content:
				"src/a.ts:1:ab12:foo\nsrc/b.ts:2:cd34:foo\n\n2 matches in 2 files (10 files searched)",
			exit_code: 0,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_search",
				toolInput: { pattern: "foo" },
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("search");
		expect(out).toContain("foo");
		expect(out).toContain("2 matches in 2 files");
		expect(out).not.toContain("files searched");
	});

	it("keeps the full rendering for compact-tool errors", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "Error: ENOENT: no such file or directory: /nope.ts",
			exit_code: 1,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_read",
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("✗");
		expect(out).toContain("ENOENT");
	});

	it("suppresses a compact-only tool_call row entirely", () => {
		const call = toolCall("c1", [
			{ id: "tu1", name: "boundless_read", input: { file_path: "/a.ts" } },
		]);
		const { lastFrame } = render(
			React.createElement(MessageBlock, { message: call, terminalColumns: 80 }),
		);
		expect((lastFrame() ?? "").trim()).toBe("");
	});
});

/**
 * Outcome facts on committed result rows: wall-clock duration for slow calls
 * (call created_at → result created_at, both frozen at commit time), exit
 * codes beyond the bare ✗ (127/124/2 carry diagnostic signal; exit 1 stays
 * quiet), and one-line status for edit/write results whose call row already
 * rendered the full diff/preview.
 */
describe("MessageBlock result outcome facts", () => {
	it("shows duration on slow compact results, computed from the call timestamp", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "1:aaaa|line",
			exit_code: 0,
			created_at: "2026-05-22T00:00:05Z",
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_read",
				filePath: "/x/y.ts",
				callCreatedAt: "2026-05-22T00:00:00Z",
				terminalColumns: 80,
			}),
		);
		expect(lastFrame() ?? "").toContain("5.0s");
	});

	it("omits duration on fast calls", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "1:aaaa|line",
			exit_code: 0,
			created_at: "2026-05-22T00:00:00.500Z",
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_read",
				filePath: "/x/y.ts",
				callCreatedAt: "2026-05-22T00:00:00Z",
				terminalColumns: 80,
			}),
		);
		expect(lastFrame() ?? "").not.toContain("0.5s");
	});

	it("shows non-1 exit codes on error results", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "sh: nope: command not found",
			exit_code: 127,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_bash",
				terminalColumns: 80,
			}),
		);
		expect(lastFrame() ?? "").toContain("exit 127");
	});

	it("stays quiet on exit 1 — the ✗ already says it failed", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "tests failed",
			exit_code: 1,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_bash",
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("✗");
		expect(out).not.toContain("exit 1");
	});

	it("collapses an edit result to one status line — the call row carries the diff", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content:
				"Edited /x/y.ts: applied 3 edits\n\nNew content (fresh anchors):\n1:aaaa|const a = 1;",
			exit_code: 0,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_edit",
				filePath: "/x/y.ts",
				toolInput: {
					file_path: "/x/y.ts",
					edits: [
						{ start: "1:aa", end: "1:aa", content: "x" },
						{ start: "2:bb", end: "2:bb", content: "y" },
						{ start: "3:cc", end: "3:cc", content: "z" },
					],
				},
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("3 edits applied");
		expect(out).toContain("y.ts");
		expect(out).not.toContain("New content");
	});

	it("collapses a write result to one status line with the written line count", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "Wrote 42 bytes to /x/new.ts",
			exit_code: 0,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_write",
				filePath: "/x/new.ts",
				toolInput: { file_path: "/x/new.ts", content: "a\nb\nc" },
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("3 lines written");
		expect(out).not.toContain("Wrote 42 bytes");
	});

	it("keeps full rendering for edit errors", () => {
		const message = msg({
			id: "r1",
			role: "tool_result",
			tool_name: "tu1",
			content: "Error: anchor mismatch at 12:a3f1",
			exit_code: 1,
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message,
				toolName: "boundless_edit",
				filePath: "/x/y.ts",
				terminalColumns: 80,
			}),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("✗");
		expect(out).toContain("anchor mismatch");
	});
});

describe("buildToolResultMetaMap path-param extraction", () => {
	it("resolves filePath from bms-style `path` input as well as `file_path`", () => {
		const messages = [
			toolCall("c1", [{ id: "tu1", name: "bms_read", input: { path: "/home/user/notes.md" } }]),
			toolResult("r1", "tu1"),
		];
		const m = buildToolResultMetaMap(messages);
		expect(m.get("r1")?.filePath).toBe("/home/user/notes.md");
	});
});
