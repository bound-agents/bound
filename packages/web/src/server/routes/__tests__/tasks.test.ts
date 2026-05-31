import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
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
