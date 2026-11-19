import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { YardNodeState, YardTreeSnapshot } from "../../lib/yard-execution";
import { installDom } from "../harness/dom";

// YardExecutionPanel renders a Yard run as a SvelteFlow graph plus a status
// header, a live-region progress line, a selectable node inspector, and a
// collapsible result footer. It drives YardFlowNode as the custom node type, so
// mounting the panel is also the only way to exercise YardFlowNode: that
// component's <Handle> throws outside a SvelteFlow store context, so it cannot
// be mounted standalone. SvelteFlow keeps scheduling rAFs under jsdom, so the
// harness settle() never fully quiesces — every test takes an explicit long
// timeout and reads the DOM once it has rendered rather than waiting for idle.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

const TIMEOUT = 30000;

function node(over: Partial<YardNodeState> & Pick<YardNodeState, "id">): YardNodeState {
	return {
		parentId: null,
		node: { kind: "run", depth: 0 },
		phase: "started",
		seq: 0,
		startSeq: 0,
		...over,
	} as YardNodeState;
}

function tree(over: Partial<YardTreeSnapshot> = {}): YardTreeSnapshot {
	return {
		traceId: "abcd1234ef567890",
		runId: "run0",
		phase: "started",
		nodes: [
			node({ id: "run0", node: { kind: "run", depth: 0 }, phase: "started", startSeq: 0 }),
			node({
				id: "tool0",
				parentId: "run0",
				executionParentId: "run0",
				node: { kind: "tool", name: "read" },
				phase: "completed",
				startSeq: 1,
				summary: "read a source file",
			}),
		],
		...over,
	};
}

async function mountPanel(snapshot: YardTreeSnapshot) {
	const Comp = (await import("../../components/YardExecutionPanel.svelte")).default;
	const handle = await dom.mount(Comp, { tree: snapshot });
	unmounts.push(handle.unmount);
	return handle;
}

describe("YardExecutionPanel", () => {
	it(
		"renders the running header, trace id, phase chip and progress counts",
		async () => {
			const { target } = await mountPanel(tree());
			const panel = target.querySelector(".yard-execution-panel");
			expect(panel).not.toBeNull();
			// phase="started" → "Running" heading + chip, "started" class on the section.
			expect(panel?.classList.contains("started")).toBe(true);
			expect(target.querySelector(".eyebrow")?.textContent).toBe("Yard execution");
			// Trace id is shown truncated to the first 8 chars.
			expect(target.querySelector(".trace")?.textContent).toContain("abcd1234");
			expect(target.querySelector(".phase-chip")?.getAttribute("aria-label")).toBe(
				"Execution status: Running",
			);
			// 2 nodes, one completed (settled) one running.
			const progress = target.querySelector(".progress")?.textContent ?? "";
			expect(progress).toContain("1/2 nodes settled");
			expect(progress).toContain("1 running");
		},
		TIMEOUT,
	);

	it(
		"renders the SvelteFlow graph with YardFlowNode custom nodes",
		async () => {
			const { target } = await mountPanel(tree());
			// SvelteFlow mounted and rendered our custom node type.
			expect(target.querySelector(".svelte-flow")).not.toBeNull();
			const flowNodes = target.querySelectorAll(".yard-flow-node");
			expect(flowNodes.length).toBeGreaterThan(0);
			// The run node carries its label and the "Running" status text from YardFlowNode.
			const text = target.querySelector(".flow-wrap")?.textContent ?? "";
			expect(text).toContain("Yard run");
			expect(text).toContain("Running");
			// A tool node renders its kind icon (⚙) and the tool label.
			expect(text).toContain("read");
			expect(text).toContain("Complete");
		},
		TIMEOUT,
	);

	it(
		"shows the failed phase chip and a failure count when a node failed",
		async () => {
			const snapshot = tree({
				phase: "failed",
				nodes: [
					node({ id: "run0", node: { kind: "run", depth: 0 }, phase: "failed", startSeq: 0 }),
					node({
						id: "tool0",
						parentId: "run0",
						executionParentId: "run0",
						node: { kind: "tool", name: "read" },
						phase: "failed",
						startSeq: 1,
					}),
				],
			});
			const { target } = await mountPanel(snapshot);
			const panel = target.querySelector(".yard-execution-panel");
			expect(panel?.classList.contains("failed")).toBe(true);
			expect(target.querySelector(".phase-chip")?.getAttribute("aria-label")).toBe(
				"Execution status: Failed",
			);
			// Heading for a non-started phase is "Yard failed".
			expect(target.querySelector(".eyebrow")?.textContent).toBe("Yard failed");
			const failure = target.querySelector(".failure-count");
			expect(failure).not.toBeNull();
			expect(failure?.textContent).toContain("failed");
		},
		TIMEOUT,
	);

	it(
		"opens an inspector with a code block when a node with detail is selected",
		async () => {
			const snapshot = tree({
				nodes: [
					node({ id: "run0", node: { kind: "run", depth: 0 }, phase: "completed", startSeq: 0 }),
					node({
						id: "tool0",
						parentId: "run0",
						executionParentId: "run0",
						node: { kind: "tool", name: "read" },
						phase: "completed",
						startSeq: 1,
						detail: { args: '{"path":"README.md"}' },
					}),
				],
			});
			const { target } = await mountPanel(snapshot);
			// No inspector until a node is clicked.
			expect(target.querySelector(".yard-inspector")).toBeNull();
			const toolButton = [...target.querySelectorAll(".yard-flow-node")].find((el) =>
				el.textContent?.includes("read"),
			) as HTMLElement | undefined;
			expect(toolButton).toBeDefined();
			toolButton?.dispatchEvent(
				new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await dom.settle(6);
			const inspector = target.querySelector(".yard-inspector");
			expect(inspector).not.toBeNull();
			// Inspector shows the node's "kind · phase" line and the detail field heading.
			expect(inspector?.textContent).toContain("tool");
			expect(inspector?.textContent).toContain("args");
			// The detail value is rendered through a YardCodeBlock.
			expect(inspector?.querySelector(".yard-code-block")).not.toBeNull();
			expect(inspector?.textContent).toContain("README.md");
		},
		TIMEOUT,
	);

	it(
		"closes the inspector via its close button and the panel click handler",
		async () => {
			const snapshot = tree({
				nodes: [
					node({ id: "run0", node: { kind: "run", depth: 0 }, phase: "completed", startSeq: 0 }),
					node({
						id: "tool0",
						parentId: "run0",
						executionParentId: "run0",
						node: { kind: "tool", name: "write" },
						phase: "completed",
						startSeq: 1,
						summary: "wrote output",
					}),
				],
			});
			const { target } = await mountPanel(snapshot);
			const toolButton = [...target.querySelectorAll(".yard-flow-node")].find((el) =>
				el.textContent?.includes("write"),
			) as HTMLElement | undefined;
			toolButton?.dispatchEvent(
				new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
			);
			await dom.settle(6);
			expect(target.querySelector(".yard-inspector")).not.toBeNull();
			// A node with only a summary (no detail) renders the summary text.
			expect(target.querySelector(".yard-inspector")?.textContent).toContain("wrote output");
			const close = target.querySelector(".yard-inspector button") as HTMLElement;
			close.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
			await dom.settle(6);
			expect(target.querySelector(".yard-inspector")).toBeNull();
		},
		TIMEOUT,
	);

	it(
		"toggles selection off when the same node is clicked twice",
		async () => {
			const { target } = await mountPanel(tree());
			const toolButton = [...target.querySelectorAll(".yard-flow-node")].find((el) =>
				el.textContent?.includes("read"),
			) as HTMLElement | undefined;
			const click = () =>
				toolButton?.dispatchEvent(
					new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
				);
			click();
			await dom.settle(6);
			expect(target.querySelector(".yard-inspector")).not.toBeNull();
			click();
			await dom.settle(6);
			expect(target.querySelector(".yard-inspector")).toBeNull();
		},
		TIMEOUT,
	);

	it(
		"renders a collapsible result footer with a code block when a result preview is present",
		async () => {
			const snapshot = tree({
				phase: "completed",
				resultPreview: JSON.stringify({ answer: 42, ok: true }),
			});
			const { target } = await mountPanel(snapshot);
			const footer = target.querySelector("footer");
			expect(footer).not.toBeNull();
			expect(footer?.querySelector("summary")?.textContent).toContain("Result");
			// JSON result preview is formatted and shown through a YardCodeBlock.
			const code = footer?.querySelector(".yard-code-block");
			expect(code).not.toBeNull();
			expect(code?.textContent).toContain("42");
			expect(code?.textContent).toContain("answer");
		},
		TIMEOUT,
	);

	it(
		"omits the result footer when there is no result or summary",
		async () => {
			const { target } = await mountPanel(tree());
			expect(target.querySelector("footer")).toBeNull();
		},
		TIMEOUT,
	);

	it(
		"renders group container nodes for all/sequence constructs",
		async () => {
			const snapshot = tree({
				nodes: [
					node({ id: "run0", node: { kind: "run", depth: 0 }, phase: "started", startSeq: 0 }),
					node({
						id: "grp0",
						parentId: "run0",
						executionParentId: "run0",
						node: { kind: "tool", name: "all" },
						construct: "all",
						phase: "started",
						startSeq: 1,
					}),
					node({
						id: "inf0",
						parentId: "grp0",
						node: { kind: "inference", model: "opus" },
						phase: "started",
						startSeq: 2,
					}),
				],
			});
			const { target } = await mountPanel(snapshot);
			// Group constructs render YardFlowNode's group branch (.yard-flow-group).
			expect(target.querySelector(".yard-flow-group")).not.toBeNull();
			const flowText = target.querySelector(".flow-wrap")?.textContent ?? "";
			// The all-construct group is labelled "All"; its inference child shows the model.
			expect(flowText).toContain("All");
			expect(flowText).toContain("opus");
		},
		TIMEOUT,
	);

	it(
		"shows the minimap once the graph exceeds eight nodes",
		async () => {
			const many: YardNodeState[] = [
				node({ id: "run0", node: { kind: "run", depth: 0 }, phase: "started", startSeq: 0 }),
			];
			for (let i = 1; i <= 9; i++) {
				many.push(
					node({
						id: `tool${i}`,
						parentId: "run0",
						executionParentId: "run0",
						node: { kind: "tool", name: `op${i}` },
						phase: "completed",
						startSeq: i,
					}),
				);
			}
			const { target } = await mountPanel(tree({ nodes: many }));
			// showMiniMap is flow.nodes.length > 8; with 10 nodes the minimap renders.
			expect(target.querySelector(".svelte-flow__minimap")).not.toBeNull();
		},
		TIMEOUT,
	);

	it(
		"announces progress to the live region after the debounce",
		async () => {
			const { target } = await mountPanel(tree());
			const live = target.querySelector(".sr-only") as HTMLElement;
			expect(live.getAttribute("aria-live")).toBe("polite");
			// The announced status is written on a 200ms setTimeout; settle past it.
			await new Promise((resolve) => setTimeout(resolve, 260));
			await dom.settle(4);
			expect(live.textContent).toContain("nodes settled");
			expect(live.textContent).toContain("1 running");
		},
		TIMEOUT,
	);
});
