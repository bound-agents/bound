import type { BoundClient } from "@bound/client";
import type { YardExecutionEvent, YardExecutionNode } from "@bound/shared";
import { useEffect, useMemo, useState } from "react";

export interface YardNodeState {
	id: string;
	parentId: string | null;
	node: YardExecutionNode;
	phase: "started" | "completed" | "failed";
	seq: number;
	summary?: string;
}

export interface YardTreeSnapshot {
	traceId: string;
	runId: string;
	phase: "started" | "completed" | "failed";
	inputPreview?: string;
	resultPreview?: string;
	summary?: string;
	toolCallId?: string;
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
	return [...nodes.values()].sort((a, b) => a.seq - b.seq).map((node) => ({ ...node }));
}

/** Pure reducer: duplicate/stale events are ignored and terminal roots commit once. */
export function reduceYardExecution(
	state: YardExecutionState,
	event: YardExecutionEvent,
): YardExecutionState {
	const key = `${event.trace_id}:${event.run_id}`;
	const prior = state.live.get(key);
	const rootEvent = event.node.kind === "run" && event.node_id === event.run_id;
	if (!prior && !rootEvent) return state;

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
		summary: event.summary,
	});

	const tree: YardTreeSnapshot = {
		traceId: event.trace_id,
		runId: event.run_id,
		phase: rootEvent ? event.phase : (prior?.phase ?? "started"),
		inputPreview: event.input_preview ?? prior?.inputPreview,
		resultPreview: event.result_preview ?? prior?.resultPreview,
		summary: rootEvent ? event.summary : prior?.summary,
		toolCallId: event.tool_call_id ?? prior?.toolCallId,
		nodes: snapshotNodes(nodes),
	};

	if (rootEvent && event.phase !== "started") {
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
