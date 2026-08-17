import type { BoundClient } from "@bound/client";
import type { YardExecutionEvent, YardExecutionNode } from "@bound/shared";
import { useEffect, useMemo, useState } from "react";

export interface YardNodeState {
	id: string;
	parentId: string | null;
	node: YardExecutionNode;
	phase: "started" | "completed" | "failed";
	/** Latest event seq for this node — staleness/duplicate guard. */
	seq: number;
	/**
	 * Seq of the node's FIRST event — stable display order. Without it, a
	 * node's terminal event (higher seq) would reorder it to the end of the
	 * snapshot when sorting, making completed nodes jump around in the card.
	 */
	startSeq: number;
	summary?: string;
	/** ISO start/finish instants from the lifecycle events — drive durations. */
	startedAt?: string;
	finishedAt?: string;
}

export interface YardTreeSnapshot {
	traceId: string;
	runId: string;
	phase: "started" | "completed" | "failed";
	inputPreview?: string;
	/** Bounded generator source from the tree-root started event. */
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
}

export const EMPTY_YARD_STATE: YardExecutionState = {
	live: new Map(),
	completed: [],
	seenTerminalRoots: new Set(),
};

function snapshotNodes(nodes: Map<string, YardNodeState>): YardNodeState[] {
	return [...nodes.values()].sort((a, b) => a.startSeq - b.startSeq).map((node) => ({ ...node }));
}

/**
 * Pure reducer: duplicate/stale events are ignored and terminal roots commit
 * once.
 *
 * Trees are keyed by trace_id ALONE. A nested yard() call opens its own run
 * (fresh run_id, same trace_id) parented under the dispatching tool effect —
 * it is a subtree of one execution, not a second execution, so its events
 * fold into the parent's node graph. Only the TREE ROOT run (a run node that
 * is its own run's root and has no parent) carries tree-level identity:
 * phase, input/result previews, summary, and the terminal commit. A nested
 * run terminating is node state, not tree state.
 */
export function reduceYardExecution(
	state: YardExecutionState,
	event: YardExecutionEvent,
): YardExecutionState {
	const key = event.trace_id;
	const prior = state.live.get(key);
	const treeRootEvent =
		event.node.kind === "run" && event.node_id === event.run_id && event.parent_id === null;
	if (!prior && !treeRootEvent) return state;

	const nextLive = new Map(state.live);
	const nodes = new Map<string, YardNodeState>((prior?.nodes ?? []).map((node) => [node.id, node]));
	const existing = nodes.get(event.node_id);
	if (existing && event.seq <= existing.seq) return state;
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

	// Tree-level fields come from tree-root events only. A nested run's
	// input/result previews are node detail and must not overwrite the
	// root's.
	const tree: YardTreeSnapshot = {
		traceId: event.trace_id,
		runId: treeRootEvent ? event.run_id : (prior?.runId ?? event.run_id),
		phase: treeRootEvent ? event.phase : (prior?.phase ?? "started"),
		inputPreview: treeRootEvent
			? (event.input_preview ?? prior?.inputPreview)
			: prior?.inputPreview,
		programPreview: treeRootEvent
			? (event.program_preview ?? prior?.programPreview)
			: prior?.programPreview,
		resultPreview: treeRootEvent
			? (event.result_preview ?? prior?.resultPreview)
			: prior?.resultPreview,
		summary: treeRootEvent ? event.summary : prior?.summary,
		toolCallId: event.tool_call_id ?? prior?.toolCallId,
		startedAt: (treeRootEvent ? event.started_at : undefined) ?? prior?.startedAt,
		finishedAt: (treeRootEvent ? event.finished_at : undefined) ?? prior?.finishedAt,
		nodes: snapshotNodes(nodes),
	};

	if (treeRootEvent && event.phase !== "started") {
		if (state.seenTerminalRoots.has(key)) return state;
		nextLive.delete(key);
		const seenTerminalRoots = new Set(state.seenTerminalRoots);
		seenTerminalRoots.add(key);
		return {
			live: nextLive,
			completed: [...state.completed, tree],
			seenTerminalRoots,
		};
	}

	nextLive.set(key, tree);
	return { ...state, live: nextLive };
}

export function useYardExecutions(
	client: BoundClient | null,
	threadId: string,
): { live: YardTreeSnapshot[]; completed: YardTreeSnapshot[] } {
	const [state, setState] = useState<YardExecutionState>(EMPTY_YARD_STATE);

	useEffect(() => {
		setState(EMPTY_YARD_STATE);
		if (!client || typeof client.on !== "function" || typeof client.off !== "function") return;
		const onEvent = (event: YardExecutionEvent): void => {
			if (event.thread_id !== threadId) return;
			setState((current) => reduceYardExecution(current, event));
		};
		client.on("yard:execution", onEvent);
		return () => client.off("yard:execution", onEvent);
	}, [client, threadId]);

	return useMemo(() => ({ live: [...state.live.values()], completed: state.completed }), [state]);
}
