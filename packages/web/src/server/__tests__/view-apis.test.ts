import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase, insertRow, getSiteId } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createApp } from "../index";
import { randomUUID } from "node:crypto";

describe("R-U23/25/26: View APIs", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;
	let siteId: string;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);

		// Initialize site_id in host_meta
		const testSiteId = randomUUID();
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", testSiteId]);
		siteId = getSiteId(db);

		eventBus = new TypedEventEmitter();
		app = await createApp(db, eventBus);
	});

	describe("GET /api/tasks (R-U23: Timetable view)", () => {
		it("returns empty array when no tasks exist", async () => {
			const request = new Request("http://localhost:3000/api/tasks");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(0);
		});

		it("returns task list with required fields", async () => {
			const now = new Date().toISOString();

			// Insert a test task
			insertRow(
				db,
				"tasks",
				{
					id: randomUUID(),
					type: "deferred",
					status: "pending",
					trigger_spec: "in:5m",
					payload: JSON.stringify({ test: "data" }),
					created_at: now,
					created_by: "test-user",
					thread_id: null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
					last_run_at: null,
					run_count: 0,
					max_runs: null,
					requires: null,
					model_hint: null,
					no_history: 0,
					inject_mode: "results",
					depends_on: null,
					require_success: 0,
					alert_threshold: 1,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const request = new Request("http://localhost:3000/api/tasks");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const tasks = await response.json();
			expect(Array.isArray(tasks)).toBe(true);
			expect(tasks.length).toBe(1);

			const task = tasks[0];
			expect(task.id).toBeDefined();
			expect(task.type).toBe("deferred");
			expect(task.status).toBe("pending");
			expect(task.trigger_spec).toBe("in:5m");
			expect(task.next_run_at).toBeDefined();
		});

		it("filters tasks by status query parameter", async () => {
			const now = new Date().toISOString();

			// Insert tasks with different statuses
			insertRow(
				db,
				"tasks",
				{
					id: randomUUID(),
					type: "deferred",
					status: "pending",
					trigger_spec: "in:5m",
					payload: null,
					created_at: now,
					created_by: null,
					thread_id: null,
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
					alert_threshold: 1,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			insertRow(
				db,
				"tasks",
				{
					id: randomUUID(),
					type: "cron",
					status: "completed",
					trigger_spec: "every:0 9 * * *",
					payload: null,
					created_at: now,
					created_by: null,
					thread_id: null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: null,
					last_run_at: now,
					run_count: 1,
					max_runs: null,
					requires: null,
					model_hint: null,
					no_history: 0,
					inject_mode: "results",
					depends_on: null,
					require_success: 0,
					alert_threshold: 1,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: "success",
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const request = new Request("http://localhost:3000/api/tasks?status=pending");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const tasks = await response.json();
			expect(tasks.length).toBe(1);
			expect(tasks[0].status).toBe("pending");
		});
	});

	describe("POST /api/files/upload (R-U25: File upload)", () => {
		it("handles file upload", async () => {
			const formData = new FormData();
			const fileContent = "Hello, world!";
			const blob = new Blob([fileContent], { type: "text/plain" });
			formData.append("file", blob, "test.txt");

			const request = new Request("http://localhost:3000/api/files/upload", {
				method: "POST",
				body: formData,
			});

			const response = await app.fetch(request);

			expect(response.status).toBe(201);
			const file = await response.json();
			expect(file.id).toBeDefined();
			expect(file.path).toContain("test.txt");
			expect(file.content).toBe(fileContent);
			expect(file.size_bytes).toBe(fileContent.length);
		});

		it("returns 400 for missing file field", async () => {
			const formData = new FormData();

			const request = new Request("http://localhost:3000/api/files/upload", {
				method: "POST",
				body: formData,
			});

			const response = await app.fetch(request);

			expect(response.status).toBe(400);
			const error = await response.json();
			expect(error.error).toContain("Invalid request");
		});
	});

	describe("GET /api/status/network (R-U26: Network view)", () => {
		it("returns host and sync data", async () => {
			const now = new Date().toISOString();
			const testSiteId = randomUUID();

			// Insert a test host (hosts table uses site_id as PK, use raw SQL)
			db.run(
				"INSERT INTO hosts (site_id, host_name, version, sync_url, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[testSiteId, "test-host", "0.0.1", "http://test-host:3000/sync", now, now, 0],
			);

			const request = new Request("http://localhost:3000/api/status/network");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.hosts).toBeDefined();
			expect(Array.isArray(data.hosts)).toBe(true);
			expect(data.hosts.length).toBe(1);
			expect(data.hosts[0].host_name).toBe("test-host");
			expect(data.hosts[0].sync_url).toBe("http://test-host:3000/sync");
		});

		it("returns hub configuration if set", async () => {
			const now = new Date().toISOString();

			// Set a hub in cluster_config
			db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
				"hub",
				"hub-site-id",
				now,
			]);

			const request = new Request("http://localhost:3000/api/status/network");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.hub).toBe("hub-site-id");
		});

		it("returns sync state for known peers", async () => {
			// Insert sync state
			db.run(
				"INSERT INTO sync_state (peer_site_id, last_received, last_sent, last_sync_at, sync_errors) VALUES (?, ?, ?, ?, ?)",
				["peer-site-id", 42, 10, new Date().toISOString(), 0],
			);

			const request = new Request("http://localhost:3000/api/status/network");
			const response = await app.fetch(request);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.syncState).toBeDefined();
			expect(Array.isArray(data.syncState)).toBe(true);
			expect(data.syncState.length).toBe(1);
			expect(data.syncState[0].peer_site_id).toBe("peer-site-id");
		});
	});
});
