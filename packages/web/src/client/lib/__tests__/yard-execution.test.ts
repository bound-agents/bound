import { describe, expect, it } from "bun:test";
import type { YardExecutionEvent } from "@bound/shared";
import { anchorYardTrees } from "../yard-anchoring";
import { EMPTY_YARD_STATE, reduceYardExecution } from "../yard-execution";
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
		expect(tree?.nodes.map((node) => node.id)).toEqual(["run-1", "run-2"]);
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

describe("yardTreeToFlow", () => {
	it("creates labelled nodes, parent edges, and status classes", () => {
		const state = reduceYardExecution(
			reduceYardExecution(EMPTY_YARD_STATE, event()),
			event({
				node_id: "tool-1",
				parent_id: "run-1",
				seq: 2,
				phase: "failed",
				node: { kind: "tool", name: "boundless_bash" },
				summary: "exit 1",
			}),
		);
		const tree = state.live.get("trace-1");
		if (!tree) throw new Error("missing tree");

		const flow = yardTreeToFlow(tree);
		expect(flow.nodes.map((node) => [node.id, node.data.label, node.data.phase])).toEqual([
			["run-1", "Yard run", "started"],
			["tool-1", "boundless_bash", "failed"],
		]);
		expect(flow.edges).toEqual([
			expect.objectContaining({ id: "run-1:tool-1", source: "run-1", target: "tool-1" }),
		]);
	});

	it("allocates unique rows across branches and tolerates cyclic or missing parents", () => {
		let state = reduceYardExecution(EMPTY_YARD_STATE, event());
		for (const next of [
			event({ node_id: "left", parent_id: "run-1", seq: 2, node: { kind: "tool", name: "left" } }),
			event({
				node_id: "right",
				parent_id: "run-1",
				seq: 3,
				node: { kind: "tool", name: "right" },
			}),
			event({
				node_id: "left-child",
				parent_id: "left",
				seq: 4,
				node: { kind: "tool", name: "child" },
			}),
			event({
				node_id: "orphan",
				parent_id: "missing",
				seq: 5,
				node: { kind: "tool", name: "orphan" },
			}),
			event({
				node_id: "cycle-a",
				parent_id: "cycle-b",
				seq: 6,
				node: { kind: "tool", name: "a" },
			}),
			event({
				node_id: "cycle-b",
				parent_id: "cycle-a",
				seq: 7,
				node: { kind: "tool", name: "b" },
			}),
		])
			state = reduceYardExecution(state, next);

		const tree = state.live.get("trace-1");
		if (!tree) throw new Error("missing tree");
		const flow = yardTreeToFlow(tree);
		expect(new Set(flow.nodes.map((node) => node.position.y)).size).toBe(flow.nodes.length);
		expect(flow.edges.map((edge) => edge.id)).toEqual([
			"run-1:left",
			"run-1:right",
			"left:left-child",
		]);
	});
});
