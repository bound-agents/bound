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
