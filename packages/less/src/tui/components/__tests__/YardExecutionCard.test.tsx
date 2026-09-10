import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { YardTreeSnapshot } from "../../hooks/useYardExecutions";
import {
	YardExecutionCard,
	computeYardRegionBudget,
	partitionLiveYards,
} from "../YardExecutionCard";

type YardNode = YardTreeSnapshot["nodes"][number];

function yardNode<T extends YardNode["node"]>(
	id: string,
	parentId: string | null,
	node: T,
	seq: number,
	overrides: Partial<YardNode> = {},
): YardNode {
	return { id, parentId, node, phase: "started", seq, startSeq: seq, ...overrides };
}

const root = yardNode("root", null, { kind: "run", depth: 0 }, 1);
const tool = (id: string, name: string, seq: number, overrides: Partial<YardNode> = {}) =>
	yardNode(id, "root", { kind: "tool", name }, seq, overrides);

function tree(nodes: YardTreeSnapshot["nodes"], programPreview?: string): YardTreeSnapshot {
	return { traceId: "trace", runId: "root", phase: "started", nodes, programPreview };
}

function frame(
	snapshot: YardTreeSnapshot,
	props: Partial<React.ComponentProps<typeof YardExecutionCard>> = {},
): string {
	return (
		render(
			React.createElement(YardExecutionCard, { tree: snapshot, running: true, ...props }),
		).lastFrame() ?? ""
	);
}

describe("YardExecutionCard program and graph accounting", () => {
	it("keeps absent, empty, six-line, and seven-line live programs exact", () => {
		const nodes = [root, tool("tool", "tool", 2)];
		const absent = frame(tree(nodes), { maxGraphRows: 20 });
		const empty = frame(tree(nodes, ""), { maxGraphRows: 20 });
		const six = frame(tree(nodes, "a\nb\nc\nd\ne\nf"), { maxGraphRows: 20 });
		const seven = frame(tree(nodes, "a\nb\nc\nd\ne\nf\ng"), { maxGraphRows: 20 });
		expect(empty).toBe(absent);
		expect(six).toContain("f");
		expect(six).not.toContain("more lines");
		expect(seven).toContain("… +1 more lines");
		for (const output of [absent, empty, six, seven]) expect(output).toContain("◌ tool");
	});

	it("preserves live depth-first rows, threshold packing, failure details, and exhausted-budget elision", () => {
		const nodes: YardTreeSnapshot["nodes"] = [
			root,
			yardNode("nested", "root", { kind: "run", depth: 1 }, 2),
			yardNode("inside", "nested", { kind: "tool", name: "inside" }, 3),
			...Array.from({ length: 3 }, (_, i) =>
				tool(
					`same-${i}`,
					"same",
					i + 4,
					i === 1 ? { phase: "failed", summary: "failed member" } : {},
				),
			),
			tool("other", "other", 7),
		];
		const full = frame(tree(nodes));
		expect(full.indexOf("run · depth 1")).toBeLessThan(full.indexOf("inside"));
		expect(full).toContain("same ×3 ◌✗◌");
		expect(full).toContain("✗ #2 · failed member");

		const capped = frame(tree(nodes, "a\nb\nc\nd\ne\nf\ng"), { maxGraphRows: 1 });
		expect(capped).toContain("… +");
		expect(capped).toContain("more effects");
	});
});

describe("computeYardRegionBudget", () => {
	it("reserves fixed dynamic-region chrome from the terminal height", () => {
		// termRows - DYNAMIC_CHROME_ROWS(5) - SAFETY_ROWS(1).
		expect(computeYardRegionBudget(40)).toBe(34);
		expect(computeYardRegionBudget(20)).toBe(14);
	});

	it("never drops below one card's floor on a tiny terminal", () => {
		expect(computeYardRegionBudget(4)).toBe(3);
		expect(computeYardRegionBudget(0)).toBe(3);
	});
});

describe("partitionLiveYards", () => {
	const yards = ["a", "b", "c", "d", "e"];

	it("renders every card fully when they all fit the budget", () => {
		const { visible, collapsedCount } = partitionLiveYards(yards.slice(0, 2), 0, 40);
		expect(visible).toEqual(["a", "b"]);
		expect(collapsedCount).toBe(0);
	});

	it("leaves a single live yard unchanged with the whole card budget", () => {
		// One card, no collapse, and its per-card graph clamp equals the whole
		// card budget — visually identical to the pre-#263 lone-card path.
		const { visible, collapsedCount, maxGraphRows } = partitionLiveYards(["only"], 0, 30);
		expect(visible).toEqual(["only"]);
		expect(collapsedCount).toBe(0);
		expect(maxGraphRows).toBe(30);
	});

	it("collapses the oldest cards and keeps the newest when the budget is exceeded", () => {
		// budget 10, floor 3/card → after reserving 1 collapse row, (10-1)/3 = 3
		// cards fit; the newest three survive, the oldest two collapse.
		const { visible, collapsedCount } = partitionLiveYards(yards, 0, 10);
		expect(visible).toEqual(["c", "d", "e"]);
		expect(collapsedCount).toBe(2);
	});

	it("charges indicator lines against the shared budget before cards", () => {
		// budget 10 minus 2 indicator rows = 8 card rows; (8-1)/3 = 2 cards fit.
		const { visible, collapsedCount } = partitionLiveYards(yards, 2, 10);
		expect(visible).toEqual(["d", "e"]);
		expect(collapsedCount).toBe(3);
	});

	it("never hides every run and keeps the region within budget", () => {
		// Pathologically small budget: still show one card, collapse the rest,
		// and the rendered height (1 card floor + 1 collapse row) stays <= budget.
		const { visible, collapsedCount, maxGraphRows } = partitionLiveYards(yards, 0, 3);
		expect(visible.length).toBe(1);
		expect(collapsedCount).toBe(4);
		expect(maxGraphRows).toBeGreaterThanOrEqual(1);
	});
});
