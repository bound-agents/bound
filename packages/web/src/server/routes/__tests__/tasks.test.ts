import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import { createTasksRoutes } from "../tasks";

describe("tasks routes — PATCH /:id (#100)", () => {
	let db: Database;
	let app: ReturnType<typeof createTasksRoutes>;

	function seedTask(overrides: Record<string, unknown> = {}): string {
		const now = new Date().toISOString();
		const id = `task-${Math.random().toString(16).slice(2, 10)}`;
		insertRow(
			db,
			"tasks",
			{
				id,
				type: "cron",
				status: "pending",
				trigger_spec: JSON.stringify({ type: "cron", expression: "0 * * * *" }),
				payload: null,
				created_at: now,
				created_by: "test-site",
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
				...overrides,
			},
			"test-site",
		);
		return id;
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		app = createTasksRoutes(db);
	});

	afterEach(() => {
		db.close();
	});

	it("toggles no_history true", async () => {
		const id = seedTask();
		const res = await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ no_history: true }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { no_history: number };
		expect(body.no_history).toBe(1);
		const row = db.query("SELECT no_history FROM tasks WHERE id = ?").get(id) as {
			no_history: number;
		};
		expect(row.no_history).toBe(1);
	});

	it("re-enables history with no_history false", async () => {
		const id = seedTask({ no_history: 1 });
		const res = await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ no_history: false }),
		});
		expect(res.status).toBe(200);
		const row = db.query("SELECT no_history FROM tasks WHERE id = ?").get(id) as {
			no_history: number;
		};
		expect(row.no_history).toBe(0);
	});

	it("sets and clears model_hint (empty string clears)", async () => {
		const id = seedTask();
		await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model_hint: "opus" }),
		});
		let row = db.query("SELECT model_hint FROM tasks WHERE id = ?").get(id) as {
			model_hint: string | null;
		};
		expect(row.model_hint).toBe("opus");

		await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model_hint: "" }),
		});
		row = db.query("SELECT model_hint FROM tasks WHERE id = ?").get(id) as {
			model_hint: string | null;
		};
		expect(row.model_hint).toBeNull();
	});

	it("sets alert_threshold", async () => {
		const id = seedTask();
		const res = await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ alert_threshold: 5 }),
		});
		expect(res.status).toBe(200);
		const row = db.query("SELECT alert_threshold FROM tasks WHERE id = ?").get(id) as {
			alert_threshold: number;
		};
		expect(row.alert_threshold).toBe(5);
	});

	it("404s for a missing task", async () => {
		const res = await app.request("/does-not-exist", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ no_history: true }),
		});
		expect(res.status).toBe(404);
	});

	it("400s on a non-boolean no_history", async () => {
		const id = seedTask();
		const res = await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ no_history: "yes" }),
		});
		expect(res.status).toBe(400);
	});

	it("400s on alert_threshold <= 0", async () => {
		const id = seedTask();
		const res = await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ alert_threshold: 0 }),
		});
		expect(res.status).toBe(400);
	});

	it("400s when no updatable field is provided", async () => {
		const id = seedTask();
		const res = await app.request(`/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

describe("tasks routes — GET / list, GET /:id, cancel", () => {
	let db: Database;
	let app: ReturnType<typeof createTasksRoutes>;

	function seedTask(overrides: Record<string, unknown> = {}): string {
		const now = new Date().toISOString();
		const id = (overrides.id as string) ?? `task-${Math.random().toString(16).slice(2, 10)}`;
		insertRow(
			db,
			"tasks",
			{
				id,
				type: "cron",
				status: "pending",
				trigger_spec: JSON.stringify({ type: "cron", expression: "0 * * * *" }),
				payload: null,
				created_at: now,
				created_by: "test-site",
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
				...overrides,
			},
			"test-site",
		);
		return id;
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", "test-site");
		app = createTasksRoutes(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /", () => {
		it("lists active tasks with computed display fields", async () => {
			seedTask({ id: "t1" });
			const res = await app.request("/");
			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<{
				id: string;
				displayName: string;
				schedule: string | null;
				hostName: string | null;
				lastDurationMs: number | null;
			}>;
			expect(body).toHaveLength(1);
			expect(body[0].id).toBe("t1");
			expect(typeof body[0].displayName).toBe("string");
			expect(body[0].schedule).not.toBeNull();
			expect(body[0].hostName).toBeNull();
			expect(body[0].lastDurationMs).toBeNull();
		});

		it("resolves the claiming host's friendly name and computes last duration", async () => {
			const now = "2026-07-04T00:00:00.000Z";
			insertRow(
				db,
				"hosts",
				{
					site_id: "host-abc",
					host_name: "worker-1",
					version: null,
					commit_hash: null,
					sync_url: null,
					mcp_servers: null,
					mcp_tools: null,
					mcp_tool_annotations: null,
					mcp_capabilities: null,
					work_spool_capable: 1,
					models: null,
					online_at: null,
					modified_at: now,
					platforms: null,
					deleted: 0,
				},
				"test-site",
			);
			insertRow(
				db,
				"threads",
				{
					id: "thr-1",
					user_id: "system",
					interface: "web",
					host_origin: "test-site",
					color: 0,
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
				"test-site",
			);
			seedTask({
				id: "claimed-task",
				status: "running",
				claimed_by: "host-abc",
				claimed_at: "2026-07-04T00:00:00.000Z",
				thread_id: "thr-1",
			});
			insertRow(
				db,
				"turns",
				{
					id: "turn-1",
					thread_id: "thr-1",
					task_id: "claimed-task",
					dag_root_id: null,
					model_id: "opus",
					tokens_in: 10,
					tokens_out: 5,
					cost_usd: null,
					created_at: "2026-07-04T00:00:05.000Z",
					relay_target: null,
					relay_latency_ms: null,
					tokens_cache_write: null,
					tokens_cache_read: null,
					context_debug: null,
					status: null,
					host_origin: "test-site",
					modified_at: "2026-07-04T00:00:05.000Z",
					deleted: 0,
				},
				"test-site",
			);
			const body = (await (await app.request("/")).json()) as Array<{
				id: string;
				hostName: string | null;
				lastDurationMs: number | null;
			}>;
			const task = body.find((t) => t.id === "claimed-task");
			expect(task?.hostName).toBe("worker-1");
			expect(task?.lastDurationMs).toBe(5000);
		});

		it("returns 500 when the list query throws", async () => {
			db.close();
			const res = await app.request("/");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list tasks");
		});
	});

	describe("GET /:id", () => {
		it("returns a single enriched task", async () => {
			seedTask({ id: "t1" });
			const res = await app.request("/t1");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { id: string; displayName: string };
			expect(body.id).toBe("t1");
			expect(typeof body.displayName).toBe("string");
		});

		it("404s an unknown task", async () => {
			const res = await app.request("/nope");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Task not found");
		});

		it("returns 500 when the lookup throws", async () => {
			db.close();
			const res = await app.request("/any");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to get task");
		});
	});

	describe("POST /:id/cancel", () => {
		it("cancels a pending task", async () => {
			seedTask({ id: "t1" });
			const res = await app.request("/t1/cancel", { method: "POST" });
			expect(res.status).toBe(200);
			expect((await res.json()).status).toBe("cancelled");
			const row = db.query("SELECT status FROM tasks WHERE id = ?").get("t1") as {
				status: string;
			};
			expect(row.status).toBe("cancelled");
		});

		it("404s an unknown task", async () => {
			const res = await app.request("/nope/cancel", { method: "POST" });
			expect(res.status).toBe(404);
		});

		it("400s a task that is already completed", async () => {
			seedTask({ id: "done", status: "completed" });
			const res = await app.request("/done/cancel", { method: "POST" });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Cannot cancel task in 'completed' status");
		});

		it("returns 500 when the lookup throws", async () => {
			db.close();
			const res = await app.request("/any/cancel", { method: "POST" });
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to cancel task");
		});
	});
});
