import type { YardNodePhase, YardTreeSnapshot } from "./yard-execution";
import { formatYardResult } from "./yard-result";

export type YardFlowKind = "run" | "tool" | "inference" | "aux" | "unknown" | "result" | "group";
export type YardFlowPhase = YardNodePhase;
export interface YardFlowData {
	label: string;
	kind: YardFlowKind;
	phase: YardFlowPhase;
	summary?: string;
	detail?: Record<string, unknown>;
	construct?: "all" | "sequence";
	/** One-based source order for a child of a sequence container. */
	ordinal?: number;
	/** Number of simultaneously-dispatched children in an all container. */
	parallelCount?: number;
}
export interface YardFlowNode {
	id: string;
	type: "yard" | "yardGroup";
	position: { x: number; y: number };
	data: YardFlowData;
	parentId?: string;
	extent?: "parent";
	width?: number;
	height?: number;
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
	zIndex?: number;
}
const WIDTH = 184;
const HEIGHT = 68;
const GAP = 34;
const COLUMN = 238;
const PADDING = 32;
const LABEL = 24;
const labelFor = (node: YardTreeSnapshot["nodes"][number]) =>
	node.construct
		? node.construct === "all"
			? "All"
			: "Sequence"
		: node.node.kind === "run"
			? node.node.depth === 0
				? "Yard run"
				: `Nested Yard (${node.node.depth})`
			: node.node.kind === "tool"
				? node.node.name
				: node.node.model;
const kindFor = (node: YardTreeSnapshot["nodes"][number]): YardFlowKind =>
	node.construct
		? "group"
		: node.node.kind !== "tool"
			? node.node.kind
			: /dynamic effect region/i.test(node.node.name)
				? "unknown"
				: node.node.name.startsWith("aux:")
					? "aux"
					: "tool";
function aggregate(
	node: YardTreeSnapshot["nodes"][number],
	nodes: YardTreeSnapshot["nodes"],
): YardFlowPhase {
	if (!node.construct) return node.phase;
	const children = nodes
		.filter((child) => child.parentId === node.id)
		.map((child) => aggregate(child, nodes));
	if (children.includes("failed")) return "failed";
	if (children.includes("started")) return "started";
	if (children.length && children.every((phase) => ["completed", "settled"].includes(phase)))
		return children.includes("completed") ? "completed" : "settled";
	return node.phase;
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
		zIndex: 1,
	};
}
/** Maps program-order topology to a deterministic left-to-right SvelteFlow subflow graph. */
export function yardTreeToFlow(tree: YardTreeSnapshot): {
	nodes: YardFlowNode[];
	edges: YardFlowEdge[];
} {
	const ordered = [...tree.nodes].sort(
		(a, b) => a.startSeq - b.startSeq || a.id.localeCompare(b.id),
	);
	const byId = new Map(ordered.map((node) => [node.id, node]));
	const phase = new Map(ordered.map((node) => [node.id, aggregate(node, ordered)]));
	const children = new Map<string, typeof ordered>();
	for (const node of ordered)
		if (node.parentId && byId.has(node.parentId))
			children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
	for (const group of children.values())
		group.sort((a, b) => a.startSeq - b.startSeq || a.id.localeCompare(b.id));
	const size = new Map<string, { width: number; height: number }>();
	const local = new Map<string, { x: number; y: number }>();
	const measure = (node: (typeof ordered)[number]): { width: number; height: number } => {
		const cached = size.get(node.id);
		if (cached) return cached;
		const kids = children.get(node.id) ?? [];
		if (!node.construct) {
			const value = { width: WIDTH, height: HEIGHT };
			size.set(node.id, value);
			return value;
		}
		if (!kids.length) {
			const value = { width: WIDTH + PADDING * 2, height: HEIGHT + LABEL + PADDING * 2 };
			size.set(node.id, value);
			return value;
		}
		const childSizes = kids.map(measure);
		let width = WIDTH;
		let height = HEIGHT;
		if (node.construct === "all") {
			width = Math.max(WIDTH, ...childSizes.map((s) => s.width)) + PADDING * 2;
			height =
				LABEL +
				PADDING * 2 +
				childSizes.reduce((n, s) => n + s.height, 0) +
				GAP * Math.max(0, kids.length - 1);
			let y = LABEL + PADDING;
			kids.forEach((kid, i) => {
				const kidSize = childSizes[i] ?? { width: WIDTH, height: HEIGHT };
				if (i) y += GAP;
				local.set(kid.id, { x: (width - kidSize.width) / 2, y });
				y += kidSize.height;
			});
		} else {
			width =
				LABEL +
				PADDING * 2 +
				childSizes.reduce((n, s) => n + s.width, 0) +
				GAP * Math.max(0, kids.length - 1);
			height = Math.max(HEIGHT, ...childSizes.map((s) => s.height)) + LABEL + PADDING * 2;
			let x = PADDING;
			kids.forEach((kid, i) => {
				const kidSize = childSizes[i] ?? { width: WIDTH, height: HEIGHT };
				local.set(kid.id, {
					x,
					y: LABEL + PADDING + (height - LABEL - PADDING * 2 - kidSize.height) / 2,
				});
				x += kidSize.width + GAP;
			});
		}
		const value = { width, height };
		size.set(node.id, value);
		return value;
	};
	for (const node of ordered) measure(node);
	const top =
		ordered.filter((node) => node.node.kind === "run" && node.parentId === null)[0] ?? ordered[0];
	// Only source-derived top-level yields advance the outer execution chain. Runtime
	// fallback nodes leave executionParentId undefined, which is deliberately excluded.
	const execution = ordered.filter(
		(node) => node.id === top?.id || (node.parentId === top?.id && node.executionParentId != null),
	);
	const absolute = new Map<string, { x: number; y: number }>();
	let x = 0;
	for (const node of execution) {
		const s = size.get(node.id) ?? { width: WIDTH, height: HEIGHT };
		absolute.set(node.id, { x, y: 0 });
		x += s.width + COLUMN;
	}
	const place = (node: (typeof ordered)[number], parent?: (typeof ordered)[number]) => {
		if (parent) {
			const origin = absolute.get(parent.id) ?? { x: 0, y: 0 };
			const point = local.get(node.id) ?? { x: 0, y: 0 };
			absolute.set(node.id, { x: origin.x + point.x, y: origin.y + point.y });
		}
		if (node.construct) for (const child of children.get(node.id) ?? []) place(child, node);
	};
	for (const node of execution) place(node);
	for (const node of ordered) if (!absolute.has(node.id)) absolute.set(node.id, { x: 0, y: 0 });
	const nodes: YardFlowNode[] = ordered.map((node) => {
		const p = absolute.get(node.id) ?? { x: 0, y: 0 };
		const isGroup = Boolean(node.construct);
		return {
			id: node.id,
			type: isGroup ? "yardGroup" : "yard",
			position: p,
			data: {
				label: labelFor(node),
				kind: kindFor(node),
				phase: phase.get(node.id) ?? "unknown",
				summary: node.summary,
				detail:
					node.detail ??
					(node.node.kind === "run" && tree.programPreview
						? { program: tree.programPreview }
						: undefined),
				construct: node.construct,
				...(node.parentId && byId.get(node.parentId)?.construct === "sequence"
					? {
							ordinal:
								(children.get(node.parentId)?.findIndex((child) => child.id === node.id) ?? -1) + 1,
						}
					: {}),
				...(node.construct === "all"
					? { parallelCount: (children.get(node.id) ?? []).length }
					: {}),
			},
			...(node.parentId && byId.get(node.parentId)?.construct
				? { parentId: node.parentId, extent: "parent" as const }
				: {}),
			...(isGroup ? size.get(node.id) : {}),
			class: `yard-node yard-node-${kindFor(node)} yard-node-${phase.get(node.id) ?? "unknown"}`,
		};
	});
	const edges: YardFlowEdge[] = [];
	for (const node of ordered) {
		const parent = node.executionParentId;
		if (parent && byId.has(parent))
			edges.push(edge(parent, node.id, phase.get(node.id) ?? "unknown"));
	}
	const resultId = `${tree.runId}:result`;
	const last = execution.at(-1) ?? top;
	const lastPoint = (last ? absolute.get(last.id) : undefined) ?? { x: 0, y: 0 };
	const lastWidth = (last ? size.get(last.id) : undefined)?.width ?? WIDTH;
	const treePhase: YardFlowPhase =
		tree.phase === "completed" ? "completed" : tree.phase === "failed" ? "failed" : "started";
	const formatted =
		tree.resultPreview !== undefined ? formatYardResult(tree.resultPreview) : undefined;
	nodes.push({
		id: resultId,
		type: "yard",
		position: {
			x: lastPoint.x + (last ? lastWidth + COLUMN : WIDTH),
			y: lastPoint.y,
		},
		data: {
			label: "Result",
			kind: "result",
			phase: treePhase,
			summary: formatted?.hint,
			detail: formatted
				? {
						result: formatted.display,
						hint: formatted.hint,
						...(formatted.tail ? { metadata: formatted.tail } : {}),
					}
				: undefined,
		},
		class: `yard-node yard-node-result yard-node-${treePhase}`,
	});
	if (last) edges.push(edge(last.id, resultId, treePhase));
	return { nodes, edges };
}
