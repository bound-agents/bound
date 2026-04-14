import type { MemoryGraphEdge, MemoryGraphNode } from "./api";
import { getLineColor } from "./metro-lines";

export interface PositionedNode {
	key: string;
	x: number;
	y: number;
	tier: "pinned" | "summary" | "default" | "detail";
	color: string;
	opacity: number;
	radius: number;
}

export interface PositionedEdge {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	dashed: boolean;
	color: string;
	opacity: number;
}

export interface GraphLayoutResult {
	positionedNodes: PositionedNode[];
	positionedEdges: PositionedEdge[];
}

const TIER_Y_POSITIONS: Record<"pinned" | "summary" | "default" | "detail", number> = {
	pinned: 40,
	summary: 160,
	default: 280,
	detail: 360,
};

const TIER_RADIUS: Record<"pinned" | "summary" | "default" | "detail", number> = {
	pinned: 12,
	summary: 8,
	default: 6,
	detail: 4,
};

const MIN_SPACING = 60;

export function computeGraphLayout(
	nodes: MemoryGraphNode[],
	edges: MemoryGraphEdge[],
	canvasWidth: number,
	selectedThreadId?: string | null,
): GraphLayoutResult {
	if (nodes.length === 0) {
		return {
			positionedNodes: [],
			positionedEdges: [],
		};
	}

	const nodesByTier = new Map<"pinned" | "summary" | "default" | "detail", MemoryGraphNode[]>();
	nodesByTier.set("pinned", []);
	nodesByTier.set("summary", []);
	nodesByTier.set("default", []);
	nodesByTier.set("detail", []);

	for (const node of nodes) {
		const tier = node.tier;
		const tierNodes = nodesByTier.get(tier);
		if (tierNodes) {
			tierNodes.push(node);
		}
	}

	// Sort each tier by modifiedAt descending
	for (const tierNodes of nodesByTier.values()) {
		tierNodes.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	}

	// Build positioned nodes
	const positionedNodesMap = new Map<string, PositionedNode>();

	for (const tier of ["pinned", "summary", "default", "detail"] as const) {
		const tierNodes = nodesByTier.get(tier);
		if (!tierNodes || tierNodes.length === 0) continue;

		// Skip detail tier if not selected
		if (tier === "detail" && !selectedThreadId) continue;

		const nodeCount = Math.min(tierNodes.length, 20);
		const nodesInTier = tierNodes.slice(0, nodeCount);

		// Calculate spacing
		const spacing =
			nodesInTier.length > 1
				? Math.max(MIN_SPACING, canvasWidth / Math.max(1, nodesInTier.length - 1))
				: MIN_SPACING;

		const totalWidth = nodesInTier.length === 1 ? 0 : (nodesInTier.length - 1) * spacing;
		const startX = (canvasWidth - totalWidth) / 2;

		for (let i = 0; i < nodesInTier.length; i++) {
			const node = nodesInTier[i];
			const x = startX + i * spacing;
			const y = TIER_Y_POSITIONS[tier];
			const radius = TIER_RADIUS[tier];

			// Determine opacity
			let opacity = 1.0;
			if (selectedThreadId && node.source !== null) {
				// Compare against thread ID directly
				opacity = node.source === selectedThreadId ? 1.0 : 0.2;
			}

			positionedNodesMap.set(node.key, {
				key: node.key,
				x,
				y,
				tier,
				color: node.lineIndex !== null ? getLineColor(node.lineIndex) : "var(--text-muted)",
				opacity,
				radius,
			});
		}
	}

	const positionedNodes = Array.from(positionedNodesMap.values());

	// Build positioned edges
	const positionedEdges: PositionedEdge[] = [];
	const sourceNodeMap = new Map<string, MemoryGraphNode>();
	for (const node of nodes) {
		sourceNodeMap.set(node.key, node);
	}

	for (const edge of edges) {
		const sourceNode = positionedNodesMap.get(edge.sourceKey);
		const targetNode = positionedNodesMap.get(edge.targetKey);

		// Only render edges where both nodes are positioned
		if (sourceNode && targetNode) {
			const sourceData = sourceNodeMap.get(edge.sourceKey);
			const opacity =
				selectedThreadId && sourceData && sourceData.lineIndex !== null ? sourceNode.opacity : 1.0;

			positionedEdges.push({
				x1: sourceNode.x,
				y1: sourceNode.y,
				x2: targetNode.x,
				y2: targetNode.y,
				dashed: edge.relation === "summarizes",
				color: sourceNode.color,
				opacity,
			});
		}
	}

	return {
		positionedNodes,
		positionedEdges,
	};
}
