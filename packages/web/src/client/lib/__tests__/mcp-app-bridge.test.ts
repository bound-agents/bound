import { afterAll, describe, expect, it } from "bun:test";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { FakeResizeObserver, installDom } from "../../__tests__/harness/dom";
import {
	type AppBridgeCallbacks,
	type AppBridgeOptions,
	type UiResourceClient,
	appSupportsFullscreen,
	applyViewportBudget,
	buildDeviceContext,
	buildHostStyles,
	formatAppContentToMessage,
	getUiResource,
	mountApp,
	newAppBridge,
} from "../mcp-app-bridge";

const MIME = "text/html;profile=mcp-app";

function fakeClient(contents: unknown[]): UiResourceClient {
	return {
		readResource: async () =>
			({ contents }) as Awaited<ReturnType<UiResourceClient["readResource"]>>,
	};
}

describe("getUiResource", () => {
	it("returns html + csp + permissions from content-level _meta.ui", async () => {
		const client = fakeClient([
			{
				mimeType: MIME,
				text: "<html><body>app</body></html>",
				_meta: {
					ui: {
						csp: { connectDomains: ["https://api.example.com"] },
						permissions: { camera: {} },
					},
				},
			},
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.html).toBe("<html><body>app</body></html>");
		expect(data.csp).toEqual({ connectDomains: ["https://api.example.com"] });
		expect(data.permissions).toEqual({ camera: {} });
	});

	it("returns prefersBorder from content-level _meta.ui", async () => {
		const client = fakeClient([
			{
				mimeType: MIME,
				text: "<html><body>app</body></html>",
				_meta: { ui: { prefersBorder: false } },
			},
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.prefersBorder).toBe(false);
	});

	it("returns prefersBorder true when the view requests a frame", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>x</p>", _meta: { ui: { prefersBorder: true } } },
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.prefersBorder).toBe(true);
	});

	it("leaves prefersBorder undefined when the view omits it (host decides)", async () => {
		const client = fakeClient([{ mimeType: MIME, text: "<p>x</p>", _meta: { ui: {} } }]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.prefersBorder).toBeUndefined();
	});

	it("decodes base64 blob content", async () => {
		const html = "<html><body>blobbed</body></html>";
		const client = fakeClient([{ mimeType: MIME, blob: btoa(html) }]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.html).toBe(html);
	});

	it("accepts the Python-SDK `meta` spelling as a fallback", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>x</p>", meta: { ui: { csp: { connectDomains: [] } } } },
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.csp).toEqual({ connectDomains: [] });
	});

	it("prefers content-level meta over the listing-level fallback", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>x</p>", _meta: { ui: { permissions: { microphone: {} } } } },
		]);
		const data = await getUiResource(client, "ui://x/app.html", {
			permissions: { camera: {} },
		});
		expect(data.permissions).toEqual({ microphone: {} });
	});

	it("falls back to listing-level meta when content has none", async () => {
		const client = fakeClient([{ mimeType: MIME, text: "<p>x</p>" }]);
		const data = await getUiResource(client, "ui://x/app.html", {
			csp: { connectDomains: ["https://fallback.example.com"] },
		});
		expect(data.csp).toEqual({ connectDomains: ["https://fallback.example.com"] });
	});

	it("throws on the wrong MIME type", async () => {
		const client = fakeClient([{ mimeType: "text/html", text: "<p>x</p>" }]);
		await expect(getUiResource(client, "ui://x/app.html")).rejects.toThrow(/Unsupported MIME/);
	});

	it("throws when the resource has more than one content", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>a</p>" },
			{ mimeType: MIME, text: "<p>b</p>" },
		]);
		await expect(getUiResource(client, "ui://x/app.html")).rejects.toThrow(/exactly one/);
	});
});

describe("appSupportsFullscreen", () => {
	it("is true when the app declares fullscreen among its display modes", () => {
		expect(appSupportsFullscreen({ availableDisplayModes: ["inline", "fullscreen"] })).toBe(true);
	});

	it("is false when the app declares only inline (the SDK default get_me uses)", () => {
		expect(appSupportsFullscreen({ availableDisplayModes: ["inline"] })).toBe(false);
	});

	it("is false when the app omits availableDisplayModes entirely", () => {
		expect(appSupportsFullscreen({})).toBe(false);
	});

	it("is false before capabilities have landed (undefined)", () => {
		expect(appSupportsFullscreen(undefined)).toBe(false);
	});
});

describe("buildHostStyles", () => {
	it("maps bound palette vars into ext-apps host-style keys", () => {
		const palette: Record<string, string> = {
			"--paper": "#EFEAE0",
			"--paper-2": "#E8E2D5",
			"--ink": "#1A1814",
			"--rule-soft": "rgba(26,24,20,0.18)",
			"--font-mono": "JetBrains Mono, monospace",
		};
		const styles = buildHostStyles((v) => palette[v] ?? "");
		expect(styles.variables?.["--color-background-primary"]).toBe("#EFEAE0");
		expect(styles.variables?.["--color-background-secondary"]).toBe("#E8E2D5");
		expect(styles.variables?.["--color-text-primary"]).toBe("#1A1814");
		expect(styles.variables?.["--color-border-primary"]).toBe("rgba(26,24,20,0.18)");
		expect(styles.variables?.["--font-mono"]).toBe("JetBrains Mono, monospace");
	});

	it("trims values and omits keys whose bound var resolves blank", () => {
		const styles = buildHostStyles((v) => (v === "--paper" ? "  #EFEAE0  " : "   "));
		expect(styles.variables?.["--color-background-primary"]).toBe("#EFEAE0");
		expect("--color-text-primary" in (styles.variables ?? {})).toBe(false);
	});
});

describe("buildDeviceContext", () => {
	it("reports mobile for a touch-only (coarse pointer, no hover) device", () => {
		const ctx = buildDeviceContext({ coarsePointer: true, hover: false });
		expect(ctx.platform).toBe("mobile");
		expect(ctx.deviceCapabilities).toEqual({ touch: true, hover: false });
	});

	it("reports web for a hover-capable pointer device", () => {
		const ctx = buildDeviceContext({ coarsePointer: false, hover: true });
		expect(ctx.platform).toBe("web");
		expect(ctx.deviceCapabilities).toEqual({ touch: false, hover: true });
	});

	it("keeps web for a hybrid coarse+hover device (touch laptop)", () => {
		const ctx = buildDeviceContext({ coarsePointer: true, hover: true });
		expect(ctx.platform).toBe("web");
		expect(ctx.deviceCapabilities).toEqual({ touch: true, hover: true });
	});
});

describe("formatAppContentToMessage", () => {
	it("joins text content blocks with blank lines", () => {
		const text = formatAppContentToMessage({
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
		});
		expect(text).toBe("first\n\nsecond");
	});

	it("renders structuredContent as a fenced json block", () => {
		const text = formatAppContentToMessage({ structuredContent: { selected: 3, label: "x" } });
		expect(text).toBe('```json\n{\n  "selected": 3,\n  "label": "x"\n}\n```');
	});

	it("combines text content and structuredContent", () => {
		const text = formatAppContentToMessage({
			content: [{ type: "text", text: "the user picked:" }],
			structuredContent: { id: 7 },
		});
		expect(text).toBe('the user picked:\n\n```json\n{\n  "id": 7\n}\n```');
	});

	it("labels non-text content blocks by type rather than dropping them", () => {
		const text = formatAppContentToMessage({
			content: [
				{ type: "text", text: "see image" },
				{ type: "image", data: "…", mimeType: "image/png" },
			],
		});
		expect(text).toBe("see image\n\n[image content]");
	});

	it("returns an empty string when there is nothing to send", () => {
		expect(formatAppContentToMessage({})).toBe("");
		expect(formatAppContentToMessage({ content: [], structuredContent: {} })).toBe("");
	});
});

// ---------------------------------------------------------------------------
// DOM-wired tests: applyViewportBudget, newAppBridge (handlers + ResizeObserver
// + onclose), and mountApp (handshake + tool-input/result/cancel forwarding).
// One shared jsdom window per the harness contract (svelte caches the first
// window process-wide); torn down in afterAll so later test files are clean.
// ---------------------------------------------------------------------------
const dom = installDom();
afterAll(() => dom.teardown());

/**
 * A fake MCP `Client` carrying just the surface `newAppBridge` + the real
 * AppBridge's `connect()` read: `getServerCapabilities()` (gates handler
 * wiring) and `request`/`setNotificationHandler` (used when caps declare
 * tools/resources). No real transport.
 */
function fakeBridgeClient(
	caps: { tools?: unknown; resources?: unknown; prompts?: unknown } | undefined = {
		tools: {},
		resources: {},
	},
): import("@modelcontextprotocol/client").Client {
	return {
		getServerCapabilities: () => caps,
		request: async () => ({}),
		setNotificationHandler: () => {},
	} as unknown as import("@modelcontextprotocol/client").Client;
}

/** A detached iframe appended under <body> so it has a live contentWindow. */
function makeIframe(): HTMLIFrameElement {
	const iframe = dom.document.createElement("iframe");
	dom.document.body.appendChild(iframe);
	return iframe;
}

/**
 * Build a bridge and capture every outbound notification it sends, so a test
 * can assert on the wire-level `ui/notifications/*` the host pushed without a
 * real transport. Spying on the instance method (not the module) keeps the
 * patch local to this bridge — nothing leaks to later files.
 */
function bridgeWithSentNotifications(
	client: import("@modelcontextprotocol/client").Client,
	iframe: HTMLIFrameElement,
	callbacks?: AppBridgeCallbacks,
	options?: AppBridgeOptions,
): { bridge: AppBridge; sent: Array<{ method: string; params: unknown }> } {
	const bridge = newAppBridge(client, iframe, callbacks, options);
	const sent: Array<{ method: string; params: unknown }> = [];
	const orig = (bridge as unknown as { notification: (n: unknown) => unknown }).notification.bind(
		bridge,
	);
	(
		bridge as unknown as { notification: (n: { method: string; params: unknown }) => unknown }
	).notification = (n) => {
		sent.push(n);
		return orig(n);
	};
	return { bridge, sent };
}

/**
 * Connect the bridge to a live transport so handlers that send notifications
 * (`sendHostContextChange`) don't throw "Not connected". The transport targets
 * the iframe's own contentWindow exactly as `mountApp` does; no app is loaded,
 * so nothing arrives back. Awaits so `connect()`'s capability wiring completes.
 */
async function connectBridge(bridge: AppBridge, iframe: HTMLIFrameElement): Promise<void> {
	const cw = iframe.contentWindow;
	if (!cw) throw new Error("iframe must be attached to the DOM before connecting");
	await bridge.connect(new PostMessageTransport(cw, cw));
}

describe("applyViewportBudget", () => {
	it("sends the current budget as inline display mode when not fullscreen", () => {
		const sent: Array<{ displayMode: string; containerDimensions: unknown }> = [];
		const appBridge = {
			sendHostContextChange: (c: { displayMode: string; containerDimensions: unknown }) =>
				sent.push(c),
		} as unknown as AppBridge;
		applyViewportBudget(appBridge, { maxHeight: 512, fullscreen: false });
		expect(sent).toEqual([{ displayMode: "inline", containerDimensions: { maxHeight: 512 } }]);
	});

	it("sends fullscreen display mode when the state is fullscreen", () => {
		const sent: Array<{ displayMode: string; containerDimensions: unknown }> = [];
		const appBridge = {
			sendHostContextChange: (c: { displayMode: string; containerDimensions: unknown }) =>
				sent.push(c),
		} as unknown as AppBridge;
		applyViewportBudget(appBridge, { maxHeight: 900, fullscreen: true });
		expect(sent).toEqual([{ displayMode: "fullscreen", containerDimensions: { maxHeight: 900 } }]);
	});
});

describe("newAppBridge", () => {
	it("returns a live AppBridge and seeds host context from DOM (styles + device)", () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe);
		expect(bridge).toBeInstanceOf(AppBridge);
		// readDeviceContextFromDom ran: harness matchMedia returns matches:false,
		// so coarsePointer:false, hover:false → platform "web".
		const ctx = (bridge as unknown as { _hostContext: Record<string, unknown> })._hostContext;
		expect(ctx.platform).toBe("web");
		expect(ctx.displayMode).toBe("inline");
		expect(ctx.availableDisplayModes).toEqual(["inline", "fullscreen"]);
		bridge.onclose?.();
	});

	it("honors an explicit theme and a fullscreen displayMode in host context", () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe, undefined, {
			theme: "dark",
			displayMode: "fullscreen",
		});
		const ctx = (bridge as unknown as { _hostContext: Record<string, unknown> })._hostContext;
		expect(ctx.theme).toBe("dark");
		expect(ctx.displayMode).toBe("fullscreen");
		bridge.onclose?.();
	});

	it("observes the iframe with a ResizeObserver and disconnects it on close", () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe);
		// The harness's FakeResizeObserver records instances + observed targets.
		const observers = FakeResizeObserver.instances;
		const mine = observers[observers.length - 1] as unknown as {
			observed: unknown[];
			disconnected: boolean;
			callback: (entries: Array<{ contentRect: { width: number } }>) => void;
		};
		expect(mine.observed).toContain(iframe);
		expect(mine.disconnected).toBe(false);
		bridge.onclose?.();
		expect(mine.disconnected).toBe(true);
	});

	it("pushes container width to the app when the ResizeObserver reports > 0", async () => {
		const iframe = makeIframe();
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe, undefined, {
			containerState: { maxHeight: 300, fullscreen: false },
		});
		await connectBridge(bridge, iframe);
		const mine = FakeResizeObserver.instances.at(-1) as unknown as {
			callback: (entries: Array<{ contentRect: { width: number } }>) => void;
		};
		mine.callback([{ contentRect: { width: 642.7 } }]);
		const change = sent.find((n) => n.method === "ui/notifications/host-context-changed");
		expect(change?.params).toEqual({ containerDimensions: { width: 643, maxHeight: 300 } });
		bridge.onclose?.();
	});

	it("ignores a zero-width ResizeObserver report (no context change sent)", () => {
		const iframe = makeIframe();
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe);
		const mine = FakeResizeObserver.instances.at(-1) as unknown as {
			callback: (entries: Array<{ contentRect: { width: number } }>) => void;
		};
		mine.callback([{ contentRect: { width: 0 } }]);
		expect(sent.some((n) => n.method === "ui/notifications/host-context-changed")).toBe(false);
		bridge.onclose?.();
	});

	it("preserves a pre-existing onclose when wrapping it", () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe);
		let prevCalled = false;
		const prev = bridge.onclose;
		// Re-wrap exactly as newAppBridge does to assert chaining semantics: the
		// bridge's own onclose disconnects the observer AND calls the prior.
		expect(typeof prev).toBe("function");
		bridge.onclose = () => {
			prevCalled = true;
			prev?.();
		};
		bridge.onclose?.();
		expect(prevCalled).toBe(true);
	});

	it("onmessage forwards to the callback and acks with {}", async () => {
		const iframe = makeIframe();
		const seen: unknown[] = [];
		const bridge = newAppBridge(fakeBridgeClient(), iframe, { onMessage: (m) => seen.push(m) });
		const ack = await (bridge.onmessage as (p: unknown) => Promise<unknown>)({
			content: [{ type: "text", text: "hi" }],
		});
		expect(ack).toEqual({});
		expect(seen).toEqual([{ content: [{ type: "text", text: "hi" }] }]);
		bridge.onclose?.();
	});

	it("onopenlink opens a new tab with noopener,noreferrer and acks", async () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe);
		const calls: Array<[string, string, string]> = [];
		// The handler calls the global `window.open`; patch it on the harness window.
		const savedOpen = dom.window.open;
		dom.window.open = ((url: string, target: string, features: string) => {
			calls.push([url, target, features]);
			return null;
		}) as typeof dom.window.open;
		try {
			const ack = await (bridge.onopenlink as (p: unknown) => Promise<unknown>)({
				url: "https://example.com/x",
			});
			expect(ack).toEqual({});
			expect(calls).toEqual([["https://example.com/x", "_blank", "noopener,noreferrer"]]);
		} finally {
			dom.window.open = savedOpen;
			bridge.onclose?.();
		}
	});

	it("onupdatemodelcontext forwards context when content is non-empty", async () => {
		const iframe = makeIframe();
		const updates: unknown[] = [];
		const bridge = newAppBridge(fakeBridgeClient(), iframe, {
			onContextUpdate: (c) => updates.push(c),
		});
		const params = { content: [{ type: "text", text: "ctx" }] };
		const ack = await (bridge.onupdatemodelcontext as (p: unknown) => Promise<unknown>)(params);
		expect(ack).toEqual({});
		expect(updates).toEqual([params]);
		bridge.onclose?.();
	});

	it("onupdatemodelcontext forwards context when only structuredContent is present", async () => {
		const iframe = makeIframe();
		const updates: unknown[] = [];
		const bridge = newAppBridge(fakeBridgeClient(), iframe, {
			onContextUpdate: (c) => updates.push(c),
		});
		const params = { structuredContent: { selected: 1 } };
		await (bridge.onupdatemodelcontext as (p: unknown) => Promise<unknown>)(params);
		expect(updates).toEqual([params]);
		bridge.onclose?.();
	});

	it("onupdatemodelcontext forwards null when both content and structuredContent are empty", async () => {
		const iframe = makeIframe();
		const updates: unknown[] = [];
		const bridge = newAppBridge(fakeBridgeClient(), iframe, {
			onContextUpdate: (c) => updates.push(c),
		});
		await (bridge.onupdatemodelcontext as (p: unknown) => Promise<unknown>)({
			content: [],
			structuredContent: {},
		});
		expect(updates).toEqual([null]);
		bridge.onclose?.();
	});

	it("onsizechange clamps the inline iframe height to the viewport budget", async () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe, undefined, {
			containerState: { maxHeight: 400, fullscreen: false },
		});
		await (bridge.onsizechange as (p: { height?: number }) => Promise<void>)({ height: 9999 });
		expect(iframe.style.height).toBe("400px");
		await (bridge.onsizechange as (p: { height?: number }) => Promise<void>)({ height: 120 });
		expect(iframe.style.height).toBe("120px");
		bridge.onclose?.();
	});

	it("onsizechange clears the inline height while fullscreen so CSS owns it", async () => {
		const iframe = makeIframe();
		iframe.style.height = "300px";
		const bridge = newAppBridge(fakeBridgeClient(), iframe, undefined, {
			containerState: { maxHeight: 400, fullscreen: true },
		});
		await (bridge.onsizechange as (p: { height?: number }) => Promise<void>)({ height: 500 });
		expect(iframe.style.height).toBe("");
		bridge.onclose?.();
	});

	it("onsizechange leaves the height untouched when no height is reported (inline)", async () => {
		const iframe = makeIframe();
		iframe.style.height = "222px";
		const bridge = newAppBridge(fakeBridgeClient(), iframe, undefined, {
			containerState: { maxHeight: 400, fullscreen: false },
		});
		await (bridge.onsizechange as (p: { height?: number }) => Promise<void>)({});
		expect(iframe.style.height).toBe("222px");
		bridge.onclose?.();
	});

	it("onrequestdisplaymode switches to fullscreen, echoes host context, and notifies the callback", async () => {
		const iframe = makeIframe();
		const modes: string[] = [];
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe, {
			onDisplayModeChange: (m) => modes.push(m),
		});
		await connectBridge(bridge, iframe);
		const res = await (bridge.onrequestdisplaymode as (p: { mode: string }) => Promise<unknown>)({
			mode: "fullscreen",
		});
		expect(res).toEqual({ mode: "fullscreen" });
		expect(modes).toEqual(["fullscreen"]);
		expect(
			sent.some(
				(n) =>
					n.method === "ui/notifications/host-context-changed" &&
					(n.params as { displayMode?: string }).displayMode === "fullscreen",
			),
		).toBe(true);
		bridge.onclose?.();
	});

	it("onrequestdisplaymode treats any non-fullscreen request as inline", async () => {
		const iframe = makeIframe();
		const modes: string[] = [];
		const bridge = newAppBridge(fakeBridgeClient(), iframe, {
			onDisplayModeChange: (m) => modes.push(m),
		});
		await connectBridge(bridge, iframe);
		const res = await (bridge.onrequestdisplaymode as (p: { mode: string }) => Promise<unknown>)({
			mode: "inline",
		});
		expect(res).toEqual({ mode: "inline" });
		expect(modes).toEqual(["inline"]);
		bridge.onclose?.();
	});
});

describe("mountApp", () => {
	/** Deliver the app's `ui/notifications/initialized` over the live transport. */
	function sendInitialized(bridge: AppBridge): void {
		(
			bridge as unknown as { transport?: { onmessage?: (m: unknown) => void } }
		).transport?.onmessage?.({
			jsonrpc: "2.0",
			method: "ui/notifications/initialized",
			params: {},
		});
	}

	it("runs the handshake: sandboxes the frame, navigates via srcdoc, sends tool input then result", async () => {
		const iframe = makeIframe();
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe);
		let resolveResult!: (r: unknown) => void;
		const resultPromise = new Promise<unknown>((r) => {
			resolveResult = r;
		});
		const mountP = mountApp(iframe, bridge, {
			resource: {
				html: "<p>mounted-app</p>",
				permissions: { camera: {} },
			},
			input: { query: "q" },
			resultPromise: resultPromise as Promise<
				import("@modelcontextprotocol/client").CallToolResult
			>,
		});
		await new Promise((r) => setTimeout(r, 0));
		// Sandbox + allow attributes applied before navigation.
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
		expect(iframe.getAttribute("allow")).toContain("camera");
		sendInitialized(bridge);
		await mountP;
		expect(iframe.srcdoc).toContain("mounted-app");
		expect(sent.some((n) => n.method === "ui/notifications/tool-input")).toBe(true);
		resolveResult({ content: [{ type: "text", text: "ok" }] });
		await new Promise((r) => setTimeout(r, 0));
		expect(sent.some((n) => n.method === "ui/notifications/tool-result")).toBe(true);
		bridge.onclose?.();
	});

	it("forwards a cancellation when the tool result rejects", async () => {
		const iframe = makeIframe();
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe);
		let rejectResult!: (e: unknown) => void;
		const resultPromise = new Promise<unknown>((_r, rej) => {
			rejectResult = rej;
		});
		const mountP = mountApp(iframe, bridge, {
			resource: { html: "<p>x</p>" },
			input: {},
			resultPromise: resultPromise as Promise<
				import("@modelcontextprotocol/client").CallToolResult
			>,
		});
		await new Promise((r) => setTimeout(r, 0));
		sendInitialized(bridge);
		await mountP;
		rejectResult(new Error("tool blew up"));
		await new Promise((r) => setTimeout(r, 0));
		const cancel = sent.find((n) => n.method === "ui/notifications/tool-cancelled");
		expect(cancel).toBeDefined();
		expect((cancel?.params as { reason?: string }).reason).toBe("tool blew up");
		bridge.onclose?.();
	});

	it("stringifies a non-Error rejection reason", async () => {
		const iframe = makeIframe();
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe);
		let rejectResult!: (e: unknown) => void;
		const resultPromise = new Promise<unknown>((_r, rej) => {
			rejectResult = rej;
		});
		const mountP = mountApp(iframe, bridge, {
			resource: { html: "<p>x</p>" },
			input: {},
			resultPromise: resultPromise as Promise<
				import("@modelcontextprotocol/client").CallToolResult
			>,
		});
		await new Promise((r) => setTimeout(r, 0));
		sendInitialized(bridge);
		await mountP;
		rejectResult("plain string failure");
		await new Promise((r) => setTimeout(r, 0));
		const cancel = sent.find((n) => n.method === "ui/notifications/tool-cancelled");
		expect((cancel?.params as { reason?: string }).reason).toBe("plain string failure");
		bridge.onclose?.();
	});

	it("is a no-op when the iframe is already mounted (srcdoc set)", async () => {
		const iframe = makeIframe();
		iframe.srcdoc = "<p>already here</p>";
		const { bridge, sent } = bridgeWithSentNotifications(fakeBridgeClient(), iframe);
		await mountApp(iframe, bridge, {
			resource: { html: "<p>new</p>" },
			input: {},
			resultPromise: Promise.resolve({ content: [] }) as Promise<
				import("@modelcontextprotocol/client").CallToolResult
			>,
		});
		expect(iframe.srcdoc).toBe("<p>already here</p>");
		expect(sent.length).toBe(0);
		expect(iframe.getAttribute("sandbox")).toBeNull();
		bridge.onclose?.();
	});

	it("throws when the iframe has no contentWindow (not attached to the DOM)", async () => {
		const detached = dom.document.createElement("iframe"); // not appended
		const bridge = newAppBridge(fakeBridgeClient(), detached);
		await expect(
			mountApp(detached, bridge, {
				resource: { html: "<p>x</p>" },
				input: {},
				resultPromise: Promise.resolve({ content: [] }) as Promise<
					import("@modelcontextprotocol/client").CallToolResult
				>,
			}),
		).rejects.toThrow(/no contentWindow/);
		bridge.onclose?.();
	});

	it("omits the allow attribute when the resource declares no permissions", async () => {
		const iframe = makeIframe();
		const bridge = newAppBridge(fakeBridgeClient(), iframe);
		const mountP = mountApp(iframe, bridge, {
			resource: { html: "<p>x</p>" },
			input: {},
			resultPromise: Promise.resolve({ content: [] }) as Promise<
				import("@modelcontextprotocol/client").CallToolResult
			>,
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(iframe.getAttribute("allow")).toBeNull();
		sendInitialized(bridge);
		await mountP;
		bridge.onclose?.();
	});
});
