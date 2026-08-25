import type { YardExecutionEvent, YardExecutionNode } from "@bound/shared";
import { parseLeadingJsonValue } from "./yard-result";

export type YardNodePhase = "unknown" | "started" | "completed" | "failed" | "settled";

export interface YardNodeDetail {
	[key: string]: unknown;
	program?: string;
	args?: string;
	prompt?: string;
	instructions?: string;
	schema?: string;
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
	/** Static container construct; lifecycle events bind only to leaf effects. */
	construct?: "all" | "sequence";
	/** Previous effect in the source-level execution chain. */
	executionParentId?: string | null;
	/** Runtime event id bound to this stable topology node. */
	runtimeId?: string;
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

function effectMatches(node: YardNodeState, event: Pick<YardExecutionEvent, "node">): boolean {
	return (
		node.node.kind === event.node.kind &&
		(node.node.kind !== "tool" ||
			event.node.kind !== "tool" ||
			node.node.name === event.node.name ||
			node.node.name === `aux: ${event.node.name}`) &&
		(node.node.kind !== "inference" ||
			event.node.kind !== "inference" ||
			node.node.model === event.node.model ||
			node.node.model === "infer (dynamic)")
	);
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
	const ordered = [...nodes.values()].sort((a, b) => a.startSeq - b.startSeq);
	const existingByRuntimeId = ordered.find((node) => node.runtimeId === event.node_id);
	const matched =
		existingByRuntimeId ??
		ordered.find((node) => node.phase === "unknown" && effectMatches(node, event));
	const targetId = matched?.id ?? event.node_id;
	const existing = nodes.get(targetId);
	const mappedParent = ordered.find((node) => node.runtimeId === event.parent_id)?.id;
	const rootId = ordered.find((node) => node.node.kind === "run" && node.parentId === null)?.id;
	const parentId = matched ? matched.parentId : (mappedParent ?? rootId ?? event.parent_id);
	if (!existing || event.seq > existing.seq) {
		nodes.set(targetId, {
			id: targetId,
			parentId,
			node: existing?.node ?? event.node,
			phase: event.phase,
			seq: event.seq,
			startSeq: existing?.startSeq ?? event.seq,
			summary: event.summary ?? existing?.summary,
			startedAt: existing?.startedAt ?? event.started_at,
			finishedAt: event.finished_at ?? existing?.finishedAt,
			detail: existing?.detail,
			runtimeId: event.node_id,
		});
	} else if (event.seq < existing.seq) {
		nodes.set(targetId, { ...existing, startSeq: Math.min(existing.startSeq, event.seq) });
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
		executionParentId: null,
		detail: program ? { program } : undefined,
	};
	if (!program) return [root];
	type Call = {
		kind: string;
		start: number;
		end: number;
		args: string[];
		id: string;
		node: YardExecutionNode;
		detail?: YardNodeDetail;
	};
	const skipString = (source: string, index: number): number => {
		const quote = source[index];
		for (let i = index + 1; i < source.length; i++) {
			if (source[i] === "\\") {
				i++;
				continue;
			}
			if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
				i = balanced(source, i + 1, "{", "}");
				continue;
			}
			if (source[i] === quote) return i;
		}
		return source.length - 1;
	};
	const skipComment = (source: string, index: number): number => {
		if (source[index + 1] === "/") {
			const end = source.indexOf("\n", index + 2);
			return end < 0 ? source.length - 1 : end;
		}
		if (source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			return end < 0 ? source.length - 1 : end + 1;
		}
		return index;
	};
	const balanced = (source: string, open: number, opening: string, closing: string): number => {
		let depth = 0;
		for (let i = open; i < source.length; i++) {
			const char = source[i];
			if (char === '"' || char === "'" || char === "`") {
				i = skipString(source, i);
				continue;
			}
			if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
				i = skipComment(source, i);
				continue;
			}
			if (char === opening) depth++;
			else if (char === closing && --depth === 0) return i;
		}
		return source.length - 1;
	};
	const splitTopLevel = (source: string): string[] => {
		const values: string[] = [];
		let start = 0;
		const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
		for (let i = 0; i < source.length; i++) {
			const char = source[i];
			if (char === '"' || char === "'" || char === "`") {
				i = skipString(source, i);
				continue;
			}
			if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
				i = skipComment(source, i);
				continue;
			}
			if (pairs[char]) {
				i = balanced(source, i, char, pairs[char]);
				continue;
			}
			if (char === ",") {
				values.push(source.slice(start, i).trim());
				start = i + 1;
			}
		}
		values.push(source.slice(start).trim());
		return values;
	};
	const stringValue = (value: string | undefined): string | undefined => {
		if (!value || !['"', "'", "`"].includes(value[0] ?? "")) return undefined;
		const end = skipString(value, 0);
		return end === value.length - 1 ? value.slice(1, -1) : undefined;
	};
	const property = (object: string, name: string): string | undefined => {
		const body = object.trim();
		if (!body.startsWith("{") || !body.endsWith("}")) return undefined;
		for (const entry of splitTopLevel(body.slice(1, -1))) {
			const colon = entry.indexOf(":");
			if (colon >= 0 && entry.slice(0, colon).trim() === name) return entry.slice(colon + 1).trim();
		}
		return undefined;
	};
	const calls: Call[] = [];
	let sequence = 0;
	for (let i = 0; i < program.length; i++) {
		const char = program[i];
		if (char === '"' || char === "'" || char === "`") {
			i = skipString(program, i);
			continue;
		}
		if (char === "/" && (program[i + 1] === "/" || program[i + 1] === "*")) {
			i = skipComment(program, i);
			continue;
		}
		const match = program.slice(i).match(/^(tool|infer|aux|all|sequence|yard)\s*\(/);
		if (!match || (i > 0 && /[\w$]/.test(program[i - 1] ?? ""))) continue;
		const kind = match[1] ?? "";
		const open = i + match[0].length - 1;
		const end = balanced(program, open, "(", ")");
		const args = splitTopLevel(program.slice(open + 1, end));
		const literal = stringValue(args[0]);
		const options = args[1];
		const detail =
			kind === "tool"
				? { args: options?.trim().startsWith("{") ? options : "dynamic" }
				: kind === "infer"
					? {
							prompt: stringValue(property(options ?? "", "prompt")) ?? "dynamic",
							schema: property(options ?? "", "schema") ?? "dynamic",
						}
					: kind === "aux"
						? { instructions: stringValue(args[1]) ?? "dynamic" }
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
		calls.push({ kind, start: i, end, args, id: `${runId}:static:${++sequence}`, node, detail });
		i = open;
	}
	const containers = new Set(["all", "sequence"]);
	const parentFor = (call: Call) =>
		calls
			.filter(
				(candidate) =>
					(containers.has(candidate.kind) || candidate.kind === "yard") &&
					candidate.start < call.start &&
					candidate.end >= call.end,
			)
			.sort((a, b) => a.end - b.end)[0];
	const directChildren = (parent: Call | undefined) =>
		calls.filter((candidate) => parentFor(candidate)?.id === parent?.id);
	const topLevel = calls.filter((call) => !parentFor(call));
	const executionParents = new Map<string, string | null>();
	const chain = (members: Call[], preceding: string | null) => {
		let previous = preceding;
		for (const member of members) {
			executionParents.set(member.id, previous);
			previous = member.id;
		}
	};
	chain(topLevel, root.id);
	for (const container of calls.filter((call) => containers.has(call.kind))) {
		const members = directChildren(container);
		if (container.kind === "sequence") chain(members, null);
		else for (const member of members) executionParents.set(member.id, null);
	}
	const nodes = [
		root,
		...calls.map((call, index) => {
			const parent = parentFor(call);
			return {
				id: call.id,
				parentId: parent?.id ?? root.id,
				node: call.node,
				detail: call.detail,
				construct: containers.has(call.kind) ? (call.kind as "all" | "sequence") : undefined,
				phase: "unknown" as const,
				seq: index + 1,
				startSeq: index + 1,
				executionParentId: executionParents.get(call.id) ?? null,
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
			executionParentId: root.id,
		});
	return nodes;
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

/**
 * Replaces an incomplete live replay with program-derived stable ids, carrying the
 * lifecycle state over by effect identity. This makes an arriving persisted program
 * improve a live card without making nodes jump to new runtime ids.
 */
function enrichLiveTopology(tree: YardTreeSnapshot, program: string): YardTreeSnapshot {
	const staticNodes = extractYardProgramTopology(program, tree.runId);
	const nodes = new Map(staticNodes.map((node) => [node.id, node]));
	const runtimeToStatic = new Map<string, string>();
	for (const runtime of tree.nodes) {
		const target =
			(runtime.node.kind === "run" && runtime.parentId === null
				? staticNodes.find((node) => node.node.kind === "run" && node.parentId === null)
				: staticNodes.find(
						(node) => node.phase === "unknown" && effectMatches(node, { node: runtime.node }),
					)) ?? undefined;
		if (!target) continue;
		runtimeToStatic.set(runtime.id, target.id);
		nodes.set(target.id, {
			...target,
			phase: runtime.phase,
			seq: runtime.seq,
			startSeq: target.startSeq,
			summary: runtime.summary ?? target.summary,
			startedAt: runtime.startedAt,
			finishedAt: runtime.finishedAt,
			runtimeId: runtime.runtimeId,
		});
	}
	// Preserve dynamic runtime regions the tolerant extractor cannot prove statically.
	for (const runtime of tree.nodes) {
		if (runtimeToStatic.has(runtime.id)) continue;
		nodes.set(runtime.id, {
			...runtime,
			parentId: runtime.parentId
				? (runtimeToStatic.get(runtime.parentId) ?? `${tree.runId}:root`)
				: null,
		});
	}
	return {
		...tree,
		programPreview: program,
		nodes: snapshotNodes(nodes),
	};
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
		live.set(traceId, enrichLiveTopology(tree, program));
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
