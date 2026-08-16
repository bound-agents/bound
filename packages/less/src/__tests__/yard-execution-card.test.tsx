import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { YardExecutionCard } from "../tui/components/YardExecutionCard";
import type { YardTreeSnapshot } from "../tui/hooks/useYardExecutions";

const tree: YardTreeSnapshot = {
	traceId: "trace",
	runId: "run",
	phase: "completed",
	inputPreview: '{"query":"yard"}',
	resultPreview: '{"matches":3}',
	summary: "2 tools · 0 inferences",
	nodes: [
		{
			id: "run",
			parentId: null,
			node: { kind: "run", depth: 0 },
			phase: "completed",
			seq: 1,
			startSeq: 1,
		},
		{
			id: "aux",
			parentId: "run",
			node: { kind: "tool", name: "aux:skeptic" },
			phase: "completed",
			seq: 2,
			startSeq: 2,
		},
		{
			id: "infer",
			parentId: "run",
			node: { kind: "inference", model: "gpt-5.6-sol" },
			phase: "failed",
			seq: 3,
			startSeq: 3,
			summary: "provider error",
		},
	],
};

describe("YardExecutionCard", () => {
	it("renders running execution state and concatenated aux/inference leaves", () => {
		const { lastFrame } = render(React.createElement(YardExecutionCard, { tree, running: true }));
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Yard · running · 2 effects");
		expect(frame).toContain("aux:skeptic");
		expect(frame).toContain("infer · gpt-5.6-sol");
		expect(frame).not.toContain("result ·");
	});

	it("renders completed input, graph, and final result", () => {
		const { lastFrame } = render(React.createElement(YardExecutionCard, { tree }));
		const frame = lastFrame() ?? "";
		expect(frame).toContain('input · {"query":"yard"}');
		expect(frame).toContain("✓ aux:skeptic");
		expect(frame).toContain("✗ infer · gpt-5.6-sol · provider error");
		expect(frame).toContain('result · {"matches":3}');
	});

	// The card renders the EXECUTION GRAPH, not a flat leaf list (#217's
	// original intent). Children hang off their parent with box-drawing
	// branches; a nested yard() run is an interior node whose subtree
	// indents under it; concurrent effects read as siblings.
	it("renders parent-child structure with branch glyphs and nested-run subtrees", () => {
		const nested: YardTreeSnapshot = {
			traceId: "trace",
			runId: "root",
			phase: "started",
			nodes: [
				{
					id: "root",
					parentId: null,
					node: { kind: "run", depth: 0 },
					phase: "started",
					seq: 1,
					startSeq: 1,
				},
				{
					id: "eff-a",
					parentId: "root",
					node: { kind: "tool", name: "boundless_search" },
					phase: "completed",
					seq: 2,
					startSeq: 2,
				},
				{
					id: "eff-yard",
					parentId: "root",
					node: { kind: "tool", name: "yard" },
					phase: "started",
					seq: 3,
					startSeq: 3,
				},
				{
					id: "run-2",
					parentId: "eff-yard",
					node: { kind: "run", depth: 1 },
					phase: "started",
					seq: 4,
					startSeq: 4,
				},
				{
					id: "eff-inner",
					parentId: "run-2",
					node: { kind: "inference", model: "glm-5" },
					phase: "started",
					seq: 5,
					startSeq: 5,
				},
			],
		};
		const { lastFrame } = render(
			React.createElement(YardExecutionCard, { tree: nested, running: true }),
		);
		const frame = lastFrame() ?? "";
		const rows = frame.split("\n");

		// Sibling effects under the root: first gets ├─, last gets └─.
		const searchRow = rows.find((row) => row.includes("boundless_search"));
		const yardRow = rows.find((row) => row.includes("◌ yard"));
		expect(searchRow).toContain("├─");
		expect(yardRow).toContain("└─");

		// The nested run renders as an interior node under the yard effect,
		// and its child indents one level deeper than the yard effect row.
		const runRow = rows.find((row) => row.includes("run · depth 1"));
		const innerRow = rows.find((row) => row.includes("infer · glm-5"));
		expect(runRow).toBeDefined();
		expect(innerRow).toBeDefined();
		const indentOf = (row: string): number => row.indexOf("└─");
		expect(indentOf(innerRow ?? "")).toBeGreaterThan(indentOf(yardRow ?? ""));

		// Interior run nodes don't count as effects.
		expect(frame).toContain("3 effects");
	});

	// Regression (thread adb65d85, 2026-08-16): yard.ts's preview() ships up to
	// 4,000 chars INCLUDING newlines in input_preview/result_preview. Rendering
	// them raw made the LIVE card taller than the terminal and corrupted the
	// Ink repaint. The live (running) card must clamp every preview to one
	// bounded line — the committed card is exempt (it renders once into
	// <Static> scrollback, where height is harmless).
	it("clamps previews to a single bounded line while running", () => {
		const noisy: YardTreeSnapshot = {
			...tree,
			phase: "started",
			inputPreview: `{\n  "sql": "SELECT 1",\n  "path": "a/b"\n}`,
			resultPreview: `line one\n… truncated 90000 chars …\n${"x".repeat(3000)}`,
			nodes: [
				...tree.nodes,
				{
					id: "noisy-leaf",
					parentId: "run",
					node: { kind: "tool", name: "boundless_bash" },
					phase: "completed",
					seq: 4,
					startSeq: 4,
					summary: "multi\nline\nsummary",
				},
			],
		};
		const { lastFrame } = render(
			React.createElement(YardExecutionCard, { tree: noisy, running: true }),
		);
		const frame = lastFrame() ?? "";

		// Newlines in previews/summaries must not survive into the frame as
		// extra rows: the live card's height must stay bounded by its node
		// count (header + input + 4 leaves + 2 border rows).
		const rows = frame.split("\n");
		expect(rows.length).toBeLessThanOrEqual(9);

		// No row may exceed a sane single-line width (border + padding + clamp).
		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(220);
		}

		// The clamped input still shows its head so the card stays informative.
		expect(frame).toContain('"sql": "SELECT 1"');
	});

	// Complaint (thread f1373e45, 2026-08-16): "it heavily truncates things".
	// The committed card renders ONCE into <Static> scrollback — tall content
	// there is harmless (message blocks are tall all the time), so the full
	// input and result previews must survive, wrapped, not elided to 160
	// chars. Leaf summaries stay clamped (the full content lives in the
	// persisted yard rows).
	it("renders full input and result previews on the committed card", () => {
		const detailed: YardTreeSnapshot = {
			...tree,
			inputPreview: `{\n  "cwd": "/repo",\n  "model": "gpt-5.6-terra"\n}`,
			resultPreview: `{"work":"first-line\nsecond-line ${"y".repeat(400)}"}`,
		};
		const { lastFrame } = render(React.createElement(YardExecutionCard, { tree: detailed }));
		const frame = lastFrame() ?? "";

		// Multi-line input survives intact.
		expect(frame).toContain('"model": "gpt-5.6-terra"');
		// The whole result body reaches the frame (wrapped, never elided) —
		// count the payload chars rather than matching a token that hard-wrap
		// could split across rows.
		expect((frame.match(/y/g) ?? []).length).toBeGreaterThanOrEqual(400);
		expect(frame).toContain("first-line");
	});

	// Regression (screenshot, 2026-08-16): the bespoke rounded-border Box had
	// no explicit width, so Yoga sized it to intrinsic content width and the
	// terminal soft-wrapped the overflow at column 0 — shattering the border.
	// The card now uses the SAME wrapper as message/alert turns (StripeBox:
	// left stripe + explicit width), whose whole contract is that content
	// wraps INSIDE the stripe. Pin that: every rendered row fits the column
	// budget, the stripe glyph is present, and no rounded-border chrome
	// remains.
	it("wraps long committed previews inside the stripe at the given width", () => {
		const detailed: YardTreeSnapshot = {
			...tree,
			resultPreview: `{"work":"${"z".repeat(300)}"}`,
		};
		const { lastFrame } = render(
			React.createElement(YardExecutionCard, { tree: detailed, terminalColumns: 60 }),
		);
		const frame = lastFrame() ?? "";
		const rows = frame.split("\n");

		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(60);
		}
		// Full payload survived the wrap.
		expect((frame.match(/z/g) ?? []).length).toBeGreaterThanOrEqual(300);
		// Stripe wrapper, not a rounded border.
		expect(frame).toContain("│");
		expect(frame).not.toContain("╭");
		expect(frame).not.toContain("╰");
	});
});
