import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createWebApp } from "../index";

let db: Database;
let app: Awaited<ReturnType<typeof createWebApp>>;
const siteId = "test-site";

beforeEach(async () => {
	db = new BunDatabase(":memory:");
	applySchema(db);
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
	app = await createWebApp(db, new TypedEventEmitter(), { operatorUserId: "test-operator" });
});

function seedConnectorBinding(overrides: Partial<{ id: string; deleted: number }> = {}): void {
	const now = "2026-07-04T00:00:00.000Z";
	const threadId = `thread-${overrides.id ?? "discord-handle"}`;
	const taskId = `task-${overrides.id ?? "discord-handle"}`;
	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: "system",
			interface: "platform",
			host_origin: siteId,
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
		siteId,
	);
	insertRow(
		db,
		"tasks",
		{
			id: taskId,
			type: "event",
			status: "pending",
			trigger_spec: `connector:event:${overrides.id ?? "discord-handle"}`,
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
			model_hint: null,
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
		siteId,
	);
	insertRow(
		db,
		"connector_handles",
		{
			id: overrides.id ?? "discord-handle",
			server_name: "discord",
			event_name: "message.received",
			event_args: JSON.stringify({ channel_id: "123", guild_id: "456" }),
			delivery_mode: "push",
			cursor: null,
			task_id: taskId,
			created_at: now,
			modified_at: now,
			deleted: overrides.deleted ?? 0,
		},
		siteId,
	);
}

describe("connector bindings routes", () => {
	it("lists active connector bindings with parsed args and task status", async () => {
		seedConnectorBinding({ id: "active-handle" });
		seedConnectorBinding({ id: "deleted-handle", deleted: 1 });

		const response = await app.fetch(new Request("http://localhost/api/connectors/bindings"));

		expect(response.status).toBe(200);
		const json = (await response.json()) as { bindings: Array<Record<string, unknown>> };
		expect(json.bindings).toHaveLength(1);
		expect(json.bindings[0]).toMatchObject({
			id: "active-handle",
			server_name: "discord",
			event_name: "message.received",
			delivery_mode: "push",
			task_status: "pending",
			thread_title: "discord:message.received",
		});
		expect(json.bindings[0].event_args).toEqual({ channel_id: "123", guild_id: "456" });
	});

	it("detaches a connector binding and its backing task", async () => {
		seedConnectorBinding({ id: "detach-me" });

		const response = await app.fetch(
			new Request("http://localhost/api/connectors/bindings/detach-me", { method: "DELETE" }),
		);

		expect(response.status).toBe(204);
		expect(db.query("SELECT deleted FROM connector_handles WHERE id = ?").get("detach-me")).toEqual(
			{ deleted: 1 },
		);
		expect(db.query("SELECT deleted FROM tasks WHERE id = ?").get("task-detach-me")).toEqual({
			deleted: 1,
		});
	});
});
