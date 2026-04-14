import type { MemoryGraphEdge, MemoryGraphNode } from "./api";

export interface PositionedNode {
	key: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	tier: "pinned" | "summary" | "default" | "detail";
	color: string;
	opacity: number;
	radius: number;
	source: string | null;
	/** Fractional position along the arc/band [0, 1] — used by simulation */
	arcT: number;
}

export interface PositionedEdge {
	sourceKey: string;
	targetKey: string;
	dashed: boolean;
	color: string;
	opacity: number;
}

export interface GraphLayoutResult {
	nodes: PositionedNode[];
	edges: PositionedEdge[];
	nodeMap: Map<string, PositionedNode>;
}

const TIER_RADIUS_MAP: Record<"pinned" | "summary" | "default" | "detail", number> = {
	pinned: 14,
	summary: 9,
	default: 7,
	detail: 5,
};

const TIER_COLOR_MAP: Record<"pinned" | "summary" | "default" | "detail", string> = {
	pinned: "#F39700",
	summary: "#009BBF",
	default: "#9CAEB7",
	detail: "#706B66",
};

// Tier Y-band targets (fraction of height)
const TIER_Y_FRACTION: Record<"pinned" | "summary" | "default" | "detail", number> = {
	pinned: 0.1,
	summary: 0.35,
	default: 0.58,
	detail: 0.8,
};

const ARC_CENTER = Math.PI / 2; // upward-facing arc

// Per-tier arc configuration: span (angle), radius scale, simulation strength
const TIER_ARC: Record<
	"pinned" | "summary" | "default" | "detail",
	{
		span: number;
		radiusScale: number;
		simStrength: number;
	}
> = {
	pinned: { span: Math.PI * 0.35, radiusScale: 0.45, simStrength: 0.15 },
	summary: { span: Math.PI * 0.55, radiusScale: 0.9, simStrength: 0.02 },
	default: { span: Math.PI * 0.65, radiusScale: 1.2, simStrength: 0.008 },
	detail: { span: Math.PI * 0.55, radiusScale: 1.5, simStrength: 0.004 },
};

/** Compute a point on an arc given parameter t in [0, 1] */
function arcPoint(
	t: number,
	cx: number,
	arcY: number,
	arcRadius: number,
	arcSpan: number,
): { x: number; y: number } {
	// t=0 → left, t=1 → right; smile shape (edges higher, center at baseline)
	const angle = ARC_CENTER + arcSpan / 2 - t * arcSpan;
	return {
		x: cx + arcRadius * Math.cos(angle),
		y: arcY + arcRadius * Math.sin(angle) - arcRadius,
	};
}

export function computeInitialLayout(
	nodes: MemoryGraphNode[],
	edges: MemoryGraphEdge[],
	width: number,
	height: number,
	selectedThreadId?: string | null,
): GraphLayoutResult {
	if (nodes.length === 0) {
		return { nodes: [], edges: [], nodeMap: new Map() };
	}

	const nodesByTier = new Map<"pinned" | "summary" | "default" | "detail", MemoryGraphNode[]>();
	nodesByTier.set("pinned", []);
	nodesByTier.set("summary", []);
	nodesByTier.set("default", []);
	nodesByTier.set("detail", []);

	for (const node of nodes) {
		nodesByTier.get(node.tier)?.push(node);
	}

	for (const tierNodes of nodesByTier.values()) {
		tierNodes.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	}

	const cx = width / 2;
	const positionedNodes: PositionedNode[] = [];
	const nodeMap = new Map<string, PositionedNode>();

	for (const tier of ["pinned", "summary", "default", "detail"] as const) {
		const tierNodes = nodesByTier.get(tier);
		if (!tierNodes || tierNodes.length === 0) continue;

		const maxNodes = 40;
		const nodesInTier = tierNodes.slice(0, maxNodes);
		const tierY = height * TIER_Y_FRACTION[tier];
		const tierArc = TIER_ARC[tier];
		const arcRadius = Math.min(width * tierArc.radiusScale, 300 + (tier === "pinned" ? 0 : 100));

		for (let i = 0; i < nodesInTier.length; i++) {
			const node = nodesInTier[i];
			const t = nodesInTier.length === 1 ? 0.5 : i / (nodesInTier.length - 1);
			const pt = arcPoint(t, cx, tierY, arcRadius, tierArc.span);

			let opacity = 1.0;
			if (selectedThreadId && node.source !== null) {
				opacity = node.source === selectedThreadId ? 1.0 : 0.15;
			}

			const pNode: PositionedNode = {
				key: node.key,
				x: pt.x,
				y: pt.y,
				vx: 0,
				vy: 0,
				tier,
				color: TIER_COLOR_MAP[tier],
				opacity,
				radius: TIER_RADIUS_MAP[tier],
				source: node.source,
				arcT: t,
			};
			positionedNodes.push(pNode);
			nodeMap.set(node.key, pNode);
		}
	}

	// Build edges
	const positionedEdges: PositionedEdge[] = [];
	for (const edge of edges) {
		const sourceNode = nodeMap.get(edge.sourceKey);
		const targetNode = nodeMap.get(edge.targetKey);
		if (sourceNode && targetNode) {
			positionedEdges.push({
				sourceKey: edge.sourceKey,
				targetKey: edge.targetKey,
				dashed: edge.relation === "summarizes",
				color: sourceNode.color,
				opacity: Math.min(sourceNode.opacity, targetNode.opacity),
			});
		}
	}

	return { nodes: positionedNodes, edges: positionedEdges, nodeMap };
}

export function simulationStep(
	nodes: PositionedNode[],
	edges: PositionedEdge[],
	nodeMap: Map<string, PositionedNode>,
	width: number,
	height: number,
	alpha: number,
): number {
	const cx = width / 2;

	// Damping
	for (const node of nodes) {
		node.vx *= 0.55;
		node.vy *= 0.55;
	}

	// 1. Arc attraction — each tier has its own arc with different rigidity
	for (const node of nodes) {
		const tierY = height * TIER_Y_FRACTION[node.tier];
		const tierArc = TIER_ARC[node.tier];
		const arcRadius = Math.min(width * tierArc.radiusScale, node.tier === "pinned" ? 300 : 400);
		const target = arcPoint(node.arcT, cx, tierY, arcRadius, tierArc.span);
		node.vx += (target.x - node.x) * tierArc.simStrength * alpha;
		node.vy += (target.y - node.y) * tierArc.simStrength * alpha;
	}

	// 2. Node repulsion (stronger to counteract arc clumping)
	const repulsionStrength = 1200 * alpha;
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const a = nodes[i];
			const b = nodes[j];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			let dist = Math.sqrt(dx * dx + dy * dy) || 1;
			if (dist > 250) continue;
			const minDist = a.radius + b.radius + 16;
			if (dist < minDist) dist = minDist;
			const force = repulsionStrength / (dist * dist);
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			a.vx -= fx;
			a.vy -= fy;
			b.vx += fx;
			b.vy += fy;
		}
	}

	// 3. Edge attraction (gentle — don't collapse structure)
	// Skip edges involving pinned nodes so they stay fixed on the arc
	const edgeStrength = 0.03 * alpha;
	for (const edge of edges) {
		const source = nodeMap.get(edge.sourceKey);
		const target = nodeMap.get(edge.targetKey);
		if (!source || !target) continue;
		if (source.tier === "pinned" || target.tier === "pinned") continue;
		const dx = target.x - source.x;
		const dy = target.y - source.y;
		const dist = Math.sqrt(dx * dx + dy * dy) || 1;
		if (dist < 60) continue;
		const force = (dist - 60) * edgeStrength;
		const fx = (dx / dist) * force;
		const fy = (dy / dist) * force;
		source.vx += fx;
		source.vy += fy;
		target.vx -= fx;
		target.vy -= fy;
	}

	// Apply velocities and compute energy
	let energy = 0;
	const pad = 15;
	for (const node of nodes) {
		node.x += node.vx;
		node.y += node.vy;
		node.x = Math.max(pad, Math.min(width - pad, node.x));
		node.y = Math.max(pad, Math.min(height - pad, node.y));
		energy += node.vx * node.vx + node.vy * node.vy;
	}

	return energy;
}

export function updateOpacity(
	nodes: PositionedNode[],
	edges: PositionedEdge[],
	nodeMap: Map<string, PositionedNode>,
	hoveredThreadId: string | null,
): void {
	for (const node of nodes) {
		if (!hoveredThreadId) {
			node.opacity = 1.0;
		} else if (node.source === null) {
			node.opacity = 0.4;
		} else {
			node.opacity = node.source === hoveredThreadId ? 1.0 : 0.15;
		}
	}

	for (const edge of edges) {
		const source = nodeMap.get(edge.sourceKey);
		const target = nodeMap.get(edge.targetKey);
		if (source && target) {
			edge.opacity = Math.min(source.opacity, target.opacity);
		}
	}
}
