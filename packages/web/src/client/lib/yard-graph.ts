import type { YardTreeSnapshot } from "./yard-execution";
import { formatYardResult } from "./yard-result";

export type YardFlowKind = "run" | "tool" | "inference" | "aux" | "unknown" | "result";
export type YardFlowPhase = "unknown" | "started" | "completed" | "failed" | "settled";
export interface YardFlowData {
	label: string;
	kind: YardFlowKind;
	phase: YardFlowPhase;
	summary?: string;
	detail?: Record<string, unknown>;
}
export interface YardFlowNode {
	id: string;
	type: "yard";
	position: { x: number; y: number };
	data: YardFlowData;
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
function labelFor(node: YardTreeSnapshot["nodes"][number]) {
	if (node.node.kind === "run")
		return node.node.depth === 0 ? "Yard run" : `Nested Yard (${node.node.depth})`;
	return node.node.kind === "tool" ? node.node.name : node.node.model;
}
function kindFor(node: YardTreeSnapshot["nodes"][number]): YardFlowKind {
	if (node.node.kind !== "tool") return node.node.kind;
	if (/dynamic effect region/i.test(node.node.name)) return "unknown";
	return node.node.name.startsWith("aux:") ? "aux" : "tool";
}
function edge(source: string, target: string, phase: YardFlowPhase): YardFlowEdge {
	return {
		id: `${source}:${target}`,
		source,
		target,
		phase,
		type: "smoothstep",
		animated: phase === "started",
		markerEnd: { type: "arrowclosed" },
		class: `yard-edge yard-edge-${phase}`,
	};
}
/** Maps a lifecycle snapshot to a stable, compact, cycle-safe SvelteFlow graph. */
export function yardTreeToFlow(tree: YardTreeSnapshot): {
	nodes: YardFlowNode[];
	edges: YardFlowEdge[];
} {
	const ordered = [...tree.nodes].sort(
		(a, b) => a.startSeq - b.startSeq || a.id.localeCompare(b.id),
	);
	const byId = new Map(ordered.map((n) => [n.id, n]));
	const parents = new Map<string, string>();
	for (const node of ordered) {
		if (!node.parentId || !byId.has(node.parentId)) continue;
		const seen = new Set([node.id]);
		let p: string | null = node.parentId;
		let cyclic = false;
		while (p) {
			if (seen.has(p)) {
				cyclic = true;
				break;
			}
			seen.add(p);
			p = byId.get(p)?.parentId ?? null;
		}
		if (!cyclic) parents.set(node.id, node.parentId);
	}
	const children = new Map<string, string[]>();
	for (const [id, p] of parents) {
		const a = children.get(p) ?? [];
		a.push(id);
		children.set(p, a);
	}
	for (const a of children.values())
		a.sort(
			(a, b) => (byId.get(a)?.startSeq ?? 0) - (byId.get(b)?.startSeq ?? 0) || a.localeCompare(b),
		);
	const roots = ordered.filter((n) => !parents.has(n.id)).map((n) => n.id);
	const depth = new Map<string, number>();
	const rows = new Map<string, number>();
	let next = 0;
	const visit = (id: string, level: number): number => {
		const existingRow = rows.get(id);
		if (existingRow !== undefined) return existingRow;
		depth.set(id, level);
		const kids = children.get(id) ?? [];
		if (!kids.length) {
			const row = next++;
			rows.set(id, row);
			return row;
		}
		const r = kids.map((k) => visit(k, level + 1));
		const row = ((r[0] ?? 0) + (r.at(-1) ?? 0)) / 2;
		rows.set(id, row);
		return row;
	};
	roots.forEach((r, i) => {
		if (i) next += ROOT_GAP;
		visit(r, 0);
	});
	for (const node of ordered) visit(node.id, 0);
	const nodes = ordered.map((node) => ({
		id: node.id,
		type: "yard" as const,
		position: {
			x: (depth.get(node.id) ?? 0) * COLUMN_WIDTH,
			y: (rows.get(node.id) ?? 0) * ROW_HEIGHT,
		},
		data: {
			label: labelFor(node),
			kind: kindFor(node),
			phase: node.phase,
			summary: node.summary,
			detail: node.detail,
		},
		class: `yard-node yard-node-${kindFor(node)} yard-node-${node.phase}`,
	}));
	const edges = ordered.flatMap((n) => {
		const p = parents.get(n.id);
		return p ? [edge(p, n.id, n.phase)] : [];
	});
	const leafIds = ordered.filter((n) => !children.get(n.id)?.length).map((n) => n.id);
	const resultId = `${tree.runId}:result`;
	const maxDepth = Math.max(0, ...ordered.map((n) => depth.get(n.id) ?? 0));
	const leafRows = leafIds.map((id) => rows.get(id) ?? 0);
	const phase: YardFlowPhase =
		tree.phase === "completed" ? "completed" : tree.phase === "failed" ? "failed" : "started";
	const formatted = tree.resultPreview ? formatYardResult(tree.resultPreview) : undefined;
	nodes.push({
		id: resultId,
		type: "yard",
		position: {
			x: (maxDepth + 1) * COLUMN_WIDTH,
			y: ((Math.min(...leafRows) + Math.max(...leafRows)) / 2) * ROW_HEIGHT,
		},
		data: {
			label: "Result",
			kind: "result",
			phase,
			summary: formatted?.hint,
			detail: formatted ? { result: formatted.display, hint: formatted.hint } : undefined,
		},
		class: `yard-node yard-node-result yard-node-${phase}`,
	});
	for (const leaf of leafIds) edges.push(edge(leaf, resultId, phase));
	return { nodes, edges };
}
