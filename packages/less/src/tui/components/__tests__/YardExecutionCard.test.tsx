import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { YardTreeSnapshot } from "../../hooks/useYardExecutions";
import { YardExecutionCard } from "../YardExecutionCard";

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
