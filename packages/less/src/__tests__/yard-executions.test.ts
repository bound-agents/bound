import { describe, expect, it } from "bun:test";
import type { YardExecutionEvent } from "@bound/shared";
import { EMPTY_YARD_STATE, reduceYardExecution } from "../tui/hooks/useYardExecutions";

const event = (overrides: Partial<YardExecutionEvent> = {}): YardExecutionEvent => ({
	thread_id: "thread-1",
	trace_id: "trace-1",
	run_id: "run-1",
	node_id: "run-1",
	parent_id: null,
	seq: 1,
	phase: "started",
	node: { kind: "run", depth: 0 },
	...overrides,
});

describe("reduceYardExecution", () => {
	it("creates a live root and appends children in start-sequence order", () => {
		let state = reduceYardExecution(EMPTY_YARD_STATE, event({ input_preview: '{"n":1}' }));
		state = reduceYardExecution(
			state,
			event({
				node_id: "tool-b",
				parent_id: "run-1",
				seq: 3,
				node: { kind: "tool", name: "aux:second" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				node_id: "tool-a",
				parent_id: "run-1",
				seq: 2,
				node: { kind: "tool", name: "aux:first" },
			}),
		);
		const tree = [...state.live.values()][0];
		expect(tree?.inputPreview).toBe('{"n":1}');
		expect(tree?.nodes.map((node) => node.id)).toEqual(["run-1", "tool-a", "tool-b"]);
	});

	it("updates a terminal child in place without duplicating it", () => {
		let state = reduceYardExecution(EMPTY_YARD_STATE, event());
		state = reduceYardExecution(
			state,
			event({ node_id: "tool", parent_id: "run-1", seq: 2, node: { kind: "tool", name: "x" } }),
		);
		state = reduceYardExecution(
			state,
			event({
				node_id: "tool",
				parent_id: "run-1",
				seq: 3,
				phase: "completed",
				node: { kind: "tool", name: "x" },
			}),
		);
		const tree = [...state.live.values()][0];
		expect(tree?.nodes.filter((node) => node.id === "tool")).toHaveLength(1);
		expect(tree?.nodes.find((node) => node.id === "tool")?.phase).toBe("completed");
	});

	it("moves a terminal root to completed exactly once", () => {
		let state = reduceYardExecution(EMPTY_YARD_STATE, event());
		const done = event({
			seq: 2,
			phase: "completed",
			result_preview: '{"answer":42}',
			summary: "1 tools · 0 inferences",
		});
		state = reduceYardExecution(state, done);
		state = reduceYardExecution(state, done);
		expect(state.live.size).toBe(0);
		expect(state.completed).toHaveLength(1);
		expect(state.completed[0]?.resultPreview).toContain("42");
	});

	it("ignores orphan child events and stale node revisions", () => {
		const orphan = reduceYardExecution(
			EMPTY_YARD_STATE,
			event({ node_id: "tool", parent_id: "run-1", node: { kind: "tool", name: "x" } }),
		);
		expect(orphan).toBe(EMPTY_YARD_STATE);
		const state = reduceYardExecution(EMPTY_YARD_STATE, event({ seq: 2 }));
		const stale = reduceYardExecution(state, event({ seq: 1, phase: "failed" }));
		expect(stale).toBe(state);
	});
});
