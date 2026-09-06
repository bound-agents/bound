import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { YardTreeSnapshot } from "../../hooks/useYardExecutions";
import { YardExecutionCard } from "../YardExecutionCard";

const root = {
	id: "root",
	parentId: null,
	node: { kind: "run", depth: 0 } as const,
	phase: "started" as const,
	seq: 1,
	startSeq: 1,
};

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
		const nodes = [
			root,
			{
				id: "tool",
				parentId: "root",
				node: { kind: "tool", name: "tool" } as const,
				phase: "started" as const,
				seq: 2,
				startSeq: 2,
			},
		];
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
			{
				id: "nested",
				parentId: "root",
				node: { kind: "run", depth: 1 },
				phase: "started",
				seq: 2,
				startSeq: 2,
			},
			{
				id: "inside",
				parentId: "nested",
				node: { kind: "tool", name: "inside" },
				phase: "started",
				seq: 3,
				startSeq: 3,
			},
			...Array.from({ length: 3 }, (_, i) => ({
				id: `same-${i}`,
				parentId: "root",
				node: { kind: "tool", name: "same" } as const,
				phase: (i === 1 ? "failed" : "started") as "started" | "failed",
				seq: i + 4,
				startSeq: i + 4,
				...(i === 1 ? { summary: "failed member" } : {}),
			})),
			{
				id: "other",
				parentId: "root",
				node: { kind: "tool", name: "other" },
				phase: "started",
				seq: 7,
				startSeq: 7,
			},
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
