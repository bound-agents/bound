import { describe, expect, it } from "bun:test";
import type { YardTreeSnapshot } from "../yard-execution";
import { extractYardProgramTopology } from "../yard-execution";
import { yardTreeToFlow } from "../yard-graph";

const tonight = `function* main(input) {
  const listing = yield tool("boundless_bash", { command: "git log" });
  const reviews = yield all([aux("code", "review code"), aux("tests", "review tests"), aux("docs", "review docs")]);
  return yield infer(input.planner_model, { prompt: "Synthesize", schema: {} });
}`;

function tree(program: string, phase: YardTreeSnapshot["phase"] = "started"): YardTreeSnapshot {
	return {
		traceId: "trace",
		runId: "trace",
		phase,
		nodes: extractYardProgramTopology(program, "trace"),
	};
}

describe("Yard execution-order topology", () => {
	it("chains tonight's top-level yields in program order through Result", () => {
		const flow = yardTreeToFlow(tree(tonight));
		const id = (label: string) => flow.nodes.find((node) => node.data.label === label)?.id;
		const root = id("Yard run");
		const bash = id("boundless_bash");
		const all = id("All");
		const infer = flow.nodes.find((node) => node.data.kind === "inference")?.id;
		const result = "trace:result";
		expect([root, bash, all, infer, result]).not.toContain(undefined);
		expect(flow.edges.map((edge) => `${edge.source}:${edge.target}`)).toEqual(
			expect.arrayContaining([
				`${root}:${bash}`,
				`${bash}:${all}`,
				`${all}:${infer}`,
				`${infer}:${result}`,
			]),
		);
	});

	it("renders all as a container with parented parallel children and no inter-child edges", () => {
		const flow = yardTreeToFlow(tree(tonight));
		const all = flow.nodes.find((node) => node.data.label === "All");
		if (!all) throw new Error("missing all container");
		const children = flow.nodes.filter((node) => node.parentId === all.id);
		expect(all.type).toBe("yardGroup");
		expect(children.map((node) => node.data.kind)).toEqual(["aux", "aux", "aux"]);
		expect(children.every((node) => node.extent === "parent")).toBe(true);
		expect(
			flow.edges.some(
				(edge) =>
					children.some((node) => edge.source === node.id) &&
					children.some((node) => edge.target === node.id),
			),
		).toBe(false);
	});

	it("chains sequence children and supports nested all containers", () => {
		const flow = yardTreeToFlow(
			tree(`function* main() {
      yield sequence([tool("first", {}), all([aux("a", "a"), aux("b", "b")]), tool("last", {})]);
    }`),
		);
		const sequence = flow.nodes.find((node) => node.data.label === "Sequence");
		const all = flow.nodes.find((node) => node.data.label === "All");
		if (!sequence || !all) throw new Error("missing containers");
		const sequenceChildren = flow.nodes.filter((node) => node.parentId === sequence.id);
		expect(all.parentId).toBe(sequence.id);
		expect(sequenceChildren.every((node) => node.extent === "parent")).toBe(true);
		expect(flow.edges.map((edge) => `${edge.source}:${edge.target}`)).toEqual(
			expect.arrayContaining([
				`${sequenceChildren[0]?.id}:${all.id}`,
				`${all.id}:${sequenceChildren[2]?.id}`,
			]),
		);
	});

	it("derives aggregate container state from its children", () => {
		const snapshot = tree(tonight);
		const all = snapshot.nodes.find((node) => node.construct === "all");
		if (!all) throw new Error("missing all");
		snapshot.nodes = snapshot.nodes.map((node, index) =>
			node.parentId === all.id ? { ...node, phase: index === 3 ? "failed" : "completed" } : node,
		);
		expect(yardTreeToFlow(snapshot).nodes.find((node) => node.id === all.id)?.data.phase).toBe(
			"failed",
		);
	});

	it("lays out containers deterministically without sibling overlap", () => {
		const first = yardTreeToFlow(tree(tonight));
		const second = yardTreeToFlow(tree(tonight));
		expect(second).toEqual(first);
		const all = first.nodes.find((node) => node.data.label === "All");
		if (!all) throw new Error("missing all");
		const children = first.nodes.filter((node) => node.parentId === all.id);
		expect(new Set(children.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(
			children.length,
		);
	});

	describe("result detail preservation", () => {
		for (const [name, resultPreview, expected] of [
			["an empty string", "", ""],
			["serialized zero", "0", "0"],
			["serialized false", "false", "false"],
			["serialized null", "null", "null"],
		] as const) {
			it(`keeps ${name} in the Result node detail`, () => {
				const flow = yardTreeToFlow({ ...tree(tonight, "completed"), resultPreview });
				const result = flow.nodes.find((node) => node.data.kind === "result");
				expect(result?.data.detail).toMatchObject({ result: expected });
			});
		}
	});
});

describe("live Yard topology contracts", () => {
	const liveProgram = `function* main(input) {
		yield tool("read", {});
		yield all([aux("code", "review"), aux("tests", "test")]);
		return yield infer(input.model, { prompt: "summarize" });
	}`;

	it("renders the complete pending program graph from the root lifecycle preview before any effects run", async () => {
		const { EMPTY_YARD_STATE, reduceYardExecution } = await import("../yard-execution");
		const state = reduceYardExecution(EMPTY_YARD_STATE, {
			thread_id: "thread",
			trace_id: "trace-live",
			run_id: "run-live",
			node_id: "run-live",
			parent_id: null,
			seq: 1,
			phase: "started",
			node: { kind: "run", depth: 0 },
			program_preview: liveProgram,
		});
		const tree = state.live.get("trace-live");
		if (!tree) throw new Error("missing live tree");
		const flow = yardTreeToFlow(tree);
		const labels = flow.nodes.map((node) => node.data.label);

		expect(labels).toEqual(
			expect.arrayContaining([
				"Yard run",
				"read",
				"All",
				"aux: code",
				"aux: tests",
				"infer (dynamic)",
				"Result",
			]),
		);
		expect(
			flow.nodes
				.filter((node) => node.data.kind !== "run" && node.data.kind !== "result")
				.every((node) => node.data.phase === "unknown"),
		).toBe(true);
		const id = (label: string) => flow.nodes.find((node) => node.data.label === label)?.id;
		expect(
			flow.edges.some((edge) => edge.source === id("Yard run") && edge.target === id("read")),
		).toBe(true);
		expect(
			flow.edges.some((edge) => edge.source === id("All") && edge.target === id("infer (dynamic)")),
		).toBe(true);
		expect(
			flow.edges.some(
				(edge) =>
					edge.target === "run-live:result" &&
					flow.nodes.find((node) => node.id === edge.source)?.data.kind === "inference",
			),
		).toBe(true);

		const afterTool = reduceYardExecution(state, {
			thread_id: "thread",
			trace_id: "trace-live",
			run_id: "run-live",
			node_id: "runtime-read",
			parent_id: "run-live",
			seq: 2,
			phase: "started",
			node: { kind: "tool", name: "read" },
		});
		const updated = afterTool.live.get("trace-live");
		if (!updated) throw new Error("missing updated live tree");
		const updatedFlow = yardTreeToFlow(updated);
		expect(updatedFlow.nodes.map((node) => node.id)).toEqual(flow.nodes.map((node) => node.id));
		expect(updatedFlow.nodes.find((node) => node.id === id("read"))?.data.phase).toBe("started");
	});

	it("upgrades an early runtime-only live card to the persisted program skeleton without losing lifecycle state", async () => {
		const { EMPTY_YARD_STATE, reconcileYardExecutions, reduceYardExecution } = await import(
			"../yard-execution"
		);
		const started = reduceYardExecution(EMPTY_YARD_STATE, {
			thread_id: "thread",
			trace_id: "trace-persisted",
			run_id: "run-persisted",
			node_id: "run-persisted",
			parent_id: null,
			seq: 1,
			phase: "started",
			node: { kind: "run", depth: 0 },
			tool_call_id: "call-persisted",
		});
		const running = reduceYardExecution(started, {
			thread_id: "thread",
			trace_id: "trace-persisted",
			run_id: "run-persisted",
			node_id: "runtime-read",
			parent_id: "run-persisted",
			seq: 2,
			phase: "started",
			node: { kind: "tool", name: "read" },
			tool_call_id: "call-persisted",
		});
		const reconciled = reconcileYardExecutions(running, [
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "call-persisted", name: "yard", input: { program: liveProgram } },
				]),
			},
		]);
		const live = reconciled.live.get("trace-persisted");
		if (!live) throw new Error("missing reconciled live tree");
		const flow = yardTreeToFlow(live);
		expect(flow.nodes.map((node) => node.data.label)).toEqual(
			expect.arrayContaining(["Yard run", "read", "All", "Result"]),
		);
		expect(flow.nodes.find((node) => node.data.label === "read")?.data.phase).toBe("started");
		expect(
			flow.nodes.filter((node) => node.data.kind !== "result").map((node) => node.id),
		).not.toContain("runtime-read");
	});

	it("labels sequence children with source order and all containers with parallel cardinality", () => {
		const flow = yardTreeToFlow(
			tree(`function* main() {
			yield sequence([tool("first", {}), infer("model", { prompt: "next" }), tool("last", {})]);
			yield all([aux("one", "one"), aux("two", "two")]);
		}`),
		);
		const sequence = flow.nodes.find((node) => node.data.construct === "sequence");
		const all = flow.nodes.find((node) => node.data.construct === "all");
		if (!sequence || !all) throw new Error("missing containers");

		expect(
			flow.nodes.filter((node) => node.parentId === sequence.id).map((node) => node.data.ordinal),
		).toEqual([1, 2, 3]);
		expect(all.data.parallelCount).toBe(2);
		expect(
			flow.nodes
				.filter((node) => node.parentId === all.id)
				.every((node) => node.data.ordinal === undefined),
		).toBe(true);
	});

	it("connects terminal all and sequence containers directly to Result", () => {
		for (const [program, construct] of [
			[
				`function* main() { yield tool("one", {}); yield all([aux("a", "a"), aux("b", "b")]); return 1; }`,
				"all",
			],
			[
				`function* main() { yield sequence([tool("one", {}), infer("model", { prompt: "two" })]); return 1; }`,
				"sequence",
			],
		] as const) {
			const flow = yardTreeToFlow(tree(program));
			const terminal = flow.nodes.find((node) => node.data.construct === construct);
			expect(
				flow.edges.some((edge) => edge.source === terminal?.id && edge.target === "trace:result"),
			).toBe(true);
		}
	});

	it("connects every top-level execution step once and converges each shape on Result", () => {
		for (const program of [
			`function* main() { yield tool("one", {}); yield all([aux("a", "a"), aux("b", "b")]); return 1; }`,
			`function* main() { yield sequence([tool("one", {}), infer("model", { prompt: "two" })]); return 1; }`,
			`function* main() { yield all([aux("a", "a")]); yield tool("after", {}); return 1; }`,
		]) {
			const flow = yardTreeToFlow(tree(program));
			const result = "trace:result";
			const top = flow.nodes.filter(
				(node) => node.data.kind === "run" || (!node.parentId && node.data.kind !== "result"),
			);
			for (const node of top)
				expect(flow.edges.filter((edge) => edge.source === node.id)).toHaveLength(1);
			expect(flow.edges.filter((edge) => edge.target === result)).toHaveLength(1);
		}
	});
});

describe("container geometry contracts", () => {
	it("keeps empty and singleton containers visible, parented, and connected", () => {
		for (const program of [
			"function* main() { yield all([]); }",
			'function* main() { yield sequence([tool("only", {})]); }',
		]) {
			const flow = yardTreeToFlow(tree(program));
			const group = flow.nodes.find((node) => node.type === "yardGroup");
			if (!group) throw new Error("missing container");
			expect(group.width).toBeGreaterThan(184);
			expect(group.height).toBeGreaterThan(68);
			expect(
				flow.edges.some((edge) => edge.source === group.id && edge.target === "trace:result"),
			).toBe(true);
			const children = flow.nodes.filter((node) => node.parentId === group.id);
			expect(children.every((node) => node.extent === "parent")).toBe(true);
		}
	});
});

describe("variable-composed Yard topology", () => {
	const variableComposed = `function* main(input) {
		const jobs = [
			aux("scout", "instruction A"),
			aux("scout", "instruction B"),
			aux("scout", "instruction C"),
		];
		return yield all(jobs, { concurrency: 3, errors: "settled" });
	}`;

	it("adopts a resolved effect array into its yielded all container without stray chain steps", () => {
		const snapshot = tree(variableComposed);
		const flow = yardTreeToFlow(snapshot);
		const all = flow.nodes.find((node) => node.data.construct === "all");
		if (!all) throw new Error("missing all container");
		const children = flow.nodes.filter((node) => node.parentId === all.id);
		const topLevel = flow.nodes
			.filter((node) => !node.parentId)
			.sort((a, b) => a.position.x - b.position.x)
			.map((node) => node.data.label);

		expect(topLevel).toEqual(["Yard run", "All", "Result"]);
		expect(children.map((node) => node.data.label)).toEqual([
			"aux: scout",
			"aux: scout",
			"aux: scout",
		]);
		expect(all.data.parallelCount).toBe(3);
		expect(flow.edges.filter((edge) => edge.target === "trace:result")).toHaveLength(1);
	});

	it("renders a dynamic placeholder when a yielded all argument is not statically resolvable", () => {
		const flow = yardTreeToFlow(
			tree("function* main() { return yield all(parts.map(([name, i]) => aux(name, i))); }"),
		);
		const all = flow.nodes.find((node) => node.data.construct === "all");
		if (!all) throw new Error("missing all container");
		const children = flow.nodes.filter((node) => node.parentId === all.id);

		expect(children).toHaveLength(1);
		expect(children[0]?.data.label).toBe("dynamic ×?");
		expect(all.data.parallelCount).toBe(1);
	});

	it("resolves a trivially assigned effect yielded by identifier", () => {
		const flow = yardTreeToFlow(tree(`function* main() { const t = tool("x", {}); yield t; }`));
		expect(flow.nodes.filter((node) => !node.parentId).map((node) => node.data.label)).toEqual([
			"Yard run",
			"x",
			"Result",
		]);
	});
});

const trace372d30ce = `function* main(input) {
  const log = yield tool("boundless_bash", {});
  const scoping = yield all([aux("reviewer", "review"), aux("scout", "survey")], { concurrency: 2, errors: "settled" });
  const plan = yield sequence([tool("boundless_bash", {}), infer(input.planner_model, { prompt: "plan", schema: {} })]);
  return { commits: log, plan: plan[1] };
}`;

function assertRenderedReducerParity(snapshot: YardTreeSnapshot) {
	const flow = yardTreeToFlow(snapshot);
	const rendered = flow.nodes.filter((node) => node.data.kind !== "result");
	expect(rendered).toHaveLength(snapshot.nodes.length);
	expect(new Set(rendered.map((node) => node.id))).toEqual(
		new Set(snapshot.nodes.map((node) => node.id)),
	);
}

describe("372d30ce Yard layout regression", () => {
	it("keeps both duplicate-name tools and every reducer node in the rendered flow", () => {
		const snapshot = tree(trace372d30ce, "completed");
		const flow = yardTreeToFlow(snapshot);
		const sequence = flow.nodes.find((node) => node.data.construct === "sequence");
		if (!sequence) throw new Error("missing sequence");
		expect(
			flow.nodes.filter((node) => node.parentId === sequence.id).map((node) => node.data.label),
		).toEqual(["boundless_bash", "infer (dynamic)"]);
		assertRenderedReducerParity(snapshot);
	});

	it("sizes a two-child sequence from child widths, one gap, and horizontal padding", () => {
		const flow = yardTreeToFlow(tree(trace372d30ce));
		const sequence = flow.nodes.find((node) => node.data.construct === "sequence");
		if (!sequence) throw new Error("missing sequence");
		expect(sequence.width).toBe(184 * 2 + 34 + 32 * 2);
	});
});

describe("control-flow and lexical static topology", () => {
	const labels = (program: string) =>
		extractYardProgramTopology(program, "control").map((entry) =>
			entry.node.kind === "tool" ? entry.node.name : entry.node.kind,
		);

	it("represents if/else yields as one conditional region", () => {
		const nodes = extractYardProgramTopology(
			`function* main() { if (ok) { yield tool("a", {}); } else { yield tool("b", {}); } }`,
			"control",
		);
		expect(
			nodes.filter(
				(node) => node.node.kind === "tool" && node.node.name === "Conditional (dynamic)",
			),
		).toHaveLength(1);
		expect(
			nodes
				.filter((node) => node.node.kind === "tool" && ["a", "b"].includes(node.node.name))
				.every((node) => node.parentId !== "control:root"),
		).toBe(true);
	});

	it("represents loop and try yields as dynamic regions", () => {
		expect(labels(`function* main() { for (const x of xs) { yield tool("a", {}); } }`)).toContain(
			"Loop (dynamic)",
		);
		expect(
			labels(`function* main() { try { yield tool("a", {}); } catch { yield tool("b", {}); } }`),
		).toContain("Try (dynamic)");
	});

	it("ignores yield-shaped text in comments and strings", () => {
		const nodes = extractYardProgramTopology(
			`function* main() { // yield tool("bad", {})\n const note = "yield tool('also bad', {})"; yield tool("good", {}); }`,
			"control",
		);
		expect(nodes.map((node) => node.node)).toEqual(
			expect.arrayContaining([{ kind: "tool", name: "good" }]),
		);
		expect(nodes.map((node) => node.node)).not.toEqual(
			expect.arrayContaining([{ kind: "tool", name: "bad" }]),
		);
	});

	it("resolves a lexical shadowing binding at its use site", () => {
		expect(
			labels(`function* main() { const t = tool("a", {}); { const t = tool("b", {}); yield t; } }`),
		).toContain("b");
	});

	it("keeps unresolved yields distinct and unwraps parenthesized effects", () => {
		const unresolved = extractYardProgramTopology(
			"function* main() { yield first; yield second; }",
			"control",
		);
		expect(
			unresolved.filter(
				(node) => node.node.kind === "tool" && node.node.name === "Dynamic effect region",
			),
		).toHaveLength(2);
		expect(new Set(unresolved.map((node) => node.id)).size).toBe(unresolved.length);
		expect(labels(`function* main() { yield (tool("wrapped", {})); }`)).toContain("wrapped");
	});
});
