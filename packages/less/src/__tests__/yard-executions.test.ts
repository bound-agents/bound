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

	// A nested yard() call opens its own run with a fresh run_id but the SAME
	// trace_id, parented under the dispatching tool effect. It is one
	// execution tree and must fold into one card — not surface as a second
	// disconnected live tree.
	it("folds a nested run into its parent tree by trace_id", () => {
		let state = reduceYardExecution(EMPTY_YARD_STATE, event());
		state = reduceYardExecution(
			state,
			event({
				node_id: "eff-yard",
				parent_id: "run-1",
				seq: 2,
				node: { kind: "tool", name: "yard" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				run_id: "run-2",
				node_id: "run-2",
				parent_id: "eff-yard",
				seq: 3,
				node: { kind: "run", depth: 1 },
				input_preview: '{"nested":true}',
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				run_id: "run-2",
				node_id: "eff-inner",
				parent_id: "run-2",
				seq: 4,
				node: { kind: "tool", name: "boundless_bash" },
			}),
		);

		expect(state.live.size).toBe(1);
		const tree = [...state.live.values()][0];
		expect(tree?.runId).toBe("run-1");
		expect(tree?.nodes.map((node) => node.id)).toEqual(["run-1", "eff-yard", "run-2", "eff-inner"]);
		// The nested run's input_preview is node detail, not tree detail — it
		// must not overwrite the root's (absent) preview.
		expect(tree?.inputPreview).toBeUndefined();
	});

	it("commits the whole tree, nested nodes included, when the ROOT run terminates", () => {
		let state = reduceYardExecution(EMPTY_YARD_STATE, event());
		state = reduceYardExecution(
			state,
			event({
				node_id: "eff-yard",
				parent_id: "run-1",
				seq: 2,
				node: { kind: "tool", name: "yard" },
			}),
		);
		state = reduceYardExecution(
			state,
			event({
				run_id: "run-2",
				node_id: "run-2",
				parent_id: "eff-yard",
				seq: 3,
				node: { kind: "run", depth: 1 },
			}),
		);
		// Nested run terminating is NOT tree-terminal.
		state = reduceYardExecution(
			state,
			event({
				run_id: "run-2",
				node_id: "run-2",
				parent_id: "eff-yard",
				seq: 4,
				phase: "completed",
				node: { kind: "run", depth: 1 },
			}),
		);
		expect(state.live.size).toBe(1);
		expect(state.completed).toHaveLength(0);

		state = reduceYardExecution(
			state,
			event({ seq: 5, phase: "completed", result_preview: '{"ok":true}' }),
		);
		expect(state.live.size).toBe(0);
		expect(state.completed).toHaveLength(1);
		expect(state.completed[0]?.nodes.map((node) => node.id)).toEqual([
			"run-1",
			"eff-yard",
			"run-2",
		]);
		expect(state.completed[0]?.nodes.find((node) => node.id === "run-2")?.phase).toBe("completed");
	});
});
