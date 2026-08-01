import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { createConnectorsRoutes } from "../connectors";

/**
 * PATCH /bindings/:id — model updates (#76 follow-on).
 *
 * `connector_handles` has no model column: the model that runs a delivery lives
 * on the backing event task and is mirrored onto its delivery thread, matching
 * webhook and RSS PATCH semantics. These tests pin that chain.
 */
describe("connectors routes — PATCH /bindings/:id", () => {
	let db: Database;
	let app: ReturnType<typeof createConnectorsRoutes>;
	const siteId = "test-site";

	function seedThread(id: string): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id,
				user_id: "system",
				interface: "platform",
				host_origin: siteId,
				color: 0,
				title: "discord:message",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
				model_hint: null,
				agent_id: null,
				parent_thread_id: null,
			},
			siteId,
		);
	}

	function seedTask(id: string, threadId: string | null): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"tasks",
			{
				id,
				type: "event",
				status: "pending",
				trigger_spec: "connector:event:handle-1",
				payload: null,
				created_at: now,
				created_by: siteId,
				thread_id: threadId,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}

	/** Seed the full handle → task → thread consist an `attach` would create. */
	function seedBinding(
		handleId = "handle-1",
		opts: { taskId?: string | null; threadId?: string | null } = {},
	): string {
		const now = new Date().toISOString();
		const taskId = opts.taskId === undefined ? "task-1" : opts.taskId;
		const threadId = opts.threadId === undefined ? "thread-1" : opts.threadId;

		if (threadId) seedThread(threadId);
		if (taskId) seedTask(taskId, threadId);

		insertRow(
			db,
			"connector_handles",
			{
				id: handleId,
				server_name: "discord",
				event_name: "message",
				event_args: JSON.stringify({ channel_id: "123" }),
				delivery_mode: "wake",
				cursor: null,
				task_id: taskId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		return handleId;
	}

	function patch(id: string, body: unknown): Promise<Response> {
		return app.request(`/bindings/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function modelOf(table: "tasks" | "threads", id: string): string | null {
		const row = db.query(`SELECT model_hint FROM ${table} WHERE id = ?`).get(id) as {
			model_hint: string | null;
		} | null;
		return row?.model_hint ?? null;
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		insertRow(
			db,
			"cluster_config",
			{ key: "site_id", value: siteId, modified_at: new Date().toISOString(), deleted: 0 },
			siteId,
		);
		app = createConnectorsRoutes(db);
	});

	afterEach(() => {
		db.close();
	});

	it("sets the model on the backing task and mirrors it onto the delivery thread", async () => {
		const id = seedBinding();

		const res = await patch(id, { model_hint: "opus" });

		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; model_hint: string | null };
		expect(body.id).toBe(id);
		expect(body.model_hint).toBe("opus");
		expect(modelOf("tasks", "task-1")).toBe("opus");
		expect(modelOf("threads", "thread-1")).toBe("opus");
	});

	// Three-state contract, shared with webhook/RSS PATCH: "" and null both mean
	// "back to the cluster default", which is stored as NULL.
	it("clears the model back to the cluster default on empty string", async () => {
		const id = seedBinding();
		await patch(id, { model_hint: "opus" });

		const res = await patch(id, { model_hint: "" });

		expect(res.status).toBe(200);
		expect(modelOf("tasks", "task-1")).toBeNull();
		expect(modelOf("threads", "thread-1")).toBeNull();
	});

	it("clears the model on explicit null", async () => {
		const id = seedBinding();
		await patch(id, { model_hint: "opus" });

		const res = await patch(id, { model_hint: null });

		expect(res.status).toBe(200);
		expect(modelOf("tasks", "task-1")).toBeNull();
	});

	it("returns the updated binding with its parsed event args", async () => {
		const id = seedBinding();

		const res = await patch(id, { model_hint: "sonnet" });

		const body = (await res.json()) as {
			event_args: { channel_id: string };
			event_args_raw: string;
			server_name: string;
			event_name: string;
		};
		expect(body.event_args).toEqual({ channel_id: "123" });
		expect(body.event_args_raw).toBe(JSON.stringify({ channel_id: "123" }));
		expect(body.server_name).toBe("discord");
		expect(body.event_name).toBe("message");
	});

	it("404s on an unknown binding", async () => {
		const res = await patch("nope", { model_hint: "opus" });
		expect(res.status).toBe(404);
	});

	it("404s on a soft-deleted binding", async () => {
		const id = seedBinding();
		db.run("UPDATE connector_handles SET deleted = 1 WHERE id = ?", [id]);

		const res = await patch(id, { model_hint: "opus" });

		expect(res.status).toBe(404);
	});

	// An empty body is a caller mistake, not a no-op: without model_hint there is
	// nothing to write, and silently returning 200 would look like it worked.
	it("400s when no updatable field is provided", async () => {
		const id = seedBinding();
		const res = await patch(id, {});
		expect(res.status).toBe(400);
	});

	it("400s on a non-string, non-null model_hint", async () => {
		const id = seedBinding();
		const res = await patch(id, { model_hint: 42 });
		expect(res.status).toBe(400);
		expect(modelOf("tasks", "task-1")).toBeNull();
	});

	// A handle whose task is gone has nowhere to record a model. 409 rather than a
	// silent no-op, so the UI can explain instead of appearing to save.
	it("409s when the handle has no task_id", async () => {
		const id = seedBinding("handle-orphan", { taskId: null, threadId: null });

		const res = await patch(id, { model_hint: "opus" });

		expect(res.status).toBe(409);
	});

	it("409s when the referenced task row is missing", async () => {
		const now = new Date().toISOString();
		insertRow(
			db,
			"connector_handles",
			{
				id: "handle-dangling",
				server_name: "discord",
				event_name: "message",
				event_args: "{}",
				delivery_mode: "wake",
				cursor: null,
				task_id: "task-does-not-exist",
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);

		const res = await patch("handle-dangling", { model_hint: "opus" });

		expect(res.status).toBe(409);
	});

	// A task without a delivery thread is still a legitimate model target.
	it("updates the task even when it has no thread to mirror onto", async () => {
		const id = seedBinding("handle-nothread", { taskId: "task-nothread", threadId: null });

		const res = await patch(id, { model_hint: "haiku" });

		expect(res.status).toBe(200);
		expect(modelOf("tasks", "task-nothread")).toBe("haiku");
	});

	// The model edit must sync — it lands on other hosts via the change log.
	it("routes the update through the change-log outbox", async () => {
		const id = seedBinding();
		const before = db.query("SELECT COUNT(*) AS c FROM change_log").get() as { c: number };

		await patch(id, { model_hint: "opus" });

		const after = db.query("SELECT COUNT(*) AS c FROM change_log").get() as { c: number };
		expect(after.c).toBeGreaterThan(before.c);
	});

	it("surfaces the model on GET /bindings", async () => {
		const id = seedBinding();
		await patch(id, { model_hint: "opus" });

		const res = await app.request("/bindings");
		const body = (await res.json()) as {
			bindings: Array<{ id: string; model_hint: string | null }>;
		};
		expect(body.bindings.find((b) => b.id === id)?.model_hint).toBe("opus");
	});
});
