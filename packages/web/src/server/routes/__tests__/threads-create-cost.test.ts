import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import { createThreadsRoutes } from "../threads";

// Covers the threads-route handlers the existing per-endpoint tests don't:
// POST / (create, including the interface-tag validation branches and color
// cycling), GET /:id/cost (whole-life spend rollup + 404), and the datastore
// 500 paths.

const SITE = "test-site";
const OPERATOR = "operator-1";

function seedThread(db: Database, id: string, color = 0, iface = "web"): void {
	const now = "2026-07-04T00:00:00.000Z";
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: OPERATOR,
			interface: iface,
			host_origin: SITE,
			color,
			title: "t",
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			model_hint: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
}

function postCreate(app: ReturnType<typeof createThreadsRoutes>, body?: unknown) {
	return app.request("/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

describe("threads routes — create + cost", () => {
	let db: Database;
	let app: ReturnType<typeof createThreadsRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
		app = createThreadsRoutes(db, OPERATOR);
	});

	afterEach(() => {
		db.close();
	});

	describe("POST /", () => {
		it("creates a web thread with no body (defaults)", async () => {
			const res = await postCreate(app);
			expect(res.status).toBe(201);
			const thread = (await res.json()) as { id: string; interface: string; user_id: string };
			expect(thread.id).toBeDefined();
			expect(thread.interface).toBe("web");
			expect(thread.user_id).toBe(OPERATOR);
		});

		it("accepts a valid interface tag from the body", async () => {
			const res = await postCreate(app, { interface: "boundless" });
			expect(res.status).toBe(201);
			expect((await res.json()).interface).toBe("boundless");
		});

		it("ignores a non-string interface value and falls back to web", async () => {
			const res = await postCreate(app, { interface: 42 });
			expect(res.status).toBe(201);
			expect((await res.json()).interface).toBe("web");
		});

		it("400s an interface tag with invalid characters", async () => {
			const res = await postCreate(app, { interface: "bad/slash" });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Invalid interface value");
		});

		it("400s an interface tag longer than 32 chars", async () => {
			const res = await postCreate(app, { interface: "a".repeat(33) });
			expect(res.status).toBe(400);
		});

		it("tolerates a non-JSON body and uses defaults", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not json",
			});
			expect(res.status).toBe(201);
			expect((await res.json()).interface).toBe("web");
		});

		it("cycles the color from the last user-facing thread", async () => {
			// Seed a user-facing thread at color 4; the next create picks 5.
			seedThread(db, "prior", 4, "web");
			const res = await postCreate(app);
			expect(res.status).toBe(201);
			expect((await res.json()).color).toBe(5);
		});

		it("500s when the create path throws", async () => {
			db.close();
			const res = await postCreate(app);
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to create thread");
		});
	});

	describe("GET /:id/cost", () => {
		it("returns 0 for a thread with no turns", async () => {
			seedThread(db, "t1");
			const res = await app.request("/t1/cost");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ cost_usd: 0 });
		});

		it("sums turn cost for the thread", async () => {
			seedThread(db, "t1");
			const now = "2026-07-04T00:00:00.000Z";
			for (const [id, cost] of [
				["turn-1", 0.25],
				["turn-2", 0.5],
			] as const) {
				insertRow(
					db,
					"turns",
					{
						id,
						thread_id: "t1",
						task_id: null,
						dag_root_id: null,
						model_id: "opus",
						tokens_in: 10,
						tokens_out: 5,
						cost_usd: cost,
						created_at: now,
						relay_target: null,
						relay_latency_ms: null,
						tokens_cache_write: null,
						tokens_cache_read: null,
						context_debug: null,
						status: null,
						host_origin: SITE,
						modified_at: now,
						deleted: 0,
					},
					SITE,
				);
			}
			const res = await app.request("/t1/cost");
			expect(res.status).toBe(200);
			expect((await res.json()).cost_usd).toBeCloseTo(0.75, 5);
		});

		it("404s an unknown thread", async () => {
			const res = await app.request("/nope/cost");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Thread not found");
		});

		it("500s when the lookup throws", async () => {
			db.close();
			const res = await app.request("/any/cost");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to get thread cost");
		});
	});

	describe("GET /:id (with attached session hosts)", () => {
		it("returns the thread with an attachedSessionHosts array", async () => {
			seedThread(db, "t1");
			const res = await app.request("/t1");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { id: string; attachedSessionHosts: string[] };
			expect(body.id).toBe("t1");
			expect(Array.isArray(body.attachedSessionHosts)).toBe(true);
		});

		it("returns the thread owner's display name for user-message labels (#258)", async () => {
			seedThread(db, "t1");
			const now = "2026-07-04T00:00:00.000Z";
			insertRow(
				db,
				"users",
				{
					id: OPERATOR,
					display_name: "Kara",
					platform_ids: null,
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
				SITE,
			);
			const body = (await (await app.request("/t1")).json()) as { userDisplayName: string | null };
			expect(body.userDisplayName).toBe("Kara");
		});

		it("returns a null display name when the owner has no users row", async () => {
			seedThread(db, "t1");
			const body = (await (await app.request("/t1")).json()) as { userDisplayName: string | null };
			expect(body.userDisplayName).toBeNull();
		});
	});

	describe("GET /:id/status forwarded-status branches", () => {
		it("reports forwarded thinking status as active", async () => {
			seedThread(db, "t1");
			const cache = new Map<string, { status: string; detail: string | null; tokens: number }>();
			cache.set("t1", { status: "thinking", detail: "pondering", tokens: 42 });
			const statusApp = createThreadsRoutes(db, OPERATOR, "opus-4.8", cache as never);
			const res = await statusApp.request("/t1/status");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				active: boolean;
				state: string;
				detail: string;
				tokens: number;
				model: string;
			};
			expect(body.active).toBe(true);
			expect(body.state).toBe("thinking");
			expect(body.detail).toBe("pondering");
			expect(body.tokens).toBe(42);
			expect(body.model).toBe("opus-4.8");
		});

		it("reports a local active loop as thinking", async () => {
			seedThread(db, "t1");
			const activeLoops = new Set<string>(["t1"]);
			const statusApp = createThreadsRoutes(db, OPERATOR, undefined, undefined, activeLoops);
			const res = await statusApp.request("/t1/status");
			const body = (await res.json()) as { active: boolean; state: string | null };
			expect(body.active).toBe(true);
			expect(body.state).toBe("thinking");
		});

		it("reports an idle thread as inactive with null state", async () => {
			seedThread(db, "t1");
			const res = await app.request("/t1/status");
			const body = (await res.json()) as { active: boolean; state: string | null };
			expect(body.active).toBe(false);
			expect(body.state).toBeNull();
		});

		it("404s an unknown thread", async () => {
			const res = await app.request("/nope/status");
			expect(res.status).toBe(404);
		});

		it("500s when the lookup throws", async () => {
			db.close();
			const res = await app.request("/any/status");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to get thread status");
		});
	});

	describe("GET /:id/context-debug", () => {
		it("skips turns with malformed context_debug JSON", async () => {
			seedThread(db, "t1");
			const now = "2026-07-04T00:00:00.000Z";
			function turn(id: string, ctx: string | null): void {
				insertRow(
					db,
					"turns",
					{
						id,
						thread_id: "t1",
						task_id: null,
						dag_root_id: null,
						model_id: "opus",
						tokens_in: 10,
						tokens_out: 5,
						cost_usd: null,
						created_at: now,
						relay_target: null,
						relay_latency_ms: null,
						tokens_cache_write: null,
						tokens_cache_read: null,
						context_debug: ctx,
						status: null,
						host_origin: SITE,
						modified_at: now,
						deleted: 0,
					},
					SITE,
				);
			}
			turn("good", JSON.stringify({ stage: "assemble" }));
			turn("bad", "{not json");
			const res = await app.request("/t1/context-debug");
			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<{ turn_id: string }>;
			// Only the valid turn survives; the malformed one is filtered out.
			expect(body.map((r) => r.turn_id)).toEqual(["good"]);
		});

		it("500s when the query throws", async () => {
			db.close();
			const res = await app.request("/any/context-debug");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to get context debug data");
		});
	});
});
