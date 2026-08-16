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
		{ id: "run", parentId: null, node: { kind: "run", depth: 0 }, phase: "completed", seq: 1 },
		{
			id: "aux",
			parentId: "run",
			node: { kind: "tool", name: "aux:skeptic" },
			phase: "completed",
			seq: 2,
		},
		{
			id: "infer",
			parentId: "run",
			node: { kind: "inference", model: "gpt-5.6-sol" },
			phase: "failed",
			seq: 3,
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
});
