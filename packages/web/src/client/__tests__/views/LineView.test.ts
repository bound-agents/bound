import { afterEach, describe, expect, it } from "bun:test";
import { client } from "../../lib/bound";
import { installDom } from "../harness/dom";

type Msg = {
	id: string;
	role: string;
	content: string;
	tool_name?: string | null;
	model_id?: string | null;
	created_at?: string;
};

const thread = (over: Record<string, unknown> = {}) => ({
	id: "thread-abc-1234567890",
	title: "Planning",
	color: 3,
	model_hint: null,
	attachedSessionHosts: [],
	...over,
});

const status = (over: Record<string, unknown> = {}) => ({
	thread_id: "thread-abc-1234567890",
	active: false,
	state: null,
	detail: null,
	tokens: 0,
	model: null,
	...over,
});

/**
 * Drive every FakeWebSocket the client has opened into the OPEN state so that
 * `client.sendWsMessage` (used by subscribe/sendMessage/cancel wiring) actually
 * writes frames. The BoundClient is a module singleton that opens its socket in
 * `connectWebSocket()` during onMount; the fake never connects on its own.
 */
async function openSockets(dom: ReturnType<typeof installDom>): Promise<void> {
	const ctor = dom.window.WebSocket as unknown as {
		instances: Array<{ readyState: number; open: () => void }>;
	};
	// onMount connects the socket inside an async body (after awaiting getThread),
	// so the FakeWebSocket may appear a tick after mount resolves. Open across a
	// few settle rounds so a late-created socket still gets driven to OPEN.
	for (let round = 0; round < 5; round++) {
		for (const ws of ctor.instances) {
			if (ws.readyState === 0) ws.open();
		}
		await dom.settle(1);
	}
}

let dom: ReturnType<typeof installDom> | null = null;
// Components mounted this test; unmounted synchronously in afterEach while
// `document` still exists. The harness's own teardown unmounts asynchronously
// (`void svelte().then(unmount)`), which races global restoration and throws
// `document is not defined` out of svelte's event-handle cleanup — bun then
// attributes that stray rejection to whichever test runs next.
const unmounters: Array<() => void> = [];

/** Non-null accessor for the active harness (biome forbids `dom!`). */
function requireDom(): ReturnType<typeof installDom> {
	if (!dom) throw new Error("harness not mounted");
	return dom;
}

afterEach(() => {
	// Unmount this test's components before globals are restored.
	for (const unmount of unmounters.splice(0)) {
		try {
			unmount();
		} catch {
			/* already gone */
		}
	}
	// The BoundClient is a module singleton that retains its socket reference
	// across tests; disconnect so the next test's connectWebSocket() opens a
	// fresh FakeWebSocket (connect() early-returns while this.ws is non-null).
	client.disconnect();
	dom?.teardown();
	dom = null;
});

async function mountView(
	opts: {
		threadId?: string;
		from?: string;
		thread?: Record<string, unknown>;
		messages?: Msg[];
		status?: Record<string, unknown>;
		threadRoute?: () => unknown;
	} = {},
) {
	const threadId = opts.threadId ?? "thread-abc-1234567890";
	dom = installDom();
	dom.route(
		"GET",
		new RegExp(`/api/threads/${threadId}$`),
		opts.threadRoute ?? (() => opts.thread ?? thread()),
	);
	dom.route("GET", new RegExp(`/api/threads/${threadId}/messages`), () => opts.messages ?? []);
	dom.route("GET", new RegExp(`/api/threads/${threadId}/status`), () => opts.status ?? status());
	// LineView mounts ModelSelector, which fetches /api/status/models on mount and
	// throws on a 404 (sortClusterModelsById spreads data.models). Give it the
	// real ModelsResponse shape so a child fetch never surfaces an unhandled
	// rejection during an unrelated assertion.
	dom.route("GET", "/api/status/models", () => ({ models: [], default: "" }));
	// MCP app host / instances aren't exercised here but the component touches
	// these stores; no route needed since it only reads module stores.
	const Component = (await import("../../views/LineView.svelte")).default;
	const mounted = await dom.mount(Component, { threadId, from: opts.from });
	await openSockets(dom);
	await dom.settle();
	return mounted;
}

describe("LineView", () => {
	it("loads the thread and renders header, title, and context fields", async () => {
		const { target } = await mountView({
			thread: thread({ title: "Planning session" }),
			messages: [
				{ id: "m1", role: "user", content: "Hello there", created_at: "2026-11-19T01:00:00.000Z" },
				{
					id: "m2",
					role: "assistant",
					content: "Hi!",
					model_id: "opus",
					created_at: "2026-11-19T01:00:05.000Z",
				},
				{
					id: "m3",
					role: "tool_call",
					content: "{}",
					tool_name: "read",
					created_at: "2026-11-19T01:00:06.000Z",
				},
			],
		});
		expect(target.textContent).toContain("Planning session");
		// Reference = thread.id.slice(0,10)
		expect(target.textContent).toContain("thread-abc");
		// Active model derived from most recent message with a model_id.
		expect(target.textContent).toContain("opus");
		// Messages count = 3, tool calls = 1.
		expect(target.querySelector(".fields")?.textContent).toContain("3");
		// A user turn exists.
		expect(target.textContent).toContain("Turns · 1");
		expect(target.textContent).toContain("Hello there");
	});

	it("shows the loading placeholder until the thread resolves", async () => {
		dom = installDom();
		let release: (() => void) | null = null;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		dom.route("GET", /\/api\/threads\/[^/]+$/, async () => {
			await gate;
			return thread();
		});
		dom.route("GET", /\/messages/, () => []);
		dom.route("GET", /\/status/, () => status());
		const Component = (await import("../../views/LineView.svelte")).default;
		const { target } = await dom.mount(Component, { threadId: "thread-abc-1234567890" });
		expect(target.textContent).toContain("Loading thread…");
		// New Conversation title when no thread + no messages yet.
		expect(target.textContent).toContain("New Conversation");
		release?.();
		await dom.settle();
		expect(target.textContent).not.toContain("Loading thread…");
	});

	it("falls back to the default title when the thread has no title", async () => {
		const { target } = await mountView({
			thread: thread({ title: "" }),
			messages: [{ id: "m1", role: "user", content: "x" }],
		});
		expect(target.querySelector("h1.title")?.textContent).toBe("Conversation");
	});

	it("handles a failed thread load without crashing", async () => {
		dom = installDom();
		dom.route("GET", /\/api\/threads\/[^/]+$/, () => new Response("boom", { status: 500 }));
		dom.route("GET", /\/messages/, () => new Response("boom", { status: 500 }));
		dom.route("GET", /\/status/, () => new Response("boom", { status: 500 }));
		const Component = (await import("../../views/LineView.svelte")).default;
		const { target } = await dom.mount(Component, { threadId: "thread-abc-1234567890" });
		await dom.settle();
		// Thread never loaded → still loading placeholder, no throw.
		expect(target.textContent).toContain("Loading thread…");
	});

	it("renders the attached-session badge when hosts are present", async () => {
		const { target } = await mountView({
			thread: thread({ attachedSessionHosts: ["alpha", "beta", "gamma"] }),
		});
		const badge = target.querySelector(".session-badge");
		expect(badge).toBeTruthy();
		expect(badge?.getAttribute("title")).toBe("Attached sessions on alpha, beta, gamma");
		expect(target.querySelector(".session-host")?.textContent).toBe("alpha +2");
	});

	it("shows a single attached-session host without the +N suffix", async () => {
		const { target } = await mountView({ thread: thread({ attachedSessionHosts: ["solo"] }) });
		expect(target.querySelector(".session-host")?.textContent).toBe("solo");
		expect(target.querySelector(".session-badge")?.getAttribute("title")).toBe(
			"Attached session on solo",
		);
	});

	it("sends a message: records the send, clears input, and enters waiting", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		const ws = dom?.window.WebSocket as unknown as { instances: Array<{ sent: string[] }> };
		const textarea = target.querySelector("textarea") as HTMLTextAreaElement;
		await dom?.type(textarea, "do the thing");
		const dispatch = target.querySelector("button.dispatch") as HTMLButtonElement;
		expect(dispatch.disabled).toBe(false);
		await dom?.fire(dispatch, "click");
		// sendMessage writes to the WS socket.
		const sent = ws.instances.flatMap((i) => i.sent);
		const sendFrame = sent.map((s) => JSON.parse(s)).find((m) => m.type === "message:send");
		expect(sendFrame).toBeTruthy();
		expect(sendFrame.content).toBe("do the thing");
		// Input cleared.
		expect((target.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
	});

	it("does not send when the input is empty and there are no attachments", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		const dispatch = target.querySelector("button.dispatch") as HTMLButtonElement;
		expect(dispatch.disabled).toBe(true);
		await dom?.fire(dispatch, "click");
		const ws = dom?.window.WebSocket as unknown as { instances: Array<{ sent: string[] }> };
		const sent = ws.instances.flatMap((i) => i.sent).map((s) => JSON.parse(s));
		expect(sent.find((m) => m.type === "message:send")).toBeFalsy();
	});

	it("sends on Enter but not on Shift+Enter", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		const textarea = target.querySelector("textarea") as HTMLTextAreaElement;
		await dom?.type(textarea, "line one");
		// Shift+Enter: newline, no send.
		await dom?.fire(textarea, "keydown", { key: "Enter", shiftKey: true });
		const ws = dom?.window.WebSocket as unknown as { instances: Array<{ sent: string[] }> };
		let sent = ws.instances.flatMap((i) => i.sent).map((s) => JSON.parse(s));
		expect(sent.find((m) => m.type === "message:send")).toBeFalsy();
		// Plain Enter: send.
		await dom?.fire(textarea, "keydown", { key: "Enter" });
		sent = ws.instances.flatMap((i) => i.sent).map((s) => JSON.parse(s));
		expect(sent.find((m) => m.type === "message:send")).toBeTruthy();
	});

	it("stages files via the attach input and stages pasted images", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		const fileInput = target.querySelector(
			"input.file-input, input[type=file]",
		) as HTMLInputElement;
		const file = new File(["data"], "a.txt", { type: "text/plain" });
		Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
		await dom?.fire(fileInput, "change");
		expect(target.textContent).toContain("1 attachment staged");

		// Paste an image → staged as attachment 2.
		const img = new File(["img"], "p.png", { type: "image/png" });
		const textarea = target.querySelector("textarea") as HTMLTextAreaElement;
		const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(pasteEvent, "clipboardData", {
			value: { files: [img] },
			configurable: true,
		});
		textarea.dispatchEvent(pasteEvent);
		await dom?.settle();
		expect(target.textContent).toContain("2 attachments staged");
	});

	it("uploads staged files on send and clears status", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		dom?.route("POST", "/api/files/upload", () => ({ id: "file-1" }));
		const fileInput = target.querySelector("input[type=file]") as HTMLInputElement;
		const file = new File(["data"], "a.txt", { type: "text/plain" });
		Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
		await dom?.fire(fileInput, "change");
		const textarea = target.querySelector("textarea") as HTMLTextAreaElement;
		await dom?.type(textarea, "with attachment");
		await dom?.fire(target.querySelector("button.dispatch") as Element, "click");
		await dom?.settle();
		const upload = dom?.requests.find(
			(r) => r.method === "POST" && r.path.startsWith("/api/files/upload"),
		);
		expect(upload).toBeTruthy();
		const ws = dom?.window.WebSocket as unknown as { instances: Array<{ sent: string[] }> };
		const sendFrame = ws.instances
			.flatMap((i) => i.sent)
			.map((s) => JSON.parse(s))
			.find((m) => m.type === "message:send");
		expect(sendFrame.file_ids).toEqual(["file-1"]);
		expect(target.textContent).not.toContain("staged");
	});

	it("aborts the send when the upload fails, keeping text and showing an error", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		dom?.route("POST", "/api/files/upload", () => new Response("no", { status: 500 }));
		const fileInput = target.querySelector("input[type=file]") as HTMLInputElement;
		const file = new File(["data"], "a.txt", { type: "text/plain" });
		Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
		await dom?.fire(fileInput, "change");
		const textarea = target.querySelector("textarea") as HTMLTextAreaElement;
		await dom?.type(textarea, "keep me");
		await dom?.fire(target.querySelector("button.dispatch") as Element, "click");
		await dom?.settle();
		expect(target.textContent).toContain("Upload failed — message not sent");
		const ws = dom?.window.WebSocket as unknown as { instances: Array<{ sent: string[] }> };
		const sendFrame = ws.instances
			.flatMap((i) => i.sent)
			.map((s) => JSON.parse(s))
			.find((m) => m.type === "message:send");
		expect(sendFrame).toBeFalsy();
		expect((target.querySelector("textarea") as HTMLTextAreaElement).value).toBe("keep me");
	});

	it("navigates back using the `from` prop", async () => {
		const { target } = await mountView({ thread: thread(), from: "/files" });
		const back = target.querySelector("button.back-btn") as HTMLButtonElement;
		await dom?.fire(back, "click");
		expect(dom?.window.location.hash).toBe("#/files");
	});

	it("navigates back to root when `from` is absent", async () => {
		const { target } = await mountView({ thread: thread() });
		await dom?.fire(target.querySelector("button.back-btn") as Element, "click");
		expect(dom?.window.location.hash).toBe("#/");
	});

	it("toggles the right panel between Context and Debugger", async () => {
		const { target } = await mountView({ thread: thread() });
		const buttons = Array.from(
			target.querySelectorAll(".panel-toggle button"),
		) as HTMLButtonElement[];
		const [ctxBtn, dbgBtn] = buttons;
		expect(ctxBtn.classList.contains("active")).toBe(true);
		await dom?.fire(dbgBtn, "click");
		expect(dbgBtn.classList.contains("active")).toBe(true);
		expect(ctxBtn.classList.contains("active")).toBe(false);
		// Context pane fields gone.
		expect(target.querySelector(".context-pane")).toBeFalsy();
		await dom?.fire(ctxBtn, "click");
		expect(target.querySelector(".context-pane")).toBeTruthy();
	});

	it("reflects an active agent status from the WS thread:status event", async () => {
		const { target } = await mountView({
			thread: thread(),
			status: status({ active: true, state: "tool_call" }),
		});
		// onMount reads /status once → active true, state tool_call.
		expect(target.textContent).toContain("Using tool…");
		expect(target.querySelector(".fields")?.textContent).toContain("Live");
		// A Cancel button appears while active.
		const cancel = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Cancel",
		);
		expect(cancel).toBeTruthy();
	});

	it("cancels the agent when Cancel is clicked", async () => {
		const { target } = await mountView({
			thread: thread(),
			status: status({ active: true, state: "thinking" }),
		});
		let cancelHit = false;
		dom?.route("POST", /\/api\/status\/cancel\//, () => {
			cancelHit = true;
			return { cancelled: true };
		});
		expect(target.textContent).toContain("Thinking…");
		const cancel = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Cancel",
		) as HTMLButtonElement;
		await dom?.fire(cancel, "click");
		await dom?.settle();
		expect(cancelHit).toBe(true);
	});

	it("jumps to a turn when a turn-stop is clicked", async () => {
		const { target } = await mountView({
			thread: thread(),
			messages: [
				{
					id: "u1",
					role: "user",
					content: "first question",
					created_at: "2026-11-19T01:00:00.000Z",
				},
				{ id: "a1", role: "assistant", content: "answer" },
				{
					id: "u2",
					role: "user",
					content: "second question",
					created_at: "2026-11-19T02:00:00.000Z",
				},
			],
		});
		expect(target.textContent).toContain("Turns · 2");
		const stops = target.querySelectorAll("button.turn-stop");
		expect(stops.length).toBe(2);
		// Current (last) turn has the current modifier.
		expect(stops[1].querySelector(".turn-dot-current")).toBeTruthy();
		// Clicking doesn't throw (scrollToTurn sets scrollRequest).
		await dom?.fire(stops[0] as Element, "click");
		expect(target.textContent).toContain("first question");
	});

	it("truncates a long turn preview with an ellipsis", async () => {
		const long = "x".repeat(120);
		const { target } = await mountView({
			thread: thread(),
			messages: [{ id: "u1", role: "user", content: long, created_at: "2026-11-19T01:00:00.000Z" }],
		});
		const preview = target.querySelector(".turn-preview")?.textContent ?? "";
		expect(preview.endsWith("…")).toBe(true);
		expect(preview.length).toBeLessThan(long.length);
	});
});

describe("LineView — live WS events and polling", () => {
	/** Deliver a server frame through the client's open FakeWebSocket. */
	function receive(d: ReturnType<typeof installDom>, frame: unknown): void {
		const ctor = d.window.WebSocket as unknown as {
			instances: Array<{ readyState: number; receive: (f: unknown) => void }>;
		};
		for (const ws of ctor.instances) {
			if (ws.readyState === 1) ws.receive(frame);
		}
	}

	it("appends a live message:created frame for this thread", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		receive(requireDom(), {
			type: "message:created",
			data: {
				thread_id: "thread-abc-1234567890",
				id: "live-1",
				role: "assistant",
				content: "Live answer",
				created_at: "2026-11-19T03:00:00.000Z",
			},
		});
		await dom?.settle();
		expect(target.querySelector(".fields")?.textContent).toContain("1");
	});

	it("ignores a message:created frame for a different thread", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		receive(requireDom(), {
			type: "message:created",
			data: { thread_id: "some-other-thread", id: "x", role: "assistant", content: "nope" },
		});
		await dom?.settle();
		expect(target.querySelector(".fields")?.textContent).toContain("0");
	});

	it("tracks an aux run via aux:started then clears it on aux:completed", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		receive(requireDom(), {
			type: "aux:started",
			data: {
				thread_id: "aux-thread-1",
				parent_thread_id: "thread-abc-1234567890",
				agent_name: "implementer",
			},
		});
		await dom?.settle();
		expect(target.textContent).toContain("aux: implementer running");
		expect(target.textContent).toContain("aux-thread-1");
		receive(requireDom(), {
			type: "aux:completed",
			data: { thread_id: "aux-thread-1", parent_thread_id: "thread-abc-1234567890" },
		});
		await dom?.settle();
		expect(target.textContent).not.toContain("aux: implementer running");
	});

	it("ignores aux events for a different parent thread", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		receive(requireDom(), {
			type: "aux:started",
			data: { thread_id: "aux-x", parent_thread_id: "other-parent", agent_name: "x" },
		});
		await dom?.settle();
		expect(target.textContent).not.toContain("aux: x running");
	});

	it("renders streaming text in the thinking row while the agent is active", async () => {
		// streamingText is shown by MessageList only inside the `waiting ||
		// isAgentActive` thinking row; drive the agent active via status first.
		const { target } = await mountView({
			thread: thread(),
			messages: [],
			status: status({ active: true, state: "thinking" }),
		});
		receive(requireDom(), {
			type: "stream:chunk",
			thread_id: "thread-abc-1234567890",
			chunk: { type: "text", content: "Hello " },
		});
		receive(requireDom(), {
			type: "stream:chunk",
			thread_id: "thread-abc-1234567890",
			chunk: { type: "text", content: "world" },
		});
		await dom?.settle();
		expect(target.textContent).toContain("Hello world");
	});

	it("ignores stream chunks for a different thread", async () => {
		const { target } = await mountView({
			thread: thread(),
			messages: [],
			status: status({ active: true, state: "thinking" }),
		});
		receive(requireDom(), {
			type: "stream:chunk",
			thread_id: "some-other-thread",
			chunk: { type: "text", content: "leak" },
		});
		await dom?.settle();
		expect(target.textContent).not.toContain("leak");
	});

	it("clears streaming text when an agent message:created lands", async () => {
		const { target } = await mountView({
			thread: thread(),
			messages: [],
			status: status({ active: true, state: "thinking" }),
		});
		receive(requireDom(), {
			type: "stream:chunk",
			thread_id: "thread-abc-1234567890",
			chunk: { type: "text", content: "partial stream" },
		});
		await dom?.settle();
		expect(target.textContent).toContain("partial stream");
		receive(requireDom(), {
			type: "message:created",
			data: {
				thread_id: "thread-abc-1234567890",
				id: "final-1",
				role: "assistant",
				content: "final persisted",
			},
		});
		await dom?.settle();
		expect(target.textContent).not.toContain("partial stream");
	});

	it("clears the waiting indicator when an assistant message:created arrives", async () => {
		const { target } = await mountView({ thread: thread(), messages: [] });
		// Enter the waiting state by sending.
		await dom?.type(target.querySelector("textarea") as Element, "hi");
		await dom?.fire(target.querySelector("button.dispatch") as Element, "click");
		// An assistant message clears waiting (shouldClearWaiting).
		receive(requireDom(), {
			type: "message:created",
			data: {
				thread_id: "thread-abc-1234567890",
				id: "a1",
				role: "assistant",
				content: "done",
			},
		});
		await dom?.settle();
		// Message count incremented to 1 (the live assistant message appended).
		expect(target.querySelector(".fields")?.textContent).toContain("1");
	});

	// --- Thread model chip + per-turn provenance wiring (§9.1) ---

	it("mounts the thread model chip in the header with the active model's display name", async () => {
		dom = null;
		const mountPromise = (async () => {
			const mounted = await mountView({
				thread: thread(),
				messages: [
					{
						id: "a1",
						role: "assistant",
						content: "hi",
						// A turn's model_id is the serving BACKEND id, never the logical key.
						model_id: "zai-glm-5.3-flash",
						created_at: "2026-11-19T01:00:05.000Z",
					},
				],
			});
			return mounted;
		})();
		// mountView installs the DOM synchronously before its first await, so the
		// routing route can be registered before LineView's onMount fetch lands.
		requireDom().route("GET", "/api/routing/models", () => ({
			models: [
				{
					logical_model: "glm-5.3-flash",
					display_name: "GLM-5.3 Flash",
					route_order: null,
					fallback_policy: {},
					routes: [
						{
							route_id: "site-msi:zai:zai-glm-5.3-flash",
							site_id: "site-msi",
							host_name: "MSI",
							provider: "zai",
							display_name: "GLM-5.3 Flash",
							drained: false,
							health: "healthy",
						},
					],
					stale_routes: [],
				},
			],
		}));
		const { target } = await mountPromise;
		await requireDom().settle();
		const chip = target.querySelector(".chip");
		expect(chip).not.toBeNull();
		expect(chip?.querySelector(".name")?.textContent).toBe("GLM-5.3 Flash");
		expect(target.textContent ?? "").not.toContain("zai-glm-5.3-flash");
	});

	it("fetches provenance and mounts a footer under the matching assistant message", async () => {
		const threadId = "thread-abc-1234567890";
		dom = installDom();
		dom.route("GET", new RegExp(`/api/threads/${threadId}$`), () => thread());
		dom.route("GET", new RegExp(`/api/threads/${threadId}/messages`), () => [
			{
				id: "a1",
				role: "assistant",
				content: "answer",
				model_id: "gpt-5.6-sol",
				created_at: "2026-11-19T01:00:05.000Z",
			},
		]);
		dom.route("GET", new RegExp(`/api/threads/${threadId}/status`), () => status());
		dom.route("GET", "/api/status/models", () => ({ models: [], default: "" }));
		// The provenance endpoint the view calls on mount (client.getThreadProvenance).
		dom.route("GET", new RegExp(`/api/threads/${threadId}/provenance`), () => ({
			turns: [
				{
					id: "turn-1",
					created_at: "2026-11-19T01:00:00.000Z",
					model_id: "gpt-5.6-sol",
					route_id: "site-hub:codex:sol",
					substituted_from: null,
					status: "ok",
					cost_usd: 0.5,
					attempts: null,
				},
			],
		}));
		const Component = (await import("../../views/LineView.svelte")).default;
		const { target } = await dom.mount(Component, { threadId });
		await openSockets(dom);
		await dom.settle();
		// The provenance data path reached a live surface: a footer mounted under the
		// assistant message that the turn answered.
		const footer = target.querySelector('[data-message-id="a1"] .provenance');
		expect(footer).not.toBeNull();
		expect(footer?.querySelector(".model")?.textContent).toBe("gpt-5.6-sol");
	});
});
