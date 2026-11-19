import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { BoundApiError, BoundClient, BoundNotRunningError } from "../client.js";
import type { ToolCallRequest, ToolDefinition } from "../types.js";

/**
 * Behavioral coverage for {@link BoundClient} driven against a real
 * `Bun.serve` fake server bound to port 0 (an OS-assigned ephemeral port, per
 * CONTRIBUTING: the OS only hands out free ports so collisions are impossible).
 *
 * The server records every HTTP request it sees (method, path, headers, parsed
 * body) and every raw WebSocket frame, and lets each test script the response
 * for a given route. This exercises the actual `fetch`/`WebSocket` code paths
 * in the client — request shape, response parsing, error mapping, the WS
 * connect/reconnect/heartbeat machinery, subscription resend, session
 * configure, event emission and the client-tool round-trip — rather than a
 * stubbed `global.fetch`.
 */

interface RecordedRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Headers;
	body: unknown;
}

type RouteHandler = (req: RecordedRequest, raw: Request) => Response | Promise<Response>;

interface FakeServer {
	server: Server;
	baseUrl: string;
	requests: RecordedRequest[];
	/** Raw JSON-parsed frames received over any WS connection. */
	wsFrames: Record<string, unknown>[];
	/** Sockets currently open, so a test can push server→client frames. */
	sockets: Set<ServerWebSocket<unknown>>;
	/** Register a handler for `METHOD /path` (exact path match, no query). */
	route(key: string, handler: RouteHandler): void;
	/** Send a raw string to every open socket. */
	broadcast(data: string): void;
	stop(): Promise<void>;
}

function startFakeServer(): FakeServer {
	const requests: RecordedRequest[] = [];
	const wsFrames: Record<string, unknown>[] = [];
	const sockets = new Set<ServerWebSocket<unknown>>();
	const routes = new Map<string, RouteHandler>();
	// Scripted behavior for the next WS connection's open handler.
	let onSocketOpen: ((ws: ServerWebSocket<unknown>) => void) | null = null;

	const server = Bun.serve({
		port: 0,
		async fetch(req, srv) {
			const url = new URL(req.url);
			// WS upgrade on /ws
			if (url.pathname === "/ws") {
				if (srv.upgrade(req)) return undefined as unknown as Response;
				return new Response("expected websocket", { status: 426 });
			}
			let body: unknown;
			const contentType = req.headers.get("Content-Type") ?? "";
			if (contentType.includes("application/json")) {
				body = await req.json().catch(() => undefined);
			} else if (req.method !== "GET" && req.method !== "HEAD") {
				body = await req.text().catch(() => undefined);
			}
			const recorded: RecordedRequest = {
				method: req.method,
				path: url.pathname,
				query: url.searchParams,
				headers: req.headers,
				body,
			};
			requests.push(recorded);
			const handler = routes.get(`${req.method} ${url.pathname}`);
			if (handler) return handler(recorded, req);
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
				onSocketOpen?.(ws);
			},
			message(_ws, message) {
				try {
					wsFrames.push(JSON.parse(String(message)) as Record<string, unknown>);
				} catch {
					/* ignore non-JSON frames */
				}
			},
			close(ws) {
				sockets.delete(ws);
			},
		},
	});

	const baseUrl = `http://127.0.0.1:${server.port}`;

	return {
		server,
		baseUrl,
		requests,
		wsFrames,
		sockets,
		route(key, handler) {
			routes.set(key, handler);
		},
		broadcast(data) {
			for (const ws of sockets) ws.send(data);
		},
		set onOpen(fn: (ws: ServerWebSocket<unknown>) => void) {
			onSocketOpen = fn;
		},
		async stop() {
			await server.stop(true);
		},
	} as FakeServer & { onOpen: (ws: ServerWebSocket<unknown>) => void };
}

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

/** Wait until `predicate` is true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

let fake: FakeServer;
let client: BoundClient;

beforeEach(() => {
	fake = startFakeServer();
	client = new BoundClient(fake.baseUrl);
});

afterEach(async () => {
	client.disconnect();
	await fake.stop();
});

describe("BoundClient HTTP — threads", () => {
	it("listThreads returns the server's thread array and omits query params by default", async () => {
		fake.route("GET /api/threads", () => json([{ id: "t-1" }, { id: "t-2" }]));
		const threads = await client.listThreads();
		expect(threads).toEqual([{ id: "t-1" }, { id: "t-2" }] as never);
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("GET");
		expect(req?.query.toString()).toBe("");
	});

	it("listThreads forwards includeEmpty, limit and the before cursor", async () => {
		fake.route("GET /api/threads", () => json([]));
		await client.listThreads({
			includeEmpty: true,
			limit: 50,
			before: { last_message_at: "2026-01-01T00:00:00Z", id: "t-9" },
		});
		const req = fake.requests.at(-1);
		expect(req?.query.get("include_empty")).toBe("true");
		expect(req?.query.get("limit")).toBe("50");
		expect(req?.query.get("before_ts")).toBe("2026-01-01T00:00:00Z");
		expect(req?.query.get("before_id")).toBe("t-9");
	});

	it("listThreadsPage reads X-Total-Count from the response header", async () => {
		fake.route("GET /api/threads", () =>
			json([{ id: "t-1" }], { headers: { "X-Total-Count": "42" } }),
		);
		const page = await client.listThreadsPage();
		expect(page.total).toBe(42);
		expect(page.threads).toEqual([{ id: "t-1" }] as never);
	});

	it("listThreadsPage falls back to page length when the header is absent", async () => {
		fake.route("GET /api/threads", () => json([{ id: "t-1" }, { id: "t-2" }]));
		const page = await client.listThreadsPage();
		expect(page.total).toBe(2);
	});

	it("listThreadsPage falls back to page length when the header is non-numeric", async () => {
		fake.route("GET /api/threads", () =>
			json([{ id: "t-1" }], { headers: { "X-Total-Count": "not-a-number" } }),
		);
		const page = await client.listThreadsPage();
		expect(page.total).toBe(1);
	});

	it("createThread POSTs an empty body by default (interface defaults server-side)", async () => {
		fake.route("POST /api/threads", () => json({ id: "new" }));
		const thread = await client.createThread();
		expect((thread as { id: string }).id).toBe("new");
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("POST");
		expect(req?.body).toEqual({});
		expect(req?.headers.get("Content-Type")).toBe("application/json");
	});

	it("createThread passes a non-empty interface tag through", async () => {
		fake.route("POST /api/threads", () => json({ id: "new" }));
		await client.createThread({ interface: "boundless" });
		expect(fake.requests.at(-1)?.body).toEqual({ interface: "boundless" });
	});

	it("renameThread PATCHes the title and returns the updated thread", async () => {
		fake.route("PATCH /api/threads/t-1", () => json({ id: "t-1", title: "Renamed" }));
		const updated = await client.renameThread("t-1", "Renamed");
		expect((updated as { title: string }).title).toBe("Renamed");
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("PATCH");
		expect(req?.path).toBe("/api/threads/t-1");
		expect(req?.body).toEqual({ title: "Renamed" });
	});

	it("getThread GETs the thread detail", async () => {
		fake.route("GET /api/threads/t-1", () => json({ id: "t-1" }));
		const detail = await client.getThread("t-1");
		expect((detail as { id: string }).id).toBe("t-1");
	});

	it("getThreadStatus validates the response against the schema", async () => {
		fake.route("GET /api/threads/t-1/status", () =>
			json({ active: true, state: "LLM_CALL", detail: null, tokens: 500, model: "opus" }),
		);
		const status = await client.getThreadStatus("t-1");
		expect(status).toEqual({
			active: true,
			state: "LLM_CALL",
			detail: null,
			tokens: 500,
			model: "opus",
		});
	});

	it("getThreadStatus rejects a response that violates the schema", async () => {
		fake.route("GET /api/threads/t-1/status", () => json({ active: "yes", tokens: "lots" }));
		await expect(client.getThreadStatus("t-1")).rejects.toThrow();
	});

	it("getContextDebug GETs the context-debug turns", async () => {
		fake.route("GET /api/threads/t-1/context-debug", () => json([{ turn: 1 }]));
		const turns = await client.getContextDebug("t-1");
		expect(turns).toEqual([{ turn: 1 }] as never);
	});

	it("getThreadCost unwraps the cost_usd field", async () => {
		fake.route("GET /api/threads/t-1/cost", () => json({ cost_usd: 1.23 }));
		expect(await client.getThreadCost("t-1")).toBe(1.23);
	});

	it("getMetricsTotals sends an ISO from/to range and unwraps tokens.totals", async () => {
		fake.route("GET /api/metrics", () => json({ tokens: { totals: { input: 10, output: 5 } } }));
		const from = new Date("2026-01-01T00:00:00Z");
		const to = new Date("2026-01-02T00:00:00Z");
		const totals = await client.getMetricsTotals(from, to);
		expect(totals).toEqual({ input: 10, output: 5 } as never);
		const req = fake.requests.at(-1);
		expect(req?.query.get("from")).toBe(from.toISOString());
		expect(req?.query.get("to")).toBe(to.toISOString());
	});
});

describe("BoundClient HTTP — messages", () => {
	it("listMessages GETs messages without a limit by default", async () => {
		fake.route("GET /api/threads/t-1/messages", () => json([{ id: "m-1" }]));
		const msgs = await client.listMessages("t-1");
		expect(msgs).toEqual([{ id: "m-1" }] as never);
		expect(fake.requests.at(-1)?.query.toString()).toBe("");
	});

	it("listMessages forwards the limit query param", async () => {
		fake.route("GET /api/threads/t-1/messages", () => json([]));
		await client.listMessages("t-1", { limit: 25 });
		expect(fake.requests.at(-1)?.query.get("limit")).toBe("25");
	});

	it("redactMessage POSTs to the redact route", async () => {
		fake.route("POST /api/threads/t-1/messages/m-1/redact", () => json({ redacted: true }));
		const result = await client.redactMessage("t-1", "m-1");
		expect((result as { redacted: boolean }).redacted).toBe(true);
		expect(fake.requests.at(-1)?.method).toBe("POST");
	});

	it("redactThread POSTs to the thread redact route", async () => {
		fake.route("POST /api/threads/t-1/redact", () => json({ redacted: 3 }));
		const result = await client.redactThread("t-1");
		expect((result as { redacted: number }).redacted).toBe(3);
	});
});

describe("BoundClient HTTP — files", () => {
	it("listFiles GETs /api/files", async () => {
		fake.route("GET /api/files", () => json([{ path: "a.txt" }]));
		expect(await client.listFiles()).toEqual([{ path: "a.txt" }] as never);
	});

	it("getFile GETs the path-scoped file", async () => {
		fake.route("GET /api/files/notes.md", () => json({ path: "notes.md", content: "hi" }));
		const file = await client.getFile("notes.md");
		expect((file as { content: string }).content).toBe("hi");
	});

	it("downloadFile returns the raw Response for a 200", async () => {
		fake.route("GET /api/files/download", () => new Response("raw-bytes", { status: 200 }));
		const res = await client.downloadFile("some/path.bin");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("raw-bytes");
		expect(fake.requests.at(-1)?.query.get("path")).toBe("some/path.bin");
	});

	it("downloadFile maps a non-ok response to BoundApiError with the server's message", async () => {
		fake.route("GET /api/files/download", () => json({ error: "no such file" }, { status: 404 }));
		await expect(client.downloadFile("missing")).rejects.toMatchObject({
			name: "BoundApiError",
			status: 404,
			message: "no such file",
		});
	});

	it("downloadFile falls back to HTTP <status> when the error body is not JSON", async () => {
		fake.route("GET /api/files/download", () => new Response("boom", { status: 500 }));
		await expect(client.downloadFile("x")).rejects.toMatchObject({
			name: "BoundApiError",
			status: 500,
			message: "HTTP 500",
		});
	});

	it("uploadFile POSTs multipart form data and returns the created file", async () => {
		fake.route("POST /api/files/upload", () => json({ path: "up.txt" }));
		const file = await client.uploadFile(new Blob(["data"]), "up.txt");
		expect((file as { path: string }).path).toBe("up.txt");
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("POST");
		expect(req?.headers.get("Content-Type")).toContain("multipart/form-data");
	});
});

describe("BoundClient HTTP — tasks", () => {
	it("listTasks GETs tasks and forwards a status filter", async () => {
		fake.route("GET /api/tasks", () => json([{ id: "task-1" }]));
		await client.listTasks({ status: "pending" });
		expect(fake.requests.at(-1)?.query.get("status")).toBe("pending");
	});

	it("listTasks omits the query string with no options", async () => {
		fake.route("GET /api/tasks", () => json([]));
		await client.listTasks();
		expect(fake.requests.at(-1)?.query.toString()).toBe("");
	});

	it("getTask GETs a single task", async () => {
		fake.route("GET /api/tasks/task-1", () => json({ id: "task-1" }));
		expect((await client.getTask("task-1")).id).toBe("task-1" as never);
	});

	it("cancelTask POSTs to the cancel route", async () => {
		fake.route("POST /api/tasks/task-1/cancel", () => json({ id: "task-1", status: "cancelled" }));
		const task = await client.cancelTask("task-1");
		expect((task as { status: string }).status).toBe("cancelled");
		expect(fake.requests.at(-1)?.method).toBe("POST");
	});

	it("updateTask PATCHes the task with the updates body", async () => {
		fake.route("PATCH /api/tasks/task-1", () => json({ id: "task-1" }));
		await client.updateTask("task-1", { no_history: true, model_hint: "opus", alert_threshold: 3 });
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("PATCH");
		expect(req?.body).toEqual({ no_history: true, model_hint: "opus", alert_threshold: 3 });
	});
});

describe("BoundClient HTTP — advisories", () => {
	it("listAdvisories forwards a status filter", async () => {
		fake.route("GET /api/advisories", () => json([{ id: "adv-1" }]));
		await client.listAdvisories({ status: "proposed" });
		expect(fake.requests.at(-1)?.query.get("status")).toBe("proposed");
	});

	it("countAdvisories GETs the count route", async () => {
		fake.route("GET /api/advisories/count", () => json({ proposed: 2 }));
		expect(await client.countAdvisories()).toEqual({ proposed: 2 } as never);
	});

	it("approve/dismiss/defer/apply each POST the note to the matching route", async () => {
		const actions: Array<
			["approveAdvisory" | "dismissAdvisory" | "deferAdvisory" | "applyAdvisory", string]
		> = [
			["approveAdvisory", "approve"],
			["dismissAdvisory", "dismiss"],
			["deferAdvisory", "defer"],
			["applyAdvisory", "apply"],
		];
		for (const [, verb] of actions) {
			fake.route(`POST /api/advisories/adv-1/${verb}`, () => json({ id: "adv-1" }));
		}
		for (const [method, verb] of actions) {
			await client[method]("adv-1", `${verb} note`);
			const req = fake.requests.at(-1);
			expect(req?.path).toBe(`/api/advisories/adv-1/${verb}`);
			expect(req?.method).toBe("POST");
			expect(req?.body).toEqual({ note: `${verb} note` });
		}
	});
});

describe("BoundClient HTTP — webhooks, rss, connectors", () => {
	it("deleteWebhook DELETEs and resolves void", async () => {
		fake.route("DELETE /api/webhooks/wh-1", () => new Response(null, { status: 204 }));
		await expect(client.deleteWebhook("wh-1")).resolves.toBeUndefined();
		expect(fake.requests.at(-1)?.method).toBe("DELETE");
	});

	it("getWebhookUnauthenticatedSwitch GETs the switch", async () => {
		fake.route("GET /api/webhooks/unauthenticated-switch", () =>
			json({ allow_unauthenticated: false }),
		);
		expect(await client.getWebhookUnauthenticatedSwitch()).toEqual({
			allow_unauthenticated: false,
		} as never);
	});

	it("setWebhookUnauthenticatedSwitch PUTs the allow flag", async () => {
		fake.route("PUT /api/webhooks/unauthenticated-switch", () =>
			json({ allow_unauthenticated: true }),
		);
		await client.setWebhookUnauthenticatedSwitch(true);
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("PUT");
		expect(req?.body).toEqual({ allow_unauthenticated: true });
	});

	it("createRssFeed POSTs options; updateRssFeed PATCHes; deleteRssFeed DELETEs", async () => {
		fake.route("POST /api/rss-feeds", () => json({ id: "feed-1" }));
		fake.route("PATCH /api/rss-feeds/feed-1", () => json({ id: "feed-1" }));
		fake.route("DELETE /api/rss-feeds/feed-1", () => new Response(null, { status: 204 }));
		await client.createRssFeed({ name: "f", url: "https://e.com/rss" } as never);
		expect(fake.requests.at(-1)?.method).toBe("POST");
		await client.updateRssFeed("feed-1", { url: "https://e.com/rss2" } as never);
		expect(fake.requests.at(-1)?.method).toBe("PATCH");
		await client.deleteRssFeed("feed-1");
		expect(fake.requests.at(-1)?.method).toBe("DELETE");
	});

	it("getRssFeed and listRssFeeds GET the matching routes", async () => {
		fake.route("GET /api/rss-feeds", () => json([{ id: "feed-1" }]));
		fake.route("GET /api/rss-feeds/feed-1", () => json({ id: "feed-1" }));
		expect(await client.listRssFeeds()).toEqual([{ id: "feed-1" }] as never);
		expect((await client.getRssFeed("feed-1")).id).toBe("feed-1" as never);
	});

	it("listConnectorBindings GETs; detach DELETEs; update PATCHes", async () => {
		fake.route("GET /api/connectors/bindings", () => json({ bindings: [] }));
		fake.route("DELETE /api/connectors/bindings/b-1", () => new Response(null, { status: 204 }));
		fake.route("PATCH /api/connectors/bindings/b-1", () => json({ id: "b-1" }));
		expect(await client.listConnectorBindings()).toEqual({ bindings: [] } as never);
		await client.detachConnectorBinding("b-1");
		expect(fake.requests.at(-1)?.method).toBe("DELETE");
		await client.updateConnectorBinding("b-1", { model_hint: "opus" } as never);
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("PATCH");
		expect(req?.body).toEqual({ model_hint: "opus" });
	});
});

describe("BoundClient HTTP — status, memory, skills", () => {
	it("getStatus / getNetwork / listModels / getMemoryGraph GET their routes", async () => {
		fake.route("GET /api/status", () => json({ ok: true }));
		fake.route("GET /api/status/network", () => json({ peers: [] }));
		fake.route("GET /api/status/models", () => json({ models: [] }));
		fake.route("GET /api/memory/graph", () => json({ nodes: [], edges: [] }));
		expect(await client.getStatus()).toEqual({ ok: true } as never);
		expect(await client.getNetwork()).toEqual({ peers: [] } as never);
		expect(await client.listModels()).toEqual({ models: [] } as never);
		expect(await client.getMemoryGraph()).toEqual({ nodes: [], edges: [] } as never);
	});

	it("cancelThread POSTs to the status cancel route", async () => {
		fake.route("POST /api/status/cancel/t-1", () => json({ cancelled: true }));
		const result = await client.cancelThread("t-1");
		expect((result as { cancelled: boolean }).cancelled).toBe(true);
		expect(fake.requests.at(-1)?.method).toBe("POST");
	});

	it("listSkills / getSkill GET; deleteSkill DELETEs", async () => {
		fake.route("GET /api/skills", () => json([{ id: "s-1" }]));
		fake.route("GET /api/skills/s-1", () =>
			json({ skill: { id: "s-1" }, content: "x", files: [] }),
		);
		fake.route("DELETE /api/skills/s-1", () => new Response(null, { status: 204 }));
		expect(await client.listSkills()).toEqual([{ id: "s-1" }] as never);
		expect((await client.getSkill("s-1")).content).toBe("x");
		await client.deleteSkill("s-1");
		expect(fake.requests.at(-1)?.method).toBe("DELETE");
	});

	it("createSkill with a plain object POSTs JSON", async () => {
		fake.route("POST /api/skills", () => json({ skill: { id: "s-1" } }));
		await client.createSkill({ name: "n", description: "d", body: "b" });
		const req = fake.requests.at(-1);
		expect(req?.headers.get("Content-Type")).toBe("application/json");
		expect(req?.body).toEqual({ name: "n", description: "d", body: "b" });
	});

	it("createSkill with FormData POSTs multipart", async () => {
		fake.route("POST /api/skills", () => json({ skill: { id: "s-1" } }));
		const fd = new FormData();
		fd.append("name", "n");
		await client.createSkill(fd);
		expect(fake.requests.at(-1)?.headers.get("Content-Type")).toContain("multipart/form-data");
	});

	it("updateSkill PATCHes the skill body", async () => {
		fake.route("PATCH /api/skills/s-1", () => json({ skill: { id: "s-1" } }));
		await client.updateSkill("s-1", { body: "new" });
		const req = fake.requests.at(-1);
		expect(req?.method).toBe("PATCH");
		expect(req?.body).toEqual({ body: "new" });
	});
});

describe("BoundClient HTTP — error mapping", () => {
	it("maps a non-ok JSON response to BoundApiError carrying status and details", async () => {
		fake.route("GET /api/status", () =>
			json({ error: "bad", details: { field: "x" } }, { status: 400 }),
		);
		const err = (await client.getStatus().catch((e) => e)) as BoundApiError;
		expect(err).toBeInstanceOf(BoundApiError);
		expect(err.status).toBe(400);
		expect(err.message).toBe("bad");
		expect(err.details).toEqual({ field: "x" });
	});

	it("falls back to HTTP <status> when the error body omits an error field", async () => {
		fake.route("GET /api/status", () => new Response("plain text", { status: 503 }));
		await expect(client.getStatus()).rejects.toMatchObject({
			name: "BoundApiError",
			status: 503,
			message: "HTTP 503",
		});
	});

	it("wraps a connection failure as BoundNotRunningError referencing the base URL", async () => {
		// Point at a base URL with no server listening.
		const dead = new BoundClient("http://127.0.0.1:1");
		const err = (await dead.getStatus().catch((e) => e)) as BoundNotRunningError;
		expect(err).toBeInstanceOf(BoundNotRunningError);
		expect(err.message).toContain("http://127.0.0.1:1");
		expect((err as { cause?: unknown }).cause).toBeDefined();
	});
});

describe("BoundClient constructor URL handling", () => {
	it("strips a trailing slash from the base URL", () => {
		const c = new BoundClient("http://localhost:3001/");
		expect(c.getBaseUrl()).toBe("http://localhost:3001");
	});

	it("getBackgroundCount defaults to 0 for an unseen thread", () => {
		expect(client.getBackgroundCount("unknown")).toBe(0);
	});
});

describe("BoundClient WebSocket lifecycle", () => {
	it("connect() resolves on open and transitions disconnected→connecting→connected", async () => {
		const states: string[] = [];
		client.on("connection:state", (s) => states.push(s as string));
		let opened = false;
		client.on("open", () => {
			opened = true;
		});
		await client.connect();
		expect(opened).toBe(true);
		expect(client.connectionState).toBe("connected");
		expect(states).toEqual(["connecting", "connected"]);
	});

	it("connect() is idempotent — a second call does not open a second socket", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		await client.connect();
		// Give any erroneous second socket a chance to appear.
		await new Promise((r) => setTimeout(r, 50));
		expect(fake.sockets.size).toBe(1);
	});

	it("subscribe before connect replays the subscription on open (resendSubscriptions)", async () => {
		client.subscribe("t-sub");
		await client.connect();
		await waitFor(() => fake.wsFrames.some((f) => f.type === "thread:subscribe"));
		const sub = fake.wsFrames.find((f) => f.type === "thread:subscribe");
		expect(sub).toMatchObject({ type: "thread:subscribe", thread_id: "t-sub" });
	});

	it("configureTools before connect replays session:configure on open", async () => {
		const tools: ToolDefinition[] = [
			{ type: "function", function: { name: "t", description: "d", parameters: {} } },
		];
		client.configureTools(tools, { systemPromptAddition: "be terse" });
		await client.connect();
		await waitFor(() => fake.wsFrames.some((f) => f.type === "session:configure"));
		const cfg = fake.wsFrames.find((f) => f.type === "session:configure");
		expect(cfg).toMatchObject({ type: "session:configure", systemPromptAddition: "be terse" });
		expect((cfg as { tools: unknown[] }).tools).toHaveLength(1);
	});

	it("unsubscribe sends a thread:unsubscribe frame on an open socket", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		client.unsubscribe("t-x");
		await waitFor(() => fake.wsFrames.some((f) => f.type === "thread:unsubscribe"));
		expect(fake.wsFrames.find((f) => f.type === "thread:unsubscribe")).toMatchObject({
			thread_id: "t-x",
		});
	});

	it("sendMessage writes a message:send frame with content, model and tz_offset", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		client.sendMessage("t-1", "hello", { modelId: "opus", tzOffsetMinutes: 120 });
		await waitFor(() => fake.wsFrames.some((f) => f.type === "message:send"));
		const frame = fake.wsFrames.find((f) => f.type === "message:send");
		expect(frame).toMatchObject({
			type: "message:send",
			thread_id: "t-1",
			content: "hello",
			model_id: "opus",
			tz_offset: 120,
		});
	});

	it("sendMessage with tzOffsetMinutes:null suppresses the tz_offset field", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		client.sendMessage("t-1", "hi", { tzOffsetMinutes: null });
		await waitFor(() => fake.wsFrames.some((f) => f.type === "message:send"));
		const frame = fake.wsFrames.find((f) => f.type === "message:send");
		expect("tz_offset" in (frame as object)).toBe(false);
	});

	it("stageContext writes a context:stage frame and fires no turn", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		client.stageContext("t-1", "staged text");
		await waitFor(() => fake.wsFrames.some((f) => f.type === "context:stage"));
		expect(fake.wsFrames.find((f) => f.type === "context:stage")).toMatchObject({
			type: "context:stage",
			thread_id: "t-1",
			content: "staged text",
		});
		// No message:send turn was fired.
		expect(fake.wsFrames.some((f) => f.type === "message:send")).toBe(false);
	});

	it("disconnect() closes the socket and transitions to disconnected", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		const states: string[] = [];
		client.on("connection:state", (s) => states.push(s as string));
		let closed = false;
		client.on("close", () => {
			closed = true;
		});
		client.disconnect();
		await waitFor(() => fake.sockets.size === 0);
		await waitFor(() => closed);
		expect(client.connectionState).toBe("disconnected");
	});

	it("after a server-initiated close, shouldReconnect schedules a reconnect that re-opens", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		let reopened = 0;
		client.on("open", () => {
			reopened++;
		});
		// Server closes every open socket; client should schedule a reconnect
		// (base delay 1s * jitter 0.5–1.5) and re-open.
		for (const ws of fake.sockets) ws.close();
		await waitFor(() => reopened >= 1, 5000);
		expect(reopened).toBeGreaterThanOrEqual(1);
		expect(client.connectionState).toBe("connected");
	});
});

describe("BoundClient WebSocket message handling", () => {
	it("emits a server tool:call to a registered handler and relays tool:result", async () => {
		let received: ToolCallRequest | null = null;
		client.onToolCall(async (call) => {
			received = call;
			return { call_id: call.call_id, output: "done" } as never;
		});
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		fake.broadcast(
			JSON.stringify({
				type: "tool:call",
				call_id: "c-1",
				tool_name: "browser_click",
				arguments: {},
			}),
		);
		await waitFor(() => fake.wsFrames.some((f) => f.type === "tool:result"));
		expect(received).toMatchObject({ call_id: "c-1", tool_name: "browser_click" });
		const result = fake.wsFrames.find((f) => f.type === "tool:result");
		expect(result).toMatchObject({ type: "tool:result", call_id: "c-1", output: "done" });
	});

	it("emits tool:cancel to listeners with callId/threadId/reason", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		let cancel: Record<string, unknown> | null = null;
		client.on("tool:cancel", (e) => {
			cancel = e as Record<string, unknown>;
		});
		fake.broadcast(
			JSON.stringify({ type: "tool:cancel", call_id: "c-1", thread_id: "t-1", reason: "user" }),
		);
		await waitFor(() => cancel !== null);
		expect(cancel).toEqual({ callId: "c-1", threadId: "t-1", reason: "user" });
	});

	it("retains background:count so a late getBackgroundCount reader hydrates", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		fake.broadcast(JSON.stringify({ type: "background:count", thread_id: "t-1", count: 3 }));
		await waitFor(() => client.getBackgroundCount("t-1") === 3);
		expect(client.getBackgroundCount("t-1")).toBe(3);
	});

	it("unwraps a data-wrapped event (message:created) before emitting", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		let msg: Record<string, unknown> | null = null;
		client.on("message:created", (m) => {
			msg = m as Record<string, unknown>;
		});
		fake.broadcast(
			JSON.stringify({ type: "message:created", data: { id: "m-1", role: "assistant" } }),
		);
		await waitFor(() => msg !== null);
		expect(msg).toEqual({ id: "m-1", role: "assistant" });
	});

	it("passes a flat event (thread:status) through without unwrapping", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		let status: Record<string, unknown> | null = null;
		client.on("thread:status", (s) => {
			status = s as Record<string, unknown>;
		});
		fake.broadcast(
			JSON.stringify({ type: "thread:status", thread_id: "t-1", active: true, tokens: 10 }),
		);
		await waitFor(() => status !== null);
		expect(status).toMatchObject({ type: "thread:status", thread_id: "t-1", active: true });
	});

	it("ignores a malformed (non-JSON) frame without throwing", async () => {
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		let errored = false;
		client.on("error", () => {
			errored = true;
		});
		fake.broadcast("this is not json{");
		await new Promise((r) => setTimeout(r, 50));
		expect(errored).toBe(false);
	});

	it("relays a TOOL_CALL_ERROR to error listeners when the handler rejects", async () => {
		client.onToolCall(async () => {
			throw new Error("handler blew up");
		});
		await client.connect();
		await waitFor(() => fake.sockets.size === 1);
		let errorPayload: Record<string, unknown> | null = null;
		client.on("error", (e) => {
			const payload = e as Record<string, unknown>;
			if (payload?.code === "TOOL_CALL_ERROR") errorPayload = payload;
		});
		fake.broadcast(
			JSON.stringify({ type: "tool:call", call_id: "c-err", tool_name: "x", arguments: {} }),
		);
		await waitFor(() => errorPayload !== null);
		expect(errorPayload).toMatchObject({ code: "TOOL_CALL_ERROR" });
		expect(String((errorPayload as Record<string, unknown>).message)).toContain("handler blew up");
		// A handler rejection must NOT emit a tool:result frame.
		expect(fake.wsFrames.some((f) => f.type === "tool:result")).toBe(false);
	});
});

describe("BoundClient WebSocket connect failure", () => {
	it("connect() rejects when the socket errors before it ever opens", async () => {
		// Stop the fake server, then point a fresh client at the now-dead port.
		// The socket errors/closes before reaching the 'connected' state, which
		// drives the pre-connection onError reject branch in connect().
		const deadPort = fake.server.port;
		await fake.stop();
		const dead = new BoundClient(`http://127.0.0.1:${deadPort}`);
		await expect(dead.connect()).rejects.toThrow(/WebSocket connection failed|Connection timeout/);
		dead.disconnect();
	});
});

describe("BoundClient event registry", () => {
	it("off removes a handler so it no longer fires", () => {
		let count = 0;
		const handler = () => {
			count++;
		};
		client.on("connection:state", handler);
		const setState = (
			client as unknown as { setConnectionState(s: string): void }
		).setConnectionState.bind(client);
		setState("connecting");
		expect(count).toBe(1);
		client.off("connection:state", handler);
		setState("connected");
		expect(count).toBe(1);
	});

	it("off on an unregistered event is a no-op", () => {
		expect(() => client.off("open", () => {})).not.toThrow();
	});
});
