import type { YardTreeSnapshot } from "./yard-execution";

export interface YardFlowNode {
	id: string;
	position: { x: number; y: number };
	data: { label: string; phase: "unknown" | "started" | "completed" | "failed"; summary?: string };
	class?: string;
}

export interface YardFlowEdge {
	id: string;
	source: string;
	target: string;
	animated?: boolean;
	class?: string;
}

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

/** Maps a lifecycle snapshot to a stable, compact, cycle-safe SvelteFlow graph. */
export function yardTreeToFlow(tree: YardTreeSnapshot): {
	nodes: YardFlowNode[];
	edges: YardFlowEdge[];
} {
	const ordered = [...tree.nodes].sort((a, b) => a.startSeq - b.startSeq);
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
	const depth = new Map<string, number>();
	const rows = new Map<string, number>();
	let nextRow = 0;
	const visit = (id: string, level: number): void => {
		if (depth.has(id)) return;
		depth.set(id, level);
		rows.set(id, nextRow++);
		for (const childId of children.get(id) ?? []) visit(childId, level + 1);
	};
	for (const node of ordered) if (!validParents.has(node.id)) visit(node.id, 0);
	for (const node of ordered) visit(node.id, 0);

	const nodes = ordered.map((node) => ({
		id: node.id,
		type: "yard",
		position: { x: (depth.get(node.id) ?? 0) * 230, y: (rows.get(node.id) ?? 0) * 108 },
		data: { label: labelFor(node), phase: node.phase, summary: node.summary },
		class: `yard-node yard-node-${node.phase}`,
	}));
	const edges = ordered.flatMap((node) => {
		const parentId = validParents.get(node.id);
		return parentId
			? [
					{
						id: `${parentId}:${node.id}`,
						source: parentId,
						target: node.id,
						animated: node.phase === "started",
						class: `yard-edge yard-edge-${node.phase}`,
					},
				]
			: [];
	});
	return { nodes, edges };
}
