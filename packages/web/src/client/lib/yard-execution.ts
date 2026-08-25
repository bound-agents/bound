import type { YardExecutionEvent, YardExecutionNode } from "@bound/shared";
import { parseLeadingJsonValue } from "./yard-result";

export type YardNodePhase = "unknown" | "started" | "completed" | "failed" | "settled";

export interface YardNodeDetail {
	[key: string]: unknown;
	program?: string;
	args?: string;
	prompt?: string;
	instructions?: string;
	schema?: boolean;
	result?: string;
	hint?: string;
}

export interface YardNodeState {
	id: string;
	parentId: string | null;
	node: YardExecutionNode;
	phase: YardNodePhase;
	seq: number;
	startSeq: number;
	summary?: string;
	startedAt?: string;
	finishedAt?: string;
	detail?: YardNodeDetail;
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

export interface YardProgress {
	total: number;
	settled: number;
	failed: number;
	running: number;
}

/** Counts terminal presentation states without treating them as individual successes. */
export function yardProgress(tree: YardTreeSnapshot): YardProgress {
	return {
		total: tree.nodes.length,
		settled: tree.nodes.filter((node) => ["completed", "failed", "settled"].includes(node.phase))
			.length,
		failed: tree.nodes.filter((node) => node.phase === "failed").length,
		running: tree.nodes.filter((node) => node.phase === "started").length,
	};
}

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
	const sourceTree =
		root && !tree && event.program_preview
			? extractYardProgramTopology(event.program_preview, event.run_id)
			: (tree?.nodes ?? []);
	const nodes = new Map<string, YardNodeState>(sourceTree.map((node) => [node.id, node]));
	const matched = [...nodes.values()].find(
		(node) =>
			node.phase === "unknown" &&
			node.node.kind === event.node.kind &&
			(node.node.kind !== "tool" ||
				event.node.kind !== "tool" ||
				node.node.name === event.node.name ||
				node.node.name === `aux: ${event.node.name}`) &&
			(node.node.kind !== "inference" ||
				event.node.kind !== "inference" ||
				node.node.model === event.node.model),
	);
	const targetId = matched?.id ?? event.node_id;
	const existing = nodes.get(targetId);
	if (!existing || event.seq > existing.seq) {
		nodes.set(targetId, {
			id: targetId,
			parentId: matched?.parentId ?? event.parent_id,
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

export interface YardMessageLike {
	id?: string;
	role: string;
	content: string;
	tool_name?: string | null;
	created_at?: string;
}

type ToolUse = { id?: unknown; name?: unknown; input?: unknown };
type YardResult = { trace_id?: unknown; result?: unknown };

function parseJson(value: string): unknown {
	return parseLeadingJsonValue(value)?.value;
}

/**
 * A deliberately non-evaluating, tolerant extractor for Yard's generator DSL.
 * It recognizes literal effect constructors only; expressions it cannot prove are
 * represented by an Unknown dynamic region rather than pretending they ran.
 */
export function extractYardProgramTopology(
	program: string | undefined,
	runId: string,
): YardNodeState[] {
	const root: YardNodeState = {
		id: `${runId}:root`,
		parentId: null,
		node: { kind: "run", depth: 0 },
		phase: "unknown",
		seq: 0,
		startSeq: 0,
		detail: program ? { program } : undefined,
	};
	if (!program) return [root];
	type Call = {
		kind: string;
		start: number;
		end: number;
		literal?: string;
		id: string;
		node: YardExecutionNode;
		detail?: YardNodeDetail;
	};
	const closeParen = (open: number): number => {
		let depth = 0;
		let quote = "";
		for (let i = open; i < program.length; i++) {
			const char = program[i] ?? "";
			if (quote) {
				if (char === quote && (program[i - 1] ?? "") !== "\\") quote = "";
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				continue;
			}
			if (char === "(") depth++;
			if (char === ")" && --depth === 0) return i;
		}
		return program.length;
	};
	const closeObject = (source: string): number => {
		let depth = 0;
		let quote = "";
		for (let i = 0; i < source.length; i++) {
			const char = source[i] ?? "";
			if (quote) {
				if (char === quote && (source[i - 1] ?? "") !== "\\") quote = "";
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
				continue;
			}
			if (char === "{") depth++;
			if (char === "}" && --depth === 0) return i;
		}
		return source.length;
	};
	const calls: Call[] = [];
	let sequence = 0;
	for (const match of program.matchAll(/\b(tool|infer|aux|all|sequence|yard)\s*\(/g)) {
		const kind = match[1] ?? "";
		const start = match.index ?? 0;
		const open = start + match[0].length - 1;
		const body = program.slice(open + 1, closeParen(open));
		const literal = body.match(/^\s*["'`]([^"'`]*)["'`]/)?.[1];
		const rest = body
			.slice((body.match(/^\s*["'`][^"'`]*["'`]/)?.[0] ?? "").length)
			.replace(/^\s*,\s*/, "");
		const quotedSecond = rest.match(/^["'`]([^"'`]*)["'`]/)?.[1];
		const detail =
			kind === "tool"
				? {
						args: rest.startsWith("{") ? rest.slice(0, closeObject(rest) + 1) : "dynamic",
					}
				: kind === "infer"
					? {
							prompt: rest.match(/prompt\s*:\s*["'`]([^"'`]*)["'`]/)?.[1] ?? "dynamic",
							schema: /\bschema\s*:/.test(rest),
						}
					: kind === "aux"
						? { instructions: quotedSecond ?? "dynamic" }
						: undefined;
		const node =
			kind === "tool"
				? ({ kind: "tool", name: literal ?? "tool (dynamic)" } as const)
				: kind === "infer"
					? ({ kind: "inference", model: literal ?? "infer (dynamic)" } as const)
					: kind === "aux"
						? ({ kind: "tool", name: literal ? `aux: ${literal}` : "aux (dynamic)" } as const)
						: kind === "yard"
							? ({ kind: "run", depth: 1 } as const)
							: ({ kind: "tool", name: kind } as const);
		calls.push({
			kind,
			start,
			end: closeParen(open),
			literal,
			id: `${runId}:static:${++sequence}`,
			node,
			detail,
		});
	}
	const nodes = [
		root,
		...calls.map((call, index) => {
			const parent = calls
				.filter(
					(candidate) =>
						(candidate.kind === "all" ||
							candidate.kind === "sequence" ||
							candidate.kind === "yard") &&
						candidate.start < call.start &&
						candidate.end >= call.end,
				)
				.sort((a, b) => a.end - b.end)[0];
			return {
				id: call.id,
				parentId: parent?.id ?? root.id,
				node: call.node,
				detail: call.detail,
				phase: "unknown" as const,
				seq: index + 1,
				startSeq: index + 1,
			};
		}),
	];
	if (calls.length === 0 && /\byield\b/.test(program))
		nodes.push({
			id: `${runId}:dynamic`,
			parentId: root.id,
			node: { kind: "tool", name: "Dynamic effect region" },
			phase: "unknown",
			seq: 1,
			startSeq: 1,
		});
	return nodes;
}
/** Best-effort overlay: lifecycle is ephemeral decoration of stable source topology. */
export function overlayYardLifecycle(
	tree: YardTreeSnapshot,
	events: YardExecutionEvent[],
): YardTreeSnapshot {
	const nodes = tree.nodes.map((node) => ({ ...node }));
	for (const event of events.sort((a, b) => a.seq - b.seq)) {
		const candidate = nodes.find(
			(node) =>
				(node.phase === "unknown" || node.phase === "settled") &&
				node.node.kind === event.node.kind &&
				(node.node.kind !== "tool" ||
					event.node.kind !== "tool" ||
					node.node.name === event.node.name ||
					node.node.name === `aux: ${event.node.name}`) &&
				(node.node.kind !== "inference" ||
					event.node.kind !== "inference" ||
					node.node.model === event.node.model),
		);
		if (candidate)
			Object.assign(candidate, {
				phase: event.phase,
				summary: event.summary,
				startedAt: event.started_at,
				finishedAt: event.finished_at,
			});
	}
	return { ...tree, nodes };
}

/** Rebuilds completed topology solely from the durable Yard tool-call program. */
export function reconstructCompletedYardExecutions(
	messages: YardMessageLike[],
): YardTreeSnapshot[] {
	const results = new Map<string, YardMessageLike>();
	for (const message of messages)
		if (message.role === "tool_result" && message.tool_name)
			results.set(message.tool_name, message);
	const completed: YardTreeSnapshot[] = [];
	for (const message of messages) {
		if (message.role !== "tool_call") continue;
		const blocks = parseJson(message.content);
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks as ToolUse[]) {
			if (block?.name !== "yard" || typeof block.id !== "string") continue;
			const resultMessage = results.get(block.id);
			if (!resultMessage) continue;
			const parsedResult = parseLeadingJsonValue(resultMessage.content);
			const result = parsedResult?.value as YardResult | undefined;
			const traceId = typeof result?.trace_id === "string" ? result.trace_id : block.id;
			const input = block.input as { program?: unknown } | undefined;
			const programPreview = typeof input?.program === "string" ? input.program : undefined;
			completed.push({
				traceId,
				runId: traceId,
				phase: "completed",
				programPreview,
				resultPreview: parsedResult?.tail
					? resultMessage.content
					: result?.result === undefined
						? resultMessage.content
						: JSON.stringify(result.result),
				toolCallId: block.id,
				startedAt: message.created_at,
				finishedAt: resultMessage.created_at,
				nodes: extractYardProgramTopology(programPreview, traceId).map((node) => ({
					...node,
					// A durable result proves the run settled, not which effects succeeded.
					phase: "settled",
				})),
			});
		}
	}
	return completed;
}

/** Message-derived terminal topology supersedes transient trace state for that run. */
export function reconcileYardExecutions(
	state: YardExecutionState,
	messages: YardMessageLike[],
): YardExecutionState {
	const reconstructed = reconstructCompletedYardExecutions(messages);
	const programsByCallId = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "tool_call") continue;
		const blocks = parseJson(message.content);
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks as ToolUse[]) {
			const input = block.input as { program?: unknown } | undefined;
			if (
				block.name === "yard" &&
				typeof block.id === "string" &&
				typeof input?.program === "string"
			)
				programsByCallId.set(block.id, input.program);
		}
	}
	const traceIds = new Set(reconstructed.map((tree) => tree.traceId));
	const live = new Map(state.live);
	let changed = false;
	for (const [traceId, tree] of state.live) {
		if (traceIds.has(traceId)) {
			live.delete(traceId);
			changed = true;
			continue;
		}
		const program = tree.toolCallId ? programsByCallId.get(tree.toolCallId) : undefined;
		if (!program || tree.programPreview === program) continue;
		live.set(traceId, {
			...tree,
			programPreview: program,
			nodes: tree.nodes.map((node) =>
				node.node.kind === "run" && node.parentId === null
					? { ...node, detail: { ...node.detail, program } }
					: node,
			),
		});
		changed = true;
	}
	if (reconstructed.length === 0 && !changed) return state;

	return {
		...state,
		live,
		completed: [...state.completed.filter((tree) => !traceIds.has(tree.traceId)), ...reconstructed],
		seenTerminalRoots: new Set([...state.seenTerminalRoots, ...traceIds]),
	};
}
