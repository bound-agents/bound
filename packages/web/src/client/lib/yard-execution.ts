import type { YardExecutionEvent, YardExecutionNode } from "@bound/shared";

export interface YardNodeState {
	id: string;
	parentId: string | null;
	node: YardExecutionNode;
	phase: "started" | "completed" | "failed";
	seq: number;
	startSeq: number;
	summary?: string;
	startedAt?: string;
	finishedAt?: string;
}

export interface YardTreeSnapshot {
	traceId: string;
	runId: string;
	phase: "started" | "completed" | "failed";
	inputPreview?: string;
	programPreview?: string;
	resultPreview?: string;
	summary?: string;
	toolCallId?: string;
	startedAt?: string;
	finishedAt?: string;
	nodes: YardNodeState[];
}

export interface YardExecutionState {
	live: Map<string, YardTreeSnapshot>;
	completed: YardTreeSnapshot[];
	seenTerminalRoots: Set<string>;
	/** Events that raced ahead of their root-start event, keyed by trace. */
	pending: Map<string, YardExecutionEvent[]>;
}

export const EMPTY_YARD_STATE: YardExecutionState = {
	live: new Map(),
	completed: [],
	seenTerminalRoots: new Set(),
	pending: new Map(),
};

function snapshotNodes(nodes: Map<string, YardNodeState>): YardNodeState[] {
	return [...nodes.values()].sort((a, b) => a.startSeq - b.startSeq).map((node) => ({ ...node }));
}

function isRootEvent(event: YardExecutionEvent): boolean {
	return event.node.kind === "run" && event.node_id === event.run_id && event.parent_id === null;
}

function fold(
	tree: YardTreeSnapshot | undefined,
	event: YardExecutionEvent,
	root: boolean,
): YardTreeSnapshot {
	const nodes = new Map<string, YardNodeState>((tree?.nodes ?? []).map((node) => [node.id, node]));
	const existing = nodes.get(event.node_id);
	if (!existing || event.seq > existing.seq) {
		nodes.set(event.node_id, {
			id: event.node_id,
			parentId: event.parent_id,
			node: event.node,
			phase: event.phase,
			seq: event.seq,
			startSeq: existing?.startSeq ?? event.seq,
			summary: event.summary ?? existing?.summary,
			startedAt: existing?.startedAt ?? event.started_at,
			finishedAt: event.finished_at ?? existing?.finishedAt,
		});
	} else if (event.seq < existing.seq) {
		nodes.set(event.node_id, { ...existing, startSeq: Math.min(existing.startSeq, event.seq) });
	}
	return {
		traceId: event.trace_id,
		runId: root ? event.run_id : (tree?.runId ?? event.run_id),
		phase: root ? event.phase : (tree?.phase ?? "started"),
		inputPreview: root ? (event.input_preview ?? tree?.inputPreview) : tree?.inputPreview,
		programPreview: root ? (event.program_preview ?? tree?.programPreview) : tree?.programPreview,
		resultPreview: root ? (event.result_preview ?? tree?.resultPreview) : tree?.resultPreview,
		summary: root ? event.summary : tree?.summary,
		toolCallId: event.tool_call_id ?? tree?.toolCallId,
		startedAt: (root ? event.started_at : undefined) ?? tree?.startedAt,
		finishedAt: (root ? event.finished_at : undefined) ?? tree?.finishedAt,
		nodes: snapshotNodes(nodes),
	};
}

/** Folds the lifecycle stream into root execution trees, buffering out-of-order leaves by trace. */
export function reduceYardExecution(
	state: YardExecutionState,
	event: YardExecutionEvent,
): YardExecutionState {
	const key = event.trace_id;
	const root = isRootEvent(event);

	if (state.seenTerminalRoots.has(key)) {
		const completedIndex = state.completed.findIndex((tree) => tree.traceId === key);
		const completed = state.completed[completedIndex];
		const terminalRoot = completed?.nodes.find((node) => node.id === completed.runId);
		if (!completed || !terminalRoot || event.seq >= terminalRoot.seq) return state;

		const folded = fold(completed, event, false);
		const tree = root
			? {
					...folded,
					phase: completed.phase,
					inputPreview: event.input_preview ?? completed.inputPreview,
					programPreview: event.program_preview ?? completed.programPreview,
					summary: event.summary ?? completed.summary,
					startedAt: event.started_at ?? completed.startedAt,
					finishedAt: completed.finishedAt,
				}
			: folded;
		const nextCompleted = [...state.completed];
		nextCompleted[completedIndex] = tree;
		return { ...state, completed: nextCompleted };
	}

	const prior = state.live.get(key);
	if (!prior && !root) {
		const pending = new Map(state.pending);
		const events = pending.get(key) ?? [];
		if (events.some((queued) => queued.node_id === event.node_id && queued.seq >= event.seq))
			return state;
		pending.set(key, [...events, event]);
		return { ...state, pending };
	}

	let tree = fold(prior, event, root);
	const pending = new Map(state.pending);
	if (root && !prior) {
		const queued = pending.get(key) ?? [];
		pending.delete(key);
		for (const queuedEvent of queued.sort((a, b) => a.seq - b.seq)) {
			tree = fold(tree, queuedEvent, false);
		}
	}

	const nextLive = new Map(state.live);
	if (root && event.phase !== "started") {
		nextLive.delete(key);
		const seenTerminalRoots = new Set(state.seenTerminalRoots);
		seenTerminalRoots.add(key);
		return { live: nextLive, completed: [...state.completed, tree], seenTerminalRoots, pending };
	}
	nextLive.set(key, tree);
	return { ...state, live: nextLive, pending };
}
