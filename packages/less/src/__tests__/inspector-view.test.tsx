import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { render } from "ink-testing-library";
import React from "react";
import { tokens } from "../tui/theme";
import { extractFullText } from "../tui/util/message-text";
import { buildToolResultMetaMap } from "../tui/util/transcript";
import {
	InspectorView,
	buildInspectorDetail,
	buildInspectorItems,
	resolveOffload,
} from "../tui/views/InspectorView";

let idCounter = 0;
function makeMessage(overrides: Partial<Message>): Message {
	idCounter++;
	return {
		id: `insp-msg-${idCounter}`,
		thread_id: "t1",
		role: "user",
		content: "hello",
		model_id: null,
		tool_name: null,
		created_at: "2026-07-18T01:02:03Z",
		modified_at: null,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("extractFullText", () => {
	it("returns raw string content as-is", () => {
		expect(extractFullText(makeMessage({ content: "plain text" }))).toBe("plain text");
	});

	it("flattens text blocks INCLUDING provenance blocks", () => {
		// The transcript renderer filters [boundless] provenance as noise;
		// the inspector keeps it — provenance is exactly what you open an
		// inspector to check.
		const content = JSON.stringify([
			{ type: "text", text: "[boundless] host=abc" },
			{ type: "text", text: "actual output" },
		]);
		const text = extractFullText(makeMessage({ content }));
		expect(text).toContain("[boundless] host=abc");
		expect(text).toContain("actual output");
	});

	it("renders tool_use blocks as name + pretty-printed input", () => {
		const content = JSON.stringify([
			{ type: "tool_use", id: "c1", name: "boundless_read", input: { file_path: "a.ts" } },
		]);
		const text = extractFullText(makeMessage({ role: "tool_call", content }));
		expect(text).toContain("⏵ boundless_read");
		expect(text).toContain('"file_path": "a.ts"');
	});
});

describe("resolveOffload", () => {
	it("extracts char count and path from an offload stub", () => {
		const stub =
			'[Tool result offloaded: 151723 characters from "boundless_bash"]\n' +
			"The full output was too large for the context window and has been saved to: /tmp/x/result.txt\n" +
			"Use bash to read or filter it";
		expect(resolveOffload(stub)).toEqual({ chars: 151723, path: "/tmp/x/result.txt" });
	});

	it("returns null for ordinary output", () => {
		expect(resolveOffload("regular tool output")).toBeNull();
	});

	it("returns null when the stub has no path line", () => {
		expect(resolveOffload('[Tool result offloaded: 5 characters from "x"]')).toBeNull();
	});
});

describe("buildInspectorItems", () => {
	it("lists newest first with role glyphs", () => {
		const messages = [
			makeMessage({ role: "user", content: "first question" }),
			makeMessage({ role: "assistant", content: "the answer" }),
		];
		const items = buildInspectorItems(messages, buildToolResultMetaMap(messages));
		expect(items).toHaveLength(2);
		expect(items[0].label).toBe("the answer");
		expect(items[0].glyph).toBe("●");
		expect(items[1].label).toBe("first question");
		expect(items[1].glyph).toBe("❯");
	});

	it("labels tool calls with name + first args line, and results with resolved name + line count", () => {
		const call = makeMessage({
			role: "tool_call",
			content: JSON.stringify([
				{ type: "tool_use", id: "c9", name: "boundless_read", input: { file_path: "src/a.ts" } },
			]),
		});
		const result = makeMessage({
			role: "tool_result",
			tool_name: "c9",
			content: "line1\nline2\nline3",
		});
		const messages = [call, result];
		const items = buildInspectorItems(messages, buildToolResultMetaMap(messages));
		expect(items[1].label).toContain("boundless_read");
		expect(items[1].label).toContain("src/a.ts");
		expect(items[0].label).toContain("read · 3 lines");
		expect(items[0].glyph).toBe("✓");
	});

	it("marks failed results with ✗", () => {
		const messages = [
			makeMessage({ role: "tool_result", tool_name: "cx", content: "boom", exit_code: 1 }),
		];
		const items = buildInspectorItems(messages, buildToolResultMetaMap(messages));
		expect(items[0].glyph).toBe("✗");
		expect(items[0].color).toBe(tokens.failureIndicator);
	});

	it("slices an HH:MM:SS time from the ISO timestamp", () => {
		const items = buildInspectorItems(
			[makeMessage({ created_at: "2026-07-18T09:41:07Z" })],
			new Map(),
		);
		expect(items[0].time).toBe("09:41:07");
	});
});

describe("buildInspectorDetail", () => {
	it("hydrates an offloaded result from disk via the injected reader", () => {
		const result = makeMessage({
			role: "tool_result",
			tool_name: "c1",
			content:
				'[Tool result offloaded: 20 characters from "boundless_bash"]\n' +
				"saved to: /tmp/offload.txt",
		});
		const meta = buildToolResultMetaMap([result]);
		const items = buildInspectorItems([result], meta);
		const detail = buildInspectorDetail(items[0], meta, (p) => `FULL CONTENT FROM ${p}`);
		expect(detail.body).toBe("FULL CONTENT FROM /tmp/offload.txt");
		expect(detail.hydratedFrom).toBe("/tmp/offload.txt");
		expect(detail.hydrateError).toBeUndefined();
	});

	it("degrades to the stub with a warning when the offload file is unreadable", () => {
		const result = makeMessage({
			role: "tool_result",
			tool_name: "c1",
			content: '[Tool result offloaded: 20 characters from "x"]\nsaved to: /tmp/gone.txt',
		});
		const meta = buildToolResultMetaMap([result]);
		const items = buildInspectorItems([result], meta);
		const detail = buildInspectorDetail(items[0], meta, () => {
			throw new Error("ENOENT");
		});
		expect(detail.hydrateError).toContain("/tmp/gone.txt");
		expect(detail.body).toContain("[Tool result offloaded");
	});

	it("derives lang from the correlated file path and counts lines in the title", () => {
		const call = makeMessage({
			role: "tool_call",
			content: JSON.stringify([
				{ type: "tool_use", id: "c2", name: "boundless_read", input: { file_path: "src/a.ts" } },
			]),
		});
		const result = makeMessage({
			role: "tool_result",
			tool_name: "c2",
			content: "const a = 1;\nconst b = 2;",
		});
		const messages = [call, result];
		const meta = buildToolResultMetaMap(messages);
		const items = buildInspectorItems(messages, meta);
		const detail = buildInspectorDetail(items[0], meta);
		expect(detail.lang).toBe("ts");
		expect(detail.title).toContain("2 lines");
		// Full fidelity extends to the name: the transcript shortens
		// "boundless_read" to "read"; the inspector shows the real one.
		expect(detail.title).toContain("tool_result · boundless_read");
	});

	it("carries a non-1 exit code into the title", () => {
		const result = makeMessage({
			role: "tool_result",
			tool_name: "cz",
			content: "not found",
			exit_code: 127,
		});
		const meta = buildToolResultMetaMap([result]);
		const items = buildInspectorItems([result], meta);
		expect(buildInspectorDetail(items[0], meta).title).toContain("exit 127");
	});
});

describe("InspectorView rendering", () => {
	it("renders the list with newest message first and key hints", async () => {
		const messages = [
			makeMessage({ role: "user", content: "older message" }),
			makeMessage({ role: "assistant", content: "newest reply" }),
		];
		const { lastFrame } = render(
			React.createElement(InspectorView, { messages, onClose: () => {} }),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Inspector — 2 messages");
		expect(frame).toContain("newest reply");
		expect(frame).toContain("older message");
		expect(frame.indexOf("newest reply")).toBeLessThan(frame.indexOf("older message"));
		expect(frame).toContain("Enter open");
	});

	it("opens the full-fidelity detail on Enter, beyond the transcript's 5-line cap", async () => {
		const body = Array.from({ length: 12 }, (_, i) => `detail-line-${i}`).join("\n");
		const messages = [makeMessage({ role: "tool_result", tool_name: "cq", content: body })];
		const { lastFrame, stdin } = render(
			React.createElement(InspectorView, { messages, onClose: () => {} }),
		);
		await tick();
		stdin.write("\r");
		await tick();
		const frame = lastFrame() ?? "";
		// The transcript truncates results to 5 lines; the inspector shows
		// well past that (viewport-bound, default test terminal is 24 rows).
		expect(frame).toContain("detail-line-0");
		expect(frame).toContain("detail-line-9");
		expect(frame).toContain("12 lines");
		expect(frame).toContain("Esc back");
	});

	it("Esc from the detail returns to the list; Esc from the list closes", async () => {
		let closed = false;
		const messages = [makeMessage({ role: "user", content: "only message" })];
		const { lastFrame, stdin } = render(
			React.createElement(InspectorView, {
				messages,
				onClose: () => {
					closed = true;
				},
			}),
		);
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").toContain("Esc back");
		stdin.write("\x1B");
		await tick();
		expect(lastFrame() ?? "").toContain("Enter open");
		expect(closed).toBe(false);
		stdin.write("\x1B");
		await tick();
		expect(closed).toBe(true);
	});

	it("renders a non-user/assistant/tool role (developer) with the fallback glyph", async () => {
		const messages = [makeMessage({ role: "developer", content: "injected system context" })];
		const { lastFrame } = render(
			React.createElement(InspectorView, { messages, onClose: () => {} }),
		);
		await tick();
		const frame = lastFrame() ?? "";
		// Other-role items get the ◦ glyph and the first non-empty content line.
		expect(frame).toContain("\u25e6");
		expect(frame).toContain("injected system context");
	});

	it("falls back to (empty) for a message whose body is all whitespace", async () => {
		const messages = [makeMessage({ role: "user", content: "   \n\t\n  " })];
		const { lastFrame } = render(
			React.createElement(InspectorView, { messages, onClose: () => {} }),
		);
		await tick();
		expect(lastFrame() ?? "").toContain("(empty)");
	});

	it("scrolls the detail body with the arrow, page, and g/G keys", async () => {
		// A body taller than the viewport (default test terminal is 24 rows; the
		// inspector reserves 9 rows of chrome -> ~15 visible) so scrolling moves.
		const body = Array.from({ length: 60 }, (_, i) => `row-${i}`).join("\n");
		const messages = [makeMessage({ role: "tool_result", tool_name: "cq", content: body })];
		const { lastFrame, stdin } = render(
			React.createElement(InspectorView, { messages, onClose: () => {} }),
		);
		await tick();
		stdin.write("\r"); // open detail
		await tick();
		expect(lastFrame() ?? "").toContain("row-0");

		// G jumps to the bottom: the last rows become visible, row-0 scrolls off.
		stdin.write("G");
		await tick();
		const atBottom = lastFrame() ?? "";
		expect(atBottom).toContain("row-59");
		expect(atBottom).not.toContain("row-0");
		// A "more above" indicator appears once scrolled down.
		expect(atBottom).toContain("more");

		// g returns to the top.
		stdin.write("g");
		await tick();
		expect(lastFrame() ?? "").toContain("row-0");

		// PageDown then PageUp exercises the paged branches.
		stdin.write("\x1b[6~"); // PageDown
		await tick();
		const paged = lastFrame() ?? "";
		expect(paged).not.toContain("row-0");
		stdin.write("\x1b[5~"); // PageUp
		await tick();
		expect(lastFrame() ?? "").toContain("row-0");

		// Down arrow then Up arrow exercises the single-line branches.
		stdin.write("\x1b[B"); // Down
		await tick();
		stdin.write("\x1b[A"); // Up
		await tick();
		expect(lastFrame() ?? "").toContain("row-0");
	});
});
