import { beforeEach, describe, expect, it, mock } from "bun:test";
import { JSDOM } from "jsdom";

// mermaid.ts turns `<pre class="mermaid">` carriers into rendered SVG via a
// dynamically-imported mermaid module. We stub that module so the action's
// behavior — one-time render, idempotent data-processed marking, error
// fallback, and empty-source skip — is exercised without the real (large)
// mermaid bundle or a browser.

type RenderResult = { svg: string };
const renderState: {
	render: (id: string, source: string) => Promise<RenderResult>;
	initializeCalls: unknown[];
	renderCalls: { id: string; source: string }[];
	initializeThrows: boolean;
} = {
	render: async (id) => ({ svg: `<svg data-id="${id}">ok</svg>` }),
	initializeCalls: [],
	renderCalls: [],
	initializeThrows: false,
};

mock.module("mermaid", () => ({
	default: {
		initialize(config: unknown) {
			if (renderState.initializeThrows) throw new Error("init boom");
			renderState.initializeCalls.push(config);
		},
		async render(id: string, source: string) {
			renderState.renderCalls.push({ id, source });
			return renderState.render(id, source);
		},
	},
}));

// A single local JSDOM document, never installed on globalThis — mutating the
// global window/document here would leak into later Svelte component tests in
// the full suite (they expect the svelte-test-plugin's own baseline). The
// mermaid action only touches the node it is handed, so a document built from a
// local JSDOM is enough.
const localDoc = new JSDOM("<!doctype html><html><body></body></html>").window.document;

/** Build a container holding mermaid carriers with the given source strings. */
function container(...sources: string[]): HTMLElement {
	const node = localDoc.createElement("div");
	for (const src of sources) {
		const pre = localDoc.createElement("pre");
		pre.className = "mermaid";
		pre.textContent = src;
		node.appendChild(pre);
	}
	return node as unknown as HTMLElement;
}

describe("mermaid action", () => {
	beforeEach(() => {
		renderState.render = async (id) => ({ svg: `<svg data-id="${id}">ok</svg>` });
		renderState.initializeCalls = [];
		renderState.renderCalls = [];
		renderState.initializeThrows = false;
	});

	it("renders a carrier to SVG and marks it processed and rendered", async () => {
		const { mermaid } = await import("../mermaid");
		const node = container("graph TD; A-->B");
		mermaid(node, "<html>");
		// Let the async renderDiagrams microtask chain settle.
		await new Promise((r) => setTimeout(r, 0));

		const block = node.querySelector("pre.mermaid") as HTMLElement;
		expect(block.getAttribute("data-processed")).toBe("true");
		expect(block.classList.contains("mermaid-rendered")).toBe(true);
		expect(block.innerHTML).toContain("<svg");
		expect(renderState.renderCalls).toHaveLength(1);
		expect(renderState.renderCalls[0].source).toBe("graph TD; A-->B");
	});

	it("does not re-render an already-processed block on update", async () => {
		const { mermaid } = await import("../mermaid");
		const node = container("graph TD; A-->B");
		const action = mermaid(node, "<html>");
		await new Promise((r) => setTimeout(r, 0));
		expect(renderState.renderCalls).toHaveLength(1);

		// A second update with the same (now-processed) carrier renders nothing new.
		action.update();
		await new Promise((r) => setTimeout(r, 0));
		expect(renderState.renderCalls).toHaveLength(1);
	});

	it("skips carriers whose source is blank but still marks them processed", async () => {
		const { mermaid } = await import("../mermaid");
		const node = container("   ");
		mermaid(node, "<html>");
		await new Promise((r) => setTimeout(r, 0));

		const block = node.querySelector("pre.mermaid") as HTMLElement;
		expect(block.getAttribute("data-processed")).toBe("true");
		expect(renderState.renderCalls).toHaveLength(0);
	});

	it("falls back to an error class and title when render throws", async () => {
		renderState.render = async () => {
			throw new Error("bad diagram syntax");
		};
		const { mermaid } = await import("../mermaid");
		const node = container("not a diagram");
		mermaid(node, "<html>");
		await new Promise((r) => setTimeout(r, 0));

		const block = node.querySelector("pre.mermaid") as HTMLElement;
		expect(block.classList.contains("mermaid-error")).toBe(true);
		expect(block.getAttribute("title")).toBe("bad diagram syntax");
		// Raw source stays visible — innerHTML was not replaced.
		expect(block.textContent).toBe("not a diagram");
	});

	it("is a no-op when there are no unprocessed carriers", async () => {
		const { mermaid } = await import("../mermaid");
		const node = localDoc.createElement("div") as unknown as HTMLElement;
		mermaid(node, "<html>");
		await new Promise((r) => setTimeout(r, 0));
		expect(renderState.renderCalls).toHaveLength(0);
	});
});
