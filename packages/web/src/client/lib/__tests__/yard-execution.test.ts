import { describe, expect, it } from "bun:test";
import type { YardExecutionEvent } from "@bound/shared";
import { anchorYardTrees } from "../yard-anchoring";
import {
	EMPTY_YARD_STATE,
	extractYardProgramTopology,
	reduceYardExecution,
	yardProgress,
} from "../yard-execution";
import { yardTreeToFlow } from "../yard-graph";

function event(overrides: Partial<YardExecutionEvent> = {}): YardExecutionEvent {
	return {
		thread_id: "thread-1",
		trace_id: "trace-1",
		run_id: "run-1",
		node_id: "run-1",
		parent_id: null,
		seq: 1,
		phase: "started",
		node: { kind: "run", depth: 0 },
		tool_call_id: "call-1",
		started_at: "2026-08-24T20:00:00.000Z",
		...overrides,
	};
}

describe("Yard execution reducer", () => {
	it("buffers leaf lifecycle events received before the root and replays them in sequence", () => {
		const leaf = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({
				node_id: "tool-1",
				parent_id: "run-1",
				seq: 2,
				node: { kind: "tool", name: "read" },
			}),
		);
		const tree = reduceYardExecution(leaf, event()).live.get("trace-1");

		expect(tree?.nodes.map((node) => node.id)).toEqual(["run-1", "tool-1"]);
		expect(tree?.nodes[1]?.node).toEqual({ kind: "tool", name: "read" });
	});

	it("retains a completed tree once and ignores duplicate terminal events", () => {
		const started = reduceYardExecution(EMPTY_YARD_STATE, event());
		const completed = reduceYardExecution(
			started,
			event({ phase: "completed", seq: 3, finished_at: "2026-08-24T20:01:00.000Z" }),
		);
		const duplicated = reduceYardExecution(
			completed,
			event({ phase: "completed", seq: 4, finished_at: "2026-08-24T20:01:01.000Z" }),
		);

		expect(completed.live.size).toBe(0);
		expect(completed.completed).toHaveLength(1);
		expect(duplicated).toBe(completed);
	});

	it("retains a terminal root while folding its late start and lower-sequence nodes", () => {
		let state = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({
				phase: "completed",
				seq: 3,
				result_preview: "done",
				finished_at: "2026-08-24T20:01:00.000Z",
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				node_id: "tool-1",
				parent_id: "run-1",
				seq: 2,
				node: { kind: "tool", name: "read" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({ input_preview: "root input", program_preview: "function* main() {}" }),
		);

		expect(state.live.size).toBe(0);
		expect(state.completed).toHaveLength(1);
		expect(state.completed[0]).toMatchObject({
			phase: "completed",
			inputPreview: "root input",
			programPreview: "function* main() {}",
			resultPreview: "done",
		});
		expect(state.completed[0]?.nodes.map((node) => [node.id, node.phase])).toEqual([
			["run-1", "completed"],
			["tool-1", "started"],
		]);
	});

	it("folds nested runs into the root tree without replacing root metadata", () => {
		const root = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ input_preview: "root input", program_preview: "function* main() {}" }),
		);
		const nested = reduceYardExecution(
			root,
			event({
				run_id: "run-2",
				node_id: "run-2",
				parent_id: "tool-1",
				seq: 2,
				node: { kind: "run", depth: 1 },
				input_preview: "nested input",
			}),
		);
		const tree = nested.live.get("trace-1");

		expect(tree?.runId).toBe("run-1");
		expect(tree?.inputPreview).toBe("root input");
		expect(tree?.nodes.map((node) => node.id)).toEqual(["run-1:root", "run-2"]);
	});
});

describe("Yard anchoring", () => {
	it("keeps every trace under a shared tool call and relocates it when the source message arrives", () => {
		const state = reduceYardExecution(
			reduceYardExecution(EMPTY_YARD_STATE, event()),
			event({ trace_id: "trace-2", run_id: "run-2", node_id: "run-2", tool_call_id: "call-1" }),
		);
		const trees = [...state.live.values()];

		expect(anchorYardTrees(trees, [])).toEqual({ perItem: new Map(), trailing: trees });
		const anchored = anchorYardTrees(trees, [{ key: "message-1", toolCallIds: ["call-1"] }]);
		expect(anchored.trailing).toEqual([]);
		expect(anchored.perItem.get("message-1")?.map((tree) => tree.traceId)).toEqual([
			"trace-1",
			"trace-2",
		]);
	});
});

describe("yardTreeToFlow", () => {});

describe("persisted Yard message reconstruction", () => {
	it("reconstructs a multi-node topology from a historical Yard program without an execution payload", async () => {
		const { reconstructCompletedYardExecutions } = await import("../yard-execution");
		const completed = reconstructCompletedYardExecutions([
			{
				id: "call-message",
				role: "tool_call",
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "yard-call",
						name: "yard",
						input: {
							program: `function* main() {
  yield sequence([tool("read", {}), all([infer("fable", { prompt: "x" }), aux("scout", "survey")])]);
}`,
						},
					},
				]),
				created_at: "2026-08-24T20:00:00.000Z",
			},
			{
				role: "tool_result",
				tool_name: "yard-call",
				content: JSON.stringify({ result: { shipped: true }, trace_id: "trace-durable" }),
				created_at: "2026-08-24T20:01:00.000Z",
			},
		]);

		expect(completed).toEqual([
			expect.objectContaining({
				traceId: "trace-durable",
				phase: "completed",
				toolCallId: "yard-call",
				nodes: expect.arrayContaining([
					expect.objectContaining({ node: { kind: "run", depth: 0 } }),
					expect.objectContaining({ node: { kind: "tool", name: "read" } }),
					expect.objectContaining({ node: { kind: "inference", model: "fable" } }),
				]),
				programPreview: expect.stringContaining("sequence"),
				resultPreview: JSON.stringify({ shipped: true }),
			}),
		]);
		const [historical] = completed;
		if (!historical) throw new Error("missing reconstructed Yard execution");
		expect(historical.nodes.every((node) => node.phase === "settled")).toBe(true);
		expect(yardProgress(historical)).toEqual({ total: 6, settled: 6, failed: 0, running: 0 });
	});

	it("preserves a long persisted Yard program verbatim for the run inspector", async () => {
		const { reconstructCompletedYardExecutions } = await import("../yard-execution");
		const program = `function* main() {\n${'  yield tool("read", {});\n'.repeat(200)}\n}`;
		expect(program.length).toBeGreaterThan(4000);
		const [tree] = reconstructCompletedYardExecutions([
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "long-call", name: "yard", input: { program } },
				]),
			},
			{ role: "tool_result", tool_name: "long-call", content: JSON.stringify({ result: "done" }) },
		]);
		expect(tree?.programPreview).toBe(program);
		expect(tree?.nodes.find((node) => node.node.kind === "run")?.detail?.program).toBe(program);
	});

	it("uses the persisted Yard call ID when an ordinary result has no trace ID", async () => {
		const { reconstructCompletedYardExecutions } = await import("../yard-execution");
		const completed = reconstructCompletedYardExecutions([
			{
				role: "tool_call",
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "call_a378",
						name: "yard",
						input: { program: "function* main() { return { done: true }; }" },
					},
				]),
			},
			{
				role: "tool_result",
				tool_name: "call_a378",
				content: JSON.stringify({ result: { done: true } }),
			},
		]);

		expect(completed).toEqual([
			expect.objectContaining({
				traceId: "call_a378",
				runId: "call_a378",
				toolCallId: "call_a378",
				phase: "completed",
				nodes: expect.arrayContaining([
					expect.objectContaining({ node: { kind: "run", depth: 0 } }),
				]),
				resultPreview: JSON.stringify({ done: true }),
			}),
		]);
	});

	it("passes real persisted result strings and ContentBlock result payloads to the result formatter", async () => {
		const { reconstructCompletedYardExecutions } = await import("../yard-execution");
		const program = "function* main() { return { ok: true }; }";
		const result = { listing: "first\nsecond", status: "ok" };
		const calls = [
			{ type: "tool_use", id: "direct", name: "yard", input: { program } },
			{ type: "tool_use", id: "blocks", name: "yard", input: { program } },
		];
		const completed = reconstructCompletedYardExecutions([
			{ role: "tool_call", content: JSON.stringify(calls) },
			{ role: "tool_result", tool_name: "direct", content: JSON.stringify({ result }) },
			{
				role: "tool_result",
				tool_name: "blocks",
				content: JSON.stringify([{ type: "text", text: JSON.stringify({ result }) }]),
			},
		]);

		for (const tree of completed) {
			const resultNode = yardTreeToFlow(tree).nodes.find((node) => node.data.kind === "result");
			expect(resultNode?.data.summary).toMatch(/^object · 2 keys · /);
			expect(resultNode?.data.detail?.result).toBe(
				'{\n  "listing": "first\\nsecond",\n  "status": "ok"\n}',
			);
		}
	});
	it("keeps duration-suffixed persisted Yard results intact for graph formatting", async () => {
		const { reconstructCompletedYardExecutions } = await import("../yard-execution");
		const program = "function* main() { return { ok: true }; }";
		const raw = `${JSON.stringify({
			result: { listing: "first\nsecond", status: "ok" },
			trace_id: "trace-suffixed",
			usage: { input_tokens: 1 },
		})}\n\n[duration: 900.005s]`;
		const [tree] = reconstructCompletedYardExecutions([
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "suffixed", name: "yard", input: { program } },
				]),
			},
			{ role: "tool_result", tool_name: "suffixed", content: raw },
		]);

		if (!tree) throw new Error("missing reconstructed tree");
		expect(tree).toMatchObject({ traceId: "trace-suffixed", resultPreview: raw });
		const resultNode = yardTreeToFlow(tree).nodes.find((node) => node.data.kind === "result");
		expect(resultNode?.data).toMatchObject({
			summary: `object · 2 keys · ${new TextEncoder().encode(raw).byteLength} B`,
			detail: {
				result: '{\n  "listing": "first\\nsecond",\n  "status": "ok"\n}',
				metadata: "[duration: 900.005s]",
			},
		});
	});
});

describe("message/live reconciliation", () => {
	it("uses a persisted call program over the bounded live lifecycle preview", async () => {
		const { reconcileYardExecutions } = await import("../yard-execution");
		const program = `function* main() {\n${'  yield tool("read", {});\n'.repeat(200)}\n}`;
		const preview = `${program.slice(0, 4000)}…`;
		const live = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ tool_call_id: "call-1", program_preview: preview }),
		);
		const state = reconcileYardExecutions(live, [
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "call-1", name: "yard", input: { program } },
				]),
			},
		]);
		const tree = state.live.get("trace-1");
		expect(tree?.programPreview).toBe(program);
		expect(tree?.nodes.find((node) => node.node.kind === "run")?.detail?.program).toBe(program);
	});

	it("keeps the lifecycle preview when no persisted call program is available", async () => {
		const { reconcileYardExecutions } = await import("../yard-execution");
		const preview = "function* main() { /* lifecycle preview */ …";
		const live = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ tool_call_id: "call-without-message", program_preview: preview }),
		);
		const state = reconcileYardExecutions(live, []);
		const tree = state.live.get("trace-1");
		expect(tree?.programPreview).toBe(preview);
		if (!tree) throw new Error("missing live Yard execution");
		expect(
			yardTreeToFlow(tree).nodes.find((node) => node.data.kind === "run")?.data.detail?.program,
		).toBe(preview);
	});

	it("replaces a live replay graph with its program-derived durable completion", async () => {
		const { reconcileYardExecutions } = await import("../yard-execution");
		const live = reduceYardExecution(EMPTY_YARD_STATE, event());
		const state = reconcileYardExecutions(live, [
			{
				role: "tool_call",
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "call-1",
						name: "yard",
						input: { program: `function* main() { yield tool("read", {}); }` },
					},
				]),
			},
			{
				role: "tool_result",
				tool_name: "call-1",
				content: JSON.stringify({ trace_id: "trace-1", result: "done" }),
			},
		]);

		expect(state.live.size).toBe(0);
		expect(state.completed).toEqual([
			expect.objectContaining({
				traceId: "trace-1",
				nodes: expect.arrayContaining([
					expect.objectContaining({ node: { kind: "tool", name: "read" } }),
				]),
			}),
		]);
	});
});

describe("yardTreeToFlow visual metadata and compact tree layout", () => {});

describe("Yard result convergence", () => {});

describe("static Yard detail metadata", () => {
	it("keeps complete literal arguments, prompts, and instructions for scrollable inspectors", async () => {
		const { extractYardProgramTopology } = await import("../yard-execution");
		const args = `{ path: "${"a".repeat(260)}", nested: { answer: true } }`;
		const prompt = "describe ".repeat(40);
		const instructions = "inspect ".repeat(40);
		const nodes = extractYardProgramTopology(
			`function* main() { yield all([tool("read", ${args}), infer("fable", { prompt: "${prompt}", schema: {} }), aux("scout", "${instructions}")]); yield tool(name, args); }`,
			"detail",
		);

		expect(nodes.map((node) => node.detail)).toEqual([
			expect.objectContaining({ program: expect.stringContaining("function* main") }),
			undefined,
			expect.objectContaining({ args }),
			expect.objectContaining({ prompt, schema: "{}" }),
			expect.objectContaining({ instructions }),
			expect.objectContaining({ args: "dynamic" }),
		]);
	});
});

describe("lexically safe Yard topology extraction", () => {
	it("keeps the full infer prompt and nested schema from the live review program", () => {
		const program = `function* main(input) {
	const reviews = yield all([
		aux("code", \`Review \${input.cwd}: don't truncate nested \${{ a: [1, { b: true }] }}.\`),
		aux("tests", "check tests"),
	]);
	return yield infer(input.planner_model, {
		prompt: "Synthesize these three reviews of tonight's Yard panel work into a compact follow-up plan...",
		input: { reviews, nested: { records: [{ name: "review" }] } },
		schema: { type: "object", properties: { verdict: { type: "string" }, followups: { type: "array", items: { type: "string" } } }, required: ["verdict", "followups"] },
	});
}`;
		const nodes = extractYardProgramTopology(program, "live-review");
		const inference = nodes.find((node) => node.node.kind === "inference");
		expect(inference).toMatchObject({
			node: { kind: "inference", model: "infer (dynamic)" },
			detail: {
				prompt:
					"Synthesize these three reviews of tonight's Yard panel work into a compact follow-up plan...",
				schema: `{ type: "object", properties: { verdict: { type: "string" }, followups: { type: "array", items: { type: "string" } } }, required: ["verdict", "followups"] }`,
			},
		});
		expect(nodes.find((node) => node.node.name === "aux: code")?.detail?.instructions).toContain(
			"don't truncate",
		);
	});
});

function assertFlowIntegrity(
	tree: import("../yard-execution").YardTreeSnapshot,
	staticOnly = false,
) {
	const flow = yardTreeToFlow(tree);
	const ids = new Set(flow.nodes.map((node) => node.id));
	const rendered = flow.nodes.filter((node) => node.data.kind !== "result");
	expect(rendered).toHaveLength(tree.nodes.length);
	expect(new Set(rendered.map((node) => node.id))).toEqual(
		new Set(tree.nodes.map((node) => node.id)),
	);
	expect(flow.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
	expect(flow.edges.filter((edge) => edge.target === `${tree.runId}:result`)).toHaveLength(1);
	expect(new Set(flow.nodes.map((node) => node.id)).size).toBe(flow.nodes.length);
	if (staticOnly) {
		const staticIds = new Set(
			extractYardProgramTopology(tree.programPreview, tree.runId).map((node) => node.id),
		);
		staticIds.add(`${tree.runId}:result`);
		expect(flow.nodes.every((node) => staticIds.has(node.id))).toBe(true);
	}
}

describe("static Yard topology lifecycle matching", () => {
	it("decorates static nodes without creating orphans throughout a live sequence", () => {
		const program = `function* main(input) {
	const listing = yield tool("boundless_bash", { command: "git log" });
	const reviews = yield all([aux("code", "review code"), aux("tests", "review tests"), aux("docs", "review docs")]);
	return yield infer(input.planner_model, { prompt: "Synthesize tonight's reviews", schema: { type: "object", properties: { verdict: { type: "string" } } } });
}`;
		const events = [
			event({ program_preview: program, node_id: "runtime-root", run_id: "runtime-root" }),
			event({
				seq: 2,
				node_id: "runtime-tool",
				parent_id: "runtime-root",
				node: { kind: "tool", name: "boundless_bash" },
			}),
			event({
				seq: 3,
				phase: "completed",
				node_id: "runtime-tool",
				parent_id: "runtime-root",
				node: { kind: "tool", name: "boundless_bash" },
			}),
			event({
				seq: 4,
				node_id: "runtime-code",
				parent_id: "runtime-root",
				node: { kind: "tool", name: "aux: code" },
			}),
			event({
				seq: 5,
				node_id: "runtime-tests",
				parent_id: "runtime-root",
				node: { kind: "tool", name: "aux: tests" },
			}),
			event({
				seq: 6,
				node_id: "runtime-docs",
				parent_id: "runtime-root",
				node: { kind: "tool", name: "aux: docs" },
			}),
			event({
				seq: 7,
				node_id: "runtime-infer",
				parent_id: "runtime-root",
				node: { kind: "inference", model: "gpt-5.6-sol" },
			}),
			event({
				seq: 8,
				phase: "completed",
				node_id: "runtime-root",
				run_id: "runtime-root",
			}),
		];
		let state = EMPTY_YARD_STATE;
		let count = 0;
		for (const next of events) {
			state = reduceYardExecution(state, next);
			const tree =
				state.live.get("trace-1") ?? state.completed.find((tree) => tree.traceId === "trace-1");
			if (!tree) throw new Error("missing tree");
			if (count === 0) count = tree.nodes.length;
			expect(tree.nodes).toHaveLength(count);
			assertFlowIntegrity(tree);
			const ids = new Set(tree.nodes.map((node) => node.id));
			expect(tree.nodes.filter((node) => node.parentId === null).map((node) => node.id)).toEqual([
				"runtime-root:root",
			]);
			expect(tree.nodes.every((node) => node.parentId === null || ids.has(node.parentId))).toBe(
				true,
			);
		}
	});
	it("normalizes aux names for static lifecycle matching without conflating identities", async () => {
		const { effectMatches } = await import("../yard-execution");
		const staticNodes = extractYardProgramTopology(
			`function* main() { yield all([aux("reviewer", "review"), aux("scout", "survey")]); }`,
			"keys",
		);
		const reviewer = staticNodes.find(
			(node) => node.node.kind === "tool" && node.node.name === "aux: reviewer",
		);
		const scout = staticNodes.find(
			(node) => node.node.kind === "tool" && node.node.name === "aux: scout",
		);
		if (!reviewer || !scout) throw new Error("missing static aux nodes");
		const runtime = { node: { kind: "tool" as const, name: "aux:reviewer" } };
		expect(effectMatches(reviewer, runtime)).toBe(true);
		expect(effectMatches(scout, runtime)).toBe(false);
	});

	it("replays the live aux trace against the static skeleton without runtime duplicates", () => {
		const program = `function* main(input) {
		yield tool("boundless_bash", { command: "git status" });
		yield all([aux("reviewer", "review first"), aux("reviewer", "review second")]);
		return yield sequence([tool("boundless_read", { file_path: "x" }), infer(input.model, { prompt: "summarize" })]);
	}`;
		const events = [
			event({ program_preview: program, node_id: "root-live", run_id: "root-live" }),
			event({
				seq: 2,
				node_id: "runtime-tool",
				parent_id: "root-live",
				node: { kind: "tool", name: "boundless_bash" },
			}),
			event({
				seq: 3,
				phase: "completed",
				node_id: "runtime-tool",
				parent_id: "root-live",
				node: { kind: "tool", name: "boundless_bash" },
			}),
			event({
				seq: 4,
				node_id: "runtime-all",
				parent_id: "root-live",
				node: { kind: "tool", name: "all" },
			}),
			event({
				seq: 5,
				node_id: "runtime-reviewer-1",
				parent_id: "runtime-all",
				node: { kind: "tool", name: "aux:reviewer" },
			}),
			event({
				seq: 6,
				node_id: "runtime-reviewer-2",
				parent_id: "runtime-all",
				node: { kind: "tool", name: "aux:reviewer" },
			}),
			event({
				seq: 7,
				phase: "completed",
				node_id: "runtime-reviewer-1",
				parent_id: "runtime-all",
				node: { kind: "tool", name: "aux:reviewer" },
			}),
			event({
				seq: 8,
				node_id: "runtime-sequence",
				parent_id: "root-live",
				node: { kind: "tool", name: "sequence" },
			}),
			event({
				seq: 9,
				node_id: "runtime-infer",
				parent_id: "runtime-sequence",
				node: { kind: "inference", model: "gpt-5.6-sol" },
			}),
		];
		let state = EMPTY_YARD_STATE;
		let count = 0;
		for (const next of events) {
			state = reduceYardExecution(state, next);
			const snapshot = state.live.get("trace-1");
			if (!snapshot) throw new Error("missing live tree");
			if (!count) count = snapshot.nodes.length;
			expect(snapshot.nodes).toHaveLength(count);
			assertFlowIntegrity(snapshot, true);
		}
		const snapshot = state.live.get("trace-1");
		if (!snapshot) throw new Error("missing final tree");
		const reviewers = snapshot.nodes.filter((node) => node.effectKey === "aux:reviewer");
		expect(reviewers.map((node) => node.runtimeId)).toEqual([
			"runtime-reviewer-1",
			"runtime-reviewer-2",
		]);
		const flow = yardTreeToFlow(snapshot);
		const chain = ["Yard run", "boundless_bash", "All", "Sequence", "Result"];
		expect(
			flow.nodes
				.filter((node) => chain.includes(node.data.label) && !node.parentId)
				.sort((a, b) => a.position.x - b.position.x)
				.map((node) => node.data.label),
		).toEqual(chain);
	});

	it("binds repeated identical aux effects in source order without runtime duplicates", () => {
		const program = `function* main() { yield all([aux("reviewer", "one"), aux("reviewer", "two")]); }`;
		let state = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ program_preview: program, node_id: "root", run_id: "root" }),
		);
		state = reduceYardExecution(
			state,
			event({
				seq: 2,
				node_id: "runtime-all",
				parent_id: "root",
				node: { kind: "tool", name: "all" },
			}),
		);
		for (const [seq, node_id] of [
			[3, "first"],
			[4, "second"],
		] as const) {
			state = reduceYardExecution(
				state,
				event({
					seq,
					node_id,
					parent_id: "runtime-all",
					node: { kind: "tool", name: "aux: reviewer" },
				}),
			);
			const snapshot = state.live.get("trace-1");
			if (!snapshot) throw new Error("missing tree");
			assertFlowIntegrity(snapshot);
		}
		const nodes =
			state.live.get("trace-1")?.nodes.filter((node) => node.node.name === "aux: reviewer") ?? [];
		expect(nodes.map((node) => node.runtimeId)).toEqual(["first", "second"]);
	});

	it("scopes equivalent effects to their mapped parent container and preserves unmatched runtime subtrees", () => {
		const program = `function* main() { yield sequence([all([aux("reviewer", "one")]), all([aux("reviewer", "two")])]); }`;
		let state = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ program_preview: program, node_id: "root", run_id: "root" }),
		);
		const snapshot = state.live.get("trace-1");
		if (!snapshot) throw new Error("missing tree");
		const all = snapshot.nodes.filter((node) => node.construct === "all");
		state = reduceYardExecution(
			state,
			event({
				seq: 2,
				node_id: "runtime-sequence",
				parent_id: "root",
				node: { kind: "tool", name: "sequence" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				seq: 3,
				node_id: "runtime-all-1",
				parent_id: "runtime-sequence",
				node: { kind: "tool", name: "all" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				seq: 4,
				node_id: "runtime-all-2",
				parent_id: "runtime-sequence",
				node: { kind: "tool", name: "all" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				seq: 5,
				node_id: "runtime-review-2",
				parent_id: "runtime-all-2",
				node: { kind: "tool", name: "aux: reviewer" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				seq: 6,
				node_id: "dynamic-child",
				parent_id: "runtime-review-2",
				node: { kind: "tool", name: "unparsed" },
			}),
		);
		const updated = state.live.get("trace-1");
		if (!updated) throw new Error("missing tree");
		assertFlowIntegrity(updated);
		expect(updated.nodes.find((node) => node.runtimeId === "runtime-review-2")?.parentId).toBe(
			all[1]?.id,
		);
		expect(updated.nodes.find((node) => node.id === "dynamic-child")?.parentId).toBe(
			updated.nodes.find((node) => node.runtimeId === "runtime-review-2")?.id,
		);
	});
});

describe("variable-composed static topology lifecycle matching", () => {
	it("binds replayed aux runtime events to children adopted from a yielded all variable", () => {
		const program = `function* main() {
			const jobs = [aux("scout", "A"), aux("scout", "B"), aux("scout", "C")];
			return yield all(jobs, { concurrency: 3, errors: "settled" });
		}`;
		let state = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ program_preview: program, node_id: "root", run_id: "root" }),
		);
		state = reduceYardExecution(
			state,
			event({
				seq: 2,
				node_id: "runtime-all",
				parent_id: "root",
				node: { kind: "tool", name: "all" },
			}),
		);
		for (const [seq, node_id] of [
			[3, "runtime-scout-1"],
			[4, "runtime-scout-2"],
			[5, "runtime-scout-3"],
		] as const) {
			state = reduceYardExecution(
				state,
				event({
					seq,
					node_id,
					parent_id: "runtime-all",
					node: { kind: "tool", name: "aux:scout" },
				}),
			);
		}
		const snapshot = state.live.get("trace-1");
		if (!snapshot) throw new Error("missing tree");
		const all = snapshot.nodes.find((node) => node.construct === "all");
		if (!all) throw new Error("missing all");
		const scouts = snapshot.nodes.filter((node) => node.parentId === all.id);

		expect(scouts.map((node) => node.runtimeId)).toEqual([
			"runtime-scout-1",
			"runtime-scout-2",
			"runtime-scout-3",
		]);
		assertFlowIntegrity(snapshot, true);
	});
});
