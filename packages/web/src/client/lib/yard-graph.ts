import type { YardTreeSnapshot } from "./yard-execution";

export type YardFlowKind = "run" | "tool" | "inference" | "unknown";
export type YardFlowPhase = "unknown" | "started" | "completed" | "failed";

export interface YardFlowNode {
	id: string;
	type: "yard";
	position: { x: number; y: number };
	data: {
		label: string;
		kind: YardFlowKind;
		phase: YardFlowPhase;
		summary?: string;
	};
	class?: string;
}

export interface YardFlowEdge {
	id: string;
	source: string;
	target: string;
	phase: YardFlowPhase;
	type: "smoothstep";
	animated?: boolean;
	markerEnd: { type: "arrowclosed" };
	class?: string;
}

const COLUMN_WIDTH = 238;
const ROW_HEIGHT = 112;
const ROOT_GAP = 2;

function labelFor(node: YardTreeSnapshot["nodes"][number]): string {
	switch (node.node.kind) {
		case "run":
			return node.node.depth === 0 ? "Yard run" : `Nested Yard (${node.node.depth})`;
		case "tool":
			return node.node.name;
		case "inference":
			return node.node.model;
	}
}

function kindFor(node: YardTreeSnapshot["nodes"][number]): YardFlowKind {
	if (node.node.kind === "tool" && /dynamic effect region/i.test(node.node.name)) return "unknown";
	return node.node.kind;
}

/** Maps a lifecycle snapshot to a stable, compact, cycle-safe SvelteFlow graph. */
export function yardTreeToFlow(tree: YardTreeSnapshot): {
	nodes: YardFlowNode[];
	edges: YardFlowEdge[];
} {
	const ordered = [...tree.nodes].sort(
		(a, b) => a.startSeq - b.startSeq || a.id.localeCompare(b.id),
	);
	const byId = new Map(ordered.map((node) => [node.id, node]));
	const validParents = new Map<string, string>();
	for (const node of ordered) {
		if (!node.parentId || !byId.has(node.parentId)) continue;
		const ancestors = new Set<string>([node.id]);
		let parentId: string | null = node.parentId;
		let cycle = false;
		while (parentId) {
			if (ancestors.has(parentId)) {
				cycle = true;
				break;
			}
			ancestors.add(parentId);
			parentId = byId.get(parentId)?.parentId ?? null;
		}
		if (!cycle) validParents.set(node.id, node.parentId);
	}

	const children = new Map<string, string[]>();
	for (const [id, parentId] of validParents) {
		const group = children.get(parentId) ?? [];
		group.push(id);
		children.set(parentId, group);
	}
	for (const group of children.values())
		group.sort(
			(a, b) => (byId.get(a)?.startSeq ?? 0) - (byId.get(b)?.startSeq ?? 0) || a.localeCompare(b),
		);

	const roots = ordered.filter((node) => !validParents.has(node.id)).map((node) => node.id);
	const depth = new Map<string, number>();
	const rows = new Map<string, number>();
	let nextRow = 0;
	const visit = (id: string, level: number): number => {
		if (rows.has(id)) return rows.get(id) ?? nextRow;
		depth.set(id, level);
		const childIds = children.get(id) ?? [];
		if (childIds.length === 0) {
			const row = nextRow++;
			rows.set(id, row);
			return row;
		}
		const childRows = childIds.map((childId) => visit(childId, level + 1));
		const row = ((childRows.at(0) ?? 0) + (childRows.at(-1) ?? 0)) / 2;
		rows.set(id, row);
		return row;
	};
	for (const [index, root] of roots.entries()) {
		if (index > 0) nextRow += ROOT_GAP;
		visit(root, 0);
	}
	for (const node of ordered) visit(node.id, 0);

	const nodes = ordered.map((node) => ({
		id: node.id,
		type: "yard" as const,
		position: {
			x: (depth.get(node.id) ?? 0) * COLUMN_WIDTH,
			y: (rows.get(node.id) ?? 0) * ROW_HEIGHT,
		},
		data: { label: labelFor(node), kind: kindFor(node), phase: node.phase, summary: node.summary },
		class: `yard-node yard-node-${kindFor(node)} yard-node-${node.phase}`,
	}));
	const edges = ordered.flatMap((node) => {
		const parentId = validParents.get(node.id);
		return parentId
			? [
					{
						id: `${parentId}:${node.id}`,
						source: parentId,
						target: node.id,
						phase: node.phase,
						type: "smoothstep" as const,
						animated: node.phase === "started",
						markerEnd: { type: "arrowclosed" as const },
						class: `yard-edge yard-edge-${node.phase}`,
					},
				]
			: [];
	});
	return { nodes, edges };
}
