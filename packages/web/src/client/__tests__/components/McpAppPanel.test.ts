import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { client } from "../../lib/bound";
import * as bridge from "../../lib/mcp-app-bridge";
import { installDom } from "../harness/dom";

// McpAppPanel's onMount wires an iframe to the MCP app bridge via statically
// imported helpers. We mock that module (and the shared BoundClient) so the
// component's own logic — status transitions, fullscreen gating, the
// message/context-update callbacks, teardown — is exercised without a real
// MCP transport or iframe content.

type Callbacks = {
	onMessage?: (m: { content: unknown }) => void;
	onContextUpdate?: (c: { content?: unknown; structuredContent?: unknown } | null) => void;
	onDisplayModeChange?: (mode: "inline" | "fullscreen") => void;
};

// Mutable test state the mocked bridge reads/writes.
const bridgeState = {
	getUiResourceImpl: async (_c: unknown, _uri: string): Promise<{ prefersBorder?: boolean }> => ({
		prefersBorder: undefined,
	}),
	mountAppImpl: async (): Promise<void> => {},
	supportsFullscreen: true,
	lastCallbacks: null as Callbacks | null,
	closed: false,
	viewportBudgetCalls: 0,
};

const sentMessages: Array<{ threadId: string; text: string }> = [];
const stagedContexts: Array<{ threadId: string; text: string }> = [];

// spyOn the module namespace instead of mock.module: mock.module replaces
// the module for the whole test process and broke mcp-app-bridge.test.ts.
const fakeBridge = {
	appSupportsFullscreen: () => bridgeState.supportsFullscreen,
	applyViewportBudget: () => {
		bridgeState.viewportBudgetCalls++;
	},
	formatAppContentToMessage: (payload: { content?: unknown; structuredContent?: unknown }) => {
		if (typeof payload.content === "string") return payload.content;
		if (Array.isArray(payload.content)) {
			return payload.content
				.map((c: { text?: string }) => c.text ?? "")
				.join("")
				.trim();
		}
		if (payload.structuredContent) return JSON.stringify(payload.structuredContent);
		return "";
	},
	getUiResource: (c: unknown, uri: string) => bridgeState.getUiResourceImpl(c, uri),
	mountApp: () => bridgeState.mountAppImpl(),
	newAppBridge: (_client: unknown, _iframe: unknown, callbacks: Callbacks) => {
		bridgeState.lastCallbacks = callbacks;
		return {
			getAppCapabilities: () => ({}),
			close: () => {
				bridgeState.closed = true;
			},
		};
	},
};
const bridgeSpies = Object.entries(fakeBridge).map(([name, impl]) =>
	spyOn(bridge, name as keyof typeof bridge).mockImplementation(impl as never),
);
afterAll(() => {
	for (const s of bridgeSpies) s.mockRestore();
});

// NOTE: we do NOT mock.module("../../lib/bound") — that replaces the shared
// BoundClient process-globally and breaks sibling test files that use the real
// client (e.g. SkillsView). Instead we spy on the two methods the panel calls
// and restore them in afterEach.
const realSendMessage = client.sendMessage.bind(client);
const realStageContext = client.stageContext.bind(client);

const dom = installDom();
afterAll(() => dom.teardown());

function makeInstance(overrides: Record<string, unknown> = {}) {
	return {
		callId: "call-1",
		threadId: "thread-1",
		boundName: "server__tool",
		serverName: "server",
		uiResourceUri: "ui://server/app",
		input: { foo: "bar" },
		client: {},
		resultPromise: Promise.resolve({ content: [] }),
		createdAt: Date.now(),
		...overrides,
	};
}

async function mountPanel(instance: Record<string, unknown>) {
	const McpAppPanel = (await import("../../components/McpAppPanel.svelte")).default;
	return dom.mount(McpAppPanel, { instance });
}

beforeEach(() => {
	bridgeState.getUiResourceImpl = async () => ({ prefersBorder: undefined });
	bridgeState.mountAppImpl = async () => {};
	bridgeState.supportsFullscreen = true;
	bridgeState.lastCallbacks = null;
	bridgeState.closed = false;
	bridgeState.viewportBudgetCalls = 0;
	sentMessages.length = 0;
	stagedContexts.length = 0;
	// Capture the panel's two client calls without replacing the module.
	(client as unknown as Record<string, unknown>).sendMessage = (threadId: string, text: string) => {
		sentMessages.push({ threadId, text: typeof text === "string" ? text : JSON.stringify(text) });
	};
	(client as unknown as Record<string, unknown>).stageContext = (
		threadId: string,
		text: string,
	) => {
		stagedContexts.push({ threadId, text: typeof text === "string" ? text : JSON.stringify(text) });
	};
});

afterEach(() => {
	// Clear fullscreen state and restore the real client methods.
	Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
	(client as unknown as Record<string, unknown>).sendMessage = realSendMessage;
	(client as unknown as Record<string, unknown>).stageContext = realStageContext;
});

describe("McpAppPanel", () => {
	it("renders the server kicker and reaches ready after a successful mount", async () => {
		const { target, unmount } = await mountPanel(makeInstance());
		await dom.settle();
		expect(target.textContent).toContain("App · server");
		// After a successful mount the loading/error states are gone.
		expect(target.textContent).not.toContain("Loading…");
		expect(target.textContent).not.toContain("Failed");
		expect(target.querySelector(".app-error")).toBeNull();
		// Fullscreen is supported → the control is offered.
		expect(target.querySelector(".head-btn")?.textContent?.trim()).toBe("Fullscreen");
		unmount();
	});

	it("shows an error panel when reading the UI resource fails", async () => {
		bridgeState.getUiResourceImpl = async () => {
			throw new Error("resource gone");
		};
		const { target, unmount } = await mountPanel(makeInstance());
		await dom.settle();
		expect(target.textContent).toContain("Failed");
		expect(target.querySelector(".app-error")).not.toBeNull();
		expect(target.textContent).toContain("Could not render this app.");
		expect(target.querySelector("code")?.textContent).toContain("resource gone");
		// The iframe is hidden in the error state.
		expect(target.querySelector(".app-frame")?.classList.contains("hidden")).toBe(true);
		unmount();
	});

	it("hides the fullscreen button when the app does not support fullscreen", async () => {
		bridgeState.supportsFullscreen = false;
		const { target, unmount } = await mountPanel(makeInstance());
		await dom.settle();
		expect(target.querySelector(".head-btn")).toBeNull();
		unmount();
	});

	it("goes chromeless when the resource prefers no border", async () => {
		bridgeState.getUiResourceImpl = async () => ({ prefersBorder: false });
		const { target, unmount } = await mountPanel(makeInstance());
		await dom.settle();
		expect(target.querySelector(".mcp-app")?.classList.contains("chromeless")).toBe(true);
		unmount();
	});

	it("sends an app message to the thread via onMessage", async () => {
		const { unmount } = await mountPanel(makeInstance());
		await dom.settle();
		bridgeState.lastCallbacks?.onMessage?.({ content: "hello from app" });
		expect(sentMessages).toEqual([{ threadId: "thread-1", text: "[server app] hello from app" }]);
		unmount();
	});

	it("stages a context update to the thread via onContextUpdate, and ignores empty", async () => {
		const { unmount } = await mountPanel(makeInstance());
		await dom.settle();
		bridgeState.lastCallbacks?.onContextUpdate?.({ content: "ctx" });
		expect(stagedContexts).toEqual([{ threadId: "thread-1", text: "[server app] ctx" }]);
		// null context is a no-op.
		bridgeState.lastCallbacks?.onContextUpdate?.(null);
		expect(stagedContexts).toHaveLength(1);
		unmount();
	});

	it("closes the bridge on teardown", async () => {
		const { unmount } = await mountPanel(makeInstance());
		await dom.settle();
		expect(bridgeState.closed).toBe(false);
		unmount();
		await dom.settle();
		expect(bridgeState.closed).toBe(true);
	});

	it("toggles native fullscreen from the header button", async () => {
		let requested = false;
		let exited = false;
		Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
		// panelEl is a <div>, so stub requestFullscreen on Element.prototype.
		const elementProto = (
			dom.window as unknown as { Element: { prototype: Record<string, unknown> } }
		).Element.prototype;
		elementProto.requestFullscreen = function requestFullscreen(this: Element) {
			requested = true;
			Object.defineProperty(document, "fullscreenElement", {
				configurable: true,
				value: this,
			});
			return Promise.resolve();
		};
		(document as unknown as Record<string, unknown>).exitFullscreen = () => {
			exited = true;
			Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
			return Promise.resolve();
		};

		const { target, unmount } = await mountPanel(makeInstance());
		await dom.settle();
		const btn = target.querySelector(".head-btn") as HTMLButtonElement;
		await dom.fire(btn, "click");
		expect(requested).toBe(true);
		// fullscreenchange drives the label; dispatch it.
		document.dispatchEvent(
			new (dom.window as unknown as { Event: typeof Event }).Event("fullscreenchange"),
		);
		await dom.settle();
		expect(btn.textContent?.trim()).toBe("Exit fullscreen");

		await dom.fire(btn, "click");
		expect(exited).toBe(true);
		unmount();
	});
});
