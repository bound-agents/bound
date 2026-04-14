import { describe, expect, it } from "bun:test";
import type { MemoryGraphEdge, MemoryGraphNode } from "../api";
import { computeGraphLayout } from "../graph-layout";

describe("computeGraphLayout", () => {
	describe("empty input", () => {
		it("returns empty arrays when input nodes are empty", () => {
			const result = computeGraphLayout([], [], 500);
			expect(result.positionedNodes).toEqual([]);
			expect(result.positionedEdges).toEqual([]);
		});
	});

	describe("node tier positioning", () => {
		it("assigns Y position by tier", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "pinned-1",
					value: "value",
					tier: "pinned",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "summary-1",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "default-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const pinnedNode = result.positionedNodes.find((n) => n.key === "pinned-1");
			const summaryNode = result.positionedNodes.find((n) => n.key === "summary-1");
			const defaultNode = result.positionedNodes.find((n) => n.key === "default-1");

			expect(pinnedNode?.y).toBe(40);
			expect(summaryNode?.y).toBe(160);
			expect(defaultNode?.y).toBe(280);
		});

		it("assigns detail nodes Y=360", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "detail-1",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500, "thread-1");
			const detailNode = result.positionedNodes.find((n) => n.key === "detail-1");
			expect(detailNode?.y).toBe(360);
		});
	});

	describe("node spacing", () => {
		it("spaces nodes at least 60px apart in same tier", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(Date.now() - 1000).toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const node1 = result.positionedNodes.find((n) => n.key === "node-1");
			const node2 = result.positionedNodes.find((n) => n.key === "node-2");

			expect(node1 && node2).toBeTruthy();
			const distance = Math.abs((node1?.x ?? 0) - (node2?.x ?? 0));
			expect(distance).toBeGreaterThanOrEqual(60);
		});

		it("centers nodes horizontally when single node in tier", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "single",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const node = result.positionedNodes.find((n) => n.key === "single");
			expect(node?.x).toBe(250); // 500 / 2
		});

		it("distributes multiple nodes evenly across canvas", () => {
			const nodes: MemoryGraphNode[] = [];
			for (let i = 0; i < 5; i++) {
				nodes.push({
					key: `node-${i}`,
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(Date.now() - i * 1000).toISOString(),
				});
			}

			const result = computeGraphLayout(nodes, [], 500);
			const xPositions = result.positionedNodes.map((n) => n.x).sort((a, b) => a - b);

			// Check all positions are within canvas
			for (const x of xPositions) {
				expect(x).toBeGreaterThanOrEqual(0);
				expect(x).toBeLessThanOrEqual(500);
			}

			// Check spacing is consistent
			const gaps = [];
			for (let i = 1; i < xPositions.length; i++) {
				gaps.push(xPositions[i] - xPositions[i - 1]);
			}

			for (const gap of gaps) {
				expect(gap).toBeGreaterThanOrEqual(60);
			}
		});
	});

	describe("node sorting and limiting", () => {
		it("sorts nodes within tier by modifiedAt descending", () => {
			const now = new Date();
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-old",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(now.getTime() - 3000).toISOString(),
				},
				{
					key: "node-new",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(now.getTime() - 1000).toISOString(),
				},
				{
					key: "node-newest",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: now.toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const positions = result.positionedNodes;

			expect(positions[0].key).toBe("node-newest");
			expect(positions[1].key).toBe("node-new");
			expect(positions[2].key).toBe("node-old");
		});

		it("limits each tier to 20 nodes max", () => {
			const nodes: MemoryGraphNode[] = [];
			for (let i = 0; i < 30; i++) {
				nodes.push({
					key: `node-${i}`,
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(Date.now() - i * 1000).toISOString(),
				});
			}

			const result = computeGraphLayout(nodes, [], 500);
			const defaultNodes = result.positionedNodes.filter((n) => n.tier === "default");
			expect(defaultNodes).toHaveLength(20);
		});
	});

	describe("node radius by tier", () => {
		it("assigns correct radius based on tier", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "pinned",
					value: "value",
					tier: "pinned",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "summary",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "default",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "detail",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500, "thread-1");

			expect(result.positionedNodes.find((n) => n.key === "pinned")?.radius).toBe(12);
			expect(result.positionedNodes.find((n) => n.key === "summary")?.radius).toBe(8);
			expect(result.positionedNodes.find((n) => n.key === "default")?.radius).toBe(6);
			expect(result.positionedNodes.find((n) => n.key === "detail")?.radius).toBe(4);
		});
	});

	describe("detail node visibility", () => {
		it("excludes detail nodes when selectedThreadId is not set", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "detail-1",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const detailNodes = result.positionedNodes.filter((n) => n.tier === "detail");
			expect(detailNodes).toHaveLength(0);
		});

		it("includes detail nodes when selectedThreadId is set", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "summary-1",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "detail-1",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500, "thread-1");
			const detailNodes = result.positionedNodes.filter((n) => n.tier === "detail");
			expect(detailNodes).toHaveLength(1);
		});
	});

	describe("opacity with selectedThreadId", () => {
		it("sets opacity to 1.0 for all nodes when selectedThreadId is not set", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 1,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);

			for (const node of result.positionedNodes) {
				expect(node.opacity).toBe(1.0);
			}
		});

		it("sets opacity to 1.0 for nodes matching selectedThreadId, 0.2 for others", () => {
			const selectedThreadUuid = "thread-uuid-123";
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: selectedThreadUuid,
					sourceThreadTitle: null,
					lineIndex: 2,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: "other-thread-uuid",
					sourceThreadTitle: null,
					lineIndex: 3,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500, selectedThreadUuid);

			const node1 = result.positionedNodes.find((n) => n.key === "node-1");
			const node2 = result.positionedNodes.find((n) => n.key === "node-2");

			expect(node1?.opacity).toBe(1.0);
			expect(node2?.opacity).toBe(0.2);
		});

		it("preserves 1.0 opacity for nodes with null lineIndex", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-no-index",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: null,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500, "thread-1");
			const node = result.positionedNodes.find((n) => n.key === "node-no-index");
			expect(node?.opacity).toBe(1.0);
		});
	});

	describe("edge rendering", () => {
		it("renders edges only for nodes that are positioned", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "node-2",
					relation: "connects",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, edges, 500);
			expect(result.positionedEdges).toHaveLength(1);
		});

		it("skips edges with missing nodes", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "missing-node",
					relation: "connects",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, edges, 500);
			expect(result.positionedEdges).toHaveLength(0);
		});

		it("marks summarizes relation edges as dashed", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "node-2",
					relation: "summarizes",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, edges, 500, "thread-1");
			const edge = result.positionedEdges[0];
			expect(edge?.dashed).toBe(true);
		});

		it("marks non-summarizes edges as solid", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "node-2",
					relation: "related",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, edges, 500);
			const edge = result.positionedEdges[0];
			expect(edge?.dashed).toBe(false);
		});

		it("connects edges between correct node positions", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(Date.now() - 1000).toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "node-2",
					relation: "connects",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, edges, 500);
			const edge = result.positionedEdges[0];
			const sourceNode = result.positionedNodes.find((n) => n.key === "node-1");
			const targetNode = result.positionedNodes.find((n) => n.key === "node-2");

			expect(edge?.x1).toBe(sourceNode?.x);
			expect(edge?.y1).toBe(sourceNode?.y);
			expect(edge?.x2).toBe(targetNode?.x);
			expect(edge?.y2).toBe(targetNode?.y);
		});
	});

	describe("node color assignment", () => {
		it("assigns color based on lineIndex", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const node = result.positionedNodes[0];
			expect(node?.color).toBe("#F39700"); // Line G (Ginza)
		});

		it("uses muted color when lineIndex is null", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: null,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeGraphLayout(nodes, [], 500);
			const node = result.positionedNodes[0];
			expect(node?.color).toBe("var(--text-muted)");
		});
	});
});
