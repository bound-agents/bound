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

	// Durations ride the lifecycle events' started_at/finished_at instants and
	// render with MessageBlock's magnitude grading, so a slow effect pops out
	// of a wall of green rows. The header carries the whole run's elapsed on
	// the committed card.
	it("renders per-node and whole-run durations from lifecycle instants", () => {
		const timed: YardTreeSnapshot = {
			...tree,
			startedAt: "2026-08-16T18:22:20.000Z",
			finishedAt: "2026-08-16T18:24:47.000Z",
			nodes: tree.nodes.map((node) =>
				node.id === "aux"
					? {
							...node,
							startedAt: "2026-08-16T18:22:20.100Z",
							finishedAt: "2026-08-16T18:24:31.000Z",
						}
					: node,
			),
		};
		const { lastFrame } = render(React.createElement(YardExecutionCard, { tree: timed }));
		const frame = lastFrame() ?? "";
		// Whole-run elapsed on the header (2m 27s).
		expect(frame).toContain("2 effects · 2m 27s");
		// Per-node elapsed on the aux row (2m 10.9s → "2m 11s").
		expect(frame).toContain("aux:skeptic · 2m 11s");
		// Nodes without both instants render no duration fragment.
		expect(frame).toContain("infer · gpt-5.6-sol · provider error");
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

	// Dense fan-out packing (thread febfe45e, 2026-08-16): scatter-gather
	// runs dispatch the same aux specialist across dozens of partitions; one
	// row per member grew the live card past the terminal and flickered.
	// Same-label leaf siblings ≥ 3 pack into ONE row: `label ×N` plus a
	// per-member glyph cluster in dispatch order. Failed members keep an
	// indexed detail row so the dense form never hides a failure reason.
	it("packs same-label leaf siblings into a dense group row", () => {
		const fanout: YardTreeSnapshot = {
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
				...Array.from({ length: 6 }, (_, i) => ({
					id: `scout-${i}`,
					parentId: "root",
					node: { kind: "tool", name: "aux:test-matrix-scout" } as const,
					phase: (i === 2 ? "failed" : i < 4 ? "completed" : "started") as
						| "failed"
						| "completed"
						| "started",
					seq: 2 + i,
					startSeq: 2 + i,
					...(i === 2 ? { summary: "aux failed: lint errors" } : {}),
				})),
				{
					id: "gather",
					parentId: "root",
					node: { kind: "inference", model: "gpt-5.6-terra" },
					phase: "started",
					seq: 8,
					startSeq: 8,
				},
			],
		};
		const { lastFrame } = render(
			React.createElement(YardExecutionCard, { tree: fanout, running: true, terminalColumns: 100 }),
		);
		const frame = lastFrame() ?? "";
		const rows = frame.split("\n");

		// One dense row for all six scouts: label ×6 + glyph cluster.
		const groupRow = rows.find((row) => row.includes("×6"));
		expect(groupRow).toBeDefined();
		expect(groupRow).toContain("aux:test-matrix-scout");
		// Glyph cluster carries per-member state in dispatch order:
		// 2 done, 1 failed, 1 done, 2 running.
		expect(groupRow).toContain("✓✓✗✓◌◌");
		// The failed member gets an indexed detail row with its summary.
		const failRow = rows.find((row) => row.includes("#3"));
		expect(failRow).toBeDefined();
		expect(failRow).toContain("aux failed: lint errors");
		// No per-member rows beyond the group + fail detail.
		expect(rows.filter((row) => row.includes("aux:test-matrix-scout")).length).toBe(1);
		// The lone inference leaf stays an individual row.
		expect(frame).toContain("infer · gpt-5.6-terra");
		// Header counts every member.
		expect(frame).toContain("7 effects");
	});

	// Live-card height guard (thread febfe45e): enough aux nodes made the
	// dynamic region exceed terminal height and Ink flickered on every
	// repaint. Past maxGraphRows the graph collapses into "… +N more".
	// Committed cards ignore the budget (Static scrollback).
	it("caps live graph rows at maxGraphRows with an overflow line", () => {
		const many: YardTreeSnapshot = {
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
				// Distinct labels so grouping cannot absorb them.
				...Array.from({ length: 12 }, (_, i) => ({
					id: `eff-${i}`,
					parentId: "root",
					node: { kind: "tool", name: `tool-${i}` } as const,
					phase: "started" as const,
					seq: 2 + i,
					startSeq: 2 + i,
				})),
			],
		};
		const live = render(
			React.createElement(YardExecutionCard, {
				tree: many,
				running: true,
				terminalColumns: 100,
				maxGraphRows: 5,
			}),
		);
		const liveFrame = live.lastFrame() ?? "";
		// 4 kept rows + 1 overflow line.
		expect(liveFrame).toContain("tool-3");
		expect(liveFrame).not.toContain("tool-4");
		expect(liveFrame).toContain("+8 more effects");

		// Committed card ignores the budget entirely.
		const committed = render(
			React.createElement(YardExecutionCard, {
				tree: { ...many, phase: "completed" },
				terminalColumns: 100,
				maxGraphRows: 5,
			}),
		);
		const committedFrame = committed.lastFrame() ?? "";
		expect(committedFrame).toContain("tool-11");
		expect(committedFrame).not.toContain("more effects");
	});
});
