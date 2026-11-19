import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { createConnectorsRoutes } from "../connectors";

// createConnectorsRoutes lists/detaches/re-models connector bindings. The
// model lives on the backing event task (and its delivery thread), not the
// handle — so these tests seed the handle→task→thread chain and drive the
// list, delete, and patch handlers across their 200/204/400/404/409/500
// branches, including the raw-JSON-arg fallback for corrupt event_args.

const SITE = "test-site";

function seedChain(
	db: Database,
	opts: {
		id: string;
		taskId?: string | null;
		threadId?: string | null;
		eventArgs?: string;
		modelHint?: string | null;
		deleted?: number;
	},
): void {
	const now = "2026-07-04T00:00:00.000Z";
	const threadId = opts.threadId === undefined ? `thread-${opts.id}` : opts.threadId;
	const taskId = opts.taskId === undefined ? `task-${opts.id}` : opts.taskId;

	if (threadId) {
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "system",
				interface: "platform",
				host_origin: SITE,
				color: 0,
				title: "discord:message.received",
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
	if (taskId) {
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: `connector:event:${opts.id}`,
				payload: null,
				created_at: now,
				created_by: "system",
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
				model_hint: opts.modelHint ?? null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				system_prompt_addition: null,
				modified_at: now,
				deleted: 0,
			},
			SITE,
		);
	}
	insertRow(
		db,
		"connector_handles",
		{
			id: opts.id,
			server_name: "discord",
			event_name: "message.received",
			event_args: opts.eventArgs ?? JSON.stringify({ channel_id: "123" }),
			delivery_mode: "push",
			cursor: null,
			task_id: taskId,
			created_at: now,
			modified_at: now,
			deleted: opts.deleted ?? 0,
		},
		SITE,
	);
}

function patch(app: ReturnType<typeof createConnectorsRoutes>, id: string, body: unknown) {
	return app.request(`/bindings/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("connectors routes", () => {
	let db: Database;
	let app: ReturnType<typeof createConnectorsRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
		app = createConnectorsRoutes(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /bindings", () => {
		it("lists active bindings with parsed event_args and the raw string alongside", async () => {
			seedChain(db, { id: "h1", eventArgs: JSON.stringify({ channel_id: "99" }) });
			seedChain(db, { id: "deleted", deleted: 1 });
			const res = await app.request("/bindings");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				bindings: Array<{ id: string; event_args: unknown; event_args_raw: string }>;
			};
			expect(body.bindings).toHaveLength(1);
			expect(body.bindings[0].id).toBe("h1");
			expect(body.bindings[0].event_args).toEqual({ channel_id: "99" });
			expect(body.bindings[0].event_args_raw).toBe(JSON.stringify({ channel_id: "99" }));
		});

		it("leaves corrupt event_args as the raw string (parse fallback)", async () => {
			seedChain(db, { id: "corrupt", eventArgs: "{not json" });
			const body = (await (await app.request("/bindings")).json()) as {
				bindings: Array<{ event_args: unknown }>;
			};
			expect(body.bindings[0].event_args).toBe("{not json");
		});

		it("returns 500 when the list query throws", async () => {
			db.close();
			const res = await app.request("/bindings");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list connector bindings");
		});
	});

	describe("DELETE /bindings/:id", () => {
		it("soft-deletes the binding and its backing task (204)", async () => {
			seedChain(db, { id: "detach" });
			const res = await app.request("/bindings/detach", { method: "DELETE" });
			expect(res.status).toBe(204);
			const handle = db
				.query("SELECT deleted FROM connector_handles WHERE id = ?")
				.get("detach") as { deleted: number };
			expect(handle.deleted).toBe(1);
			const task = db.query("SELECT deleted FROM tasks WHERE id = ?").get("task-detach") as {
				deleted: number;
			};
			expect(task.deleted).toBe(1);
		});

		it("404s an unknown binding", async () => {
			const res = await app.request("/bindings/nope", { method: "DELETE" });
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Connector binding not found");
		});

		it("deletes a handle with no backing task without erroring", async () => {
			seedChain(db, { id: "orphan", taskId: null, threadId: null });
			const res = await app.request("/bindings/orphan", { method: "DELETE" });
			expect(res.status).toBe(204);
		});
	});

	describe("PATCH /bindings/:id", () => {
		it("sets the model on the backing task and its thread", async () => {
			seedChain(db, { id: "set" });
			const res = await patch(app, "set", { model_hint: "opus-4.8" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { model_hint: string };
			expect(body.model_hint).toBe("opus-4.8");
			const task = db.query("SELECT model_hint FROM tasks WHERE id = ?").get("task-set") as {
				model_hint: string;
			};
			expect(task.model_hint).toBe("opus-4.8");
			const thread = db.query("SELECT model_hint FROM threads WHERE id = ?").get("thread-set") as {
				model_hint: string;
			};
			expect(thread.model_hint).toBe("opus-4.8");
		});

		it("clears the model back to the default when given null", async () => {
			seedChain(db, { id: "clear", modelHint: "glm-5" });
			const res = await patch(app, "clear", { model_hint: null });
			expect(res.status).toBe(200);
			const task = db.query("SELECT model_hint FROM tasks WHERE id = ?").get("task-clear") as {
				model_hint: string | null;
			};
			expect(task.model_hint).toBeNull();
		});

		it("treats an empty-string model_hint as a clear", async () => {
			seedChain(db, { id: "empty", modelHint: "glm-5" });
			const res = await patch(app, "empty", { model_hint: "" });
			expect(res.status).toBe(200);
			const task = db.query("SELECT model_hint FROM tasks WHERE id = ?").get("task-empty") as {
				model_hint: string | null;
			};
			expect(task.model_hint).toBeNull();
		});

		it("404s an unknown binding", async () => {
			const res = await patch(app, "nope", { model_hint: "x" });
			expect(res.status).toBe(404);
		});

		it("400s when no model_hint field is present", async () => {
			seedChain(db, { id: "nofield" });
			const res = await patch(app, "nofield", { other: 1 });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Provide at least one of: model_hint");
		});

		it("400s when model_hint is a non-string, non-null value", async () => {
			seedChain(db, { id: "badtype" });
			const res = await patch(app, "badtype", { model_hint: 42 });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("model_hint must be a string or null");
		});

		it("409s a handle with no backing task id", async () => {
			seedChain(db, { id: "notask", taskId: null, threadId: null });
			const res = await patch(app, "notask", { model_hint: "opus-4.8" });
			expect(res.status).toBe(409);
			expect((await res.json()).error).toContain("no backing event task");
		});

		it("409s a handle whose task row is missing (replay gap)", async () => {
			// Seed only the handle, pointing at a task id that is never inserted —
			// findTaskById returns null and the handler reports the 409.
			seedChain(db, { id: "ghost", taskId: null, threadId: null });
			db.query("UPDATE connector_handles SET task_id = ? WHERE id = ?").run("task-ghost", "ghost");
			const res = await patch(app, "ghost", { model_hint: "opus-4.8" });
			expect(res.status).toBe(409);
		});

		it("500s when the request body is not valid JSON", async () => {
			seedChain(db, { id: "badjson" });
			const res = await app.request("/bindings/badjson", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: "{not json",
			});
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to update connector binding");
		});
	});
});
