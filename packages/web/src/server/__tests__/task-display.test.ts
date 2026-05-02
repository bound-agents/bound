import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { Task } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { createWebApp } from "../index";
import { extractDisplayName, extractSchedule } from "../lib/task-display";

describe("Task Display Utilities", () => {
	describe("extractDisplayName", () => {
		it("returns 'heartbeat' for heartbeat tasks", () => {
			const task: Task = {
				id: "task-1",
				type: "heartbeat",
				status: "pending",
				trigger_spec: "0 * * * *",
				payload: null,
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const name = extractDisplayName(task);
			expect(name).toBe("heartbeat");
		});

		it("extracts name from cron task payload", () => {
			const task: Task = {
				id: "task-1",
				type: "cron",
				status: "pending",
				trigger_spec: "0 * * * *",
				payload: JSON.stringify({ name: "research-scan" }),
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const name = extractDisplayName(task);
			expect(name).toBe("research-scan");
		});

		it("extracts description from deferred task payload", () => {
			const task: Task = {
				id: "task-1",
				type: "deferred",
				status: "pending",
				trigger_spec: "",
				payload: JSON.stringify({ description: "Process background job" }),
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const name = extractDisplayName(task);
			expect(name).toBe("Process background job");
		});

		it("returns fallback for malformed payload", () => {
			const task: Task = {
				id: "abc12345-def6-4789",
				type: "cron",
				status: "pending",
				trigger_spec: "0 * * * *",
				payload: "invalid json",
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const name = extractDisplayName(task);
			expect(name).toBe("cron abc12345");
		});

		it("returns fallback for null payload", () => {
			const task: Task = {
				id: "xyz789",
				type: "cron",
				status: "pending",
				trigger_spec: "0 * * * *",
				payload: null,
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const name = extractDisplayName(task);
			expect(name).toBe("cron xyz789");
		});
	});

	describe("extractSchedule", () => {
		it("returns 'one-time' for deferred tasks", () => {
			const task: Task = {
				id: "task-1",
				type: "deferred",
				status: "pending",
				trigger_spec: "",
				payload: null,
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const schedule = extractSchedule(task);
			expect(schedule).toBe("one-time");
		});

		it("returns 'on-event' for event tasks", () => {
			const task: Task = {
				id: "task-1",
				type: "event",
				status: "pending",
				trigger_spec: "",
				payload: null,
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const schedule = extractSchedule(task);
			expect(schedule).toBe("on-event");
		});

		it("converts cron expression to human-readable form", () => {
			const testCases = [
				{ spec: "*/15 * * * *", expected: "every 15m" },
				{ spec: "*/30 * * * *", expected: "every 30m" },
				{ spec: "0 * * * *", expected: "hourly" },
				{ spec: "*/5 * * * *", expected: "every 5m" },
				{ spec: "*/10 * * * *", expected: "every 10m" },
				{ spec: "0 0 * * *", expected: "daily" },
				{ spec: "0 0 1 * *", expected: "monthly" },
				{ spec: "0 0 * * 1", expected: "weekly" },
			];

			for (const { spec, expected } of testCases) {
				const task: Task = {
					id: "task-1",
					type: "cron",
					status: "pending",
					trigger_spec: spec,
					payload: null,
					thread_id: null,
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
					inject_mode: "append",
					depends_on: null,
					require_success: 0,
					alert_threshold: 3,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					created_at: new Date().toISOString(),
					created_by: null,
					modified_at: new Date().toISOString(),
					deleted: 0,
				};

				const schedule = extractSchedule(task);
				expect(schedule).toBe(expected);
			}
		});

		it("converts heartbeat interval_ms to human-readable interval", () => {
			const testCases = [
				{ interval_ms: 60_000, expected: "every 1m" },
				{ interval_ms: 300_000, expected: "every 5m" },
				{ interval_ms: 900_000, expected: "every 15m" },
				{ interval_ms: 1_800_000, expected: "every 30m" },
				{ interval_ms: 3_600_000, expected: "every 1h" },
				{ interval_ms: 10_800_000, expected: "every 3h" },
				{ interval_ms: 86_400_000, expected: "every 24h" },
				{ interval_ms: 5_400_000, expected: "every 1h 30m" },
				{ interval_ms: 7_200_000, expected: "every 2h" },
			];

			for (const { interval_ms, expected } of testCases) {
				const task: Task = {
					id: "task-1",
					type: "heartbeat",
					status: "pending",
					trigger_spec: JSON.stringify({ interval_ms }),
					payload: null,
					thread_id: null,
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
					inject_mode: "append",
					depends_on: null,
					require_success: 0,
					alert_threshold: 3,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					created_at: new Date().toISOString(),
					created_by: null,
					modified_at: new Date().toISOString(),
					deleted: 0,
				};

				const schedule = extractSchedule(task);
				expect(schedule).toBe(expected);
			}
		});

		it("returns unknown cron expression as-is", () => {
			const task: Task = {
				id: "task-1",
				type: "cron",
				status: "pending",
				trigger_spec: "30 2 15 * *",
				payload: null,
				thread_id: null,
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
				inject_mode: "append",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: null,
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			const schedule = extractSchedule(task);
			expect(schedule).toBe("30 2 15 * *");
		});
	});

	describe("Route: GET /api/tasks - enhanced fields", () => {
		let db: Database;
		let eventBus: TypedEventEmitter;

		beforeEach(() => {
			db = createDatabase(":memory:");
			applySchema(db);
			applyMetricsSchema(db);
			eventBus = new TypedEventEmitter();
		});

		it("includes hostName resolved from hosts table", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });

			const hostId = randomUUID();
			const taskId = randomUUID();
			const now = new Date().toISOString();

			db.prepare(
				"INSERT INTO hosts (site_id, host_name, platforms, mcp_tools, models, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(
				hostId,
				"polaris",
				JSON.stringify([]),
				JSON.stringify([]),
				JSON.stringify([]),
				now,
				now,
			);

			db.prepare(
				"INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, origin_thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(
				taskId,
				"cron",
				"running",
				"0 * * * *",
				null,
				null,
				null,
				hostId,
				now,
				null,
				null,
				null,
				0,
				null,
				null,
				null,
				0,
				"append",
				null,
				0,
				3,
				0,
				0,
				0,
				null,
				null,
				null,
				now,
				null,
				now,
			);

			const response = await app.fetch(new Request("http://localhost:3000/api/tasks"));
			expect(response.status).toBe(200);

			const tasks = (await response.json()) as Array<Record<string, unknown>>;
			expect(tasks.length).toBeGreaterThan(0);

			const task = tasks.find((t) => (t as Record<string, unknown>).id === taskId);
			expect(task).toBeDefined();
			expect((task as Record<string, unknown>).hostName).toBe("polaris");
		});

		it("sets hostName to null when claimed_by is null", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });

			const taskId = randomUUID();
			const now = new Date().toISOString();

			db.prepare(
				"INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, origin_thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(
				taskId,
				"cron",
				"pending",
				"0 * * * *",
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				0,
				null,
				null,
				null,
				0,
				"append",
				null,
				0,
				3,
				0,
				0,
				0,
				null,
				null,
				null,
				now,
				null,
				now,
			);

			const response = await app.fetch(new Request("http://localhost:3000/api/tasks"));
			expect(response.status).toBe(200);

			const tasks = (await response.json()) as Array<Record<string, unknown>>;
			const task = tasks.find((t) => (t as Record<string, unknown>).id === taskId);
			expect(task).toBeDefined();
			expect((task as Record<string, unknown>).hostName).toBeNull();
		});

		it("computes lastDurationMs from claimed_at and last turn", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });

			const taskId = randomUUID();
			const threadId = randomUUID();
			const now = new Date().toISOString();
			const claimedAt = new Date(Date.now() - 5000).toISOString();
			const lastTurnAt = new Date(Date.now()).toISOString();

			db.prepare(
				"INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, origin_thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(
				taskId,
				"cron",
				"completed",
				"0 * * * *",
				null,
				threadId,
				null,
				null,
				claimedAt,
				null,
				null,
				now,
				1,
				null,
				null,
				null,
				0,
				"append",
				null,
				0,
				3,
				0,
				0,
				0,
				null,
				null,
				null,
				now,
				null,
				now,
			);

			db.prepare(
				"INSERT INTO turns (id, thread_id, task_id, model_id, tokens_in, tokens_out, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(randomUUID(), threadId, taskId, "opus", 100, 50, 0.01, lastTurnAt);

			const response = await app.fetch(new Request("http://localhost:3000/api/tasks"));
			expect(response.status).toBe(200);

			const tasks = (await response.json()) as Array<Record<string, unknown>>;
			const task = tasks.find((t) => (t as Record<string, unknown>).id === taskId);
			expect(task).toBeDefined();
			expect((task as Record<string, unknown>).lastDurationMs).toBeGreaterThan(0);
			expect((task as Record<string, unknown>).lastDurationMs).toBeLessThanOrEqual(6000);
		});

		it("sets lastDurationMs to null when claimed_at is null", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });

			const taskId = randomUUID();
			const threadId = randomUUID();
			const now = new Date().toISOString();

			db.prepare(
				"INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, origin_thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(
				taskId,
				"cron",
				"pending",
				"0 * * * *",
				null,
				threadId,
				null,
				null,
				null,
				null,
				null,
				null,
				0,
				null,
				null,
				null,
				0,
				"append",
				null,
				0,
				3,
				0,
				0,
				0,
				null,
				null,
				null,
				now,
				null,
				now,
			);

			const response = await app.fetch(new Request("http://localhost:3000/api/tasks"));
			expect(response.status).toBe(200);

			const tasks = (await response.json()) as Array<Record<string, unknown>>;
			const task = tasks.find((t) => (t as Record<string, unknown>).id === taskId);
			expect(task).toBeDefined();
			expect((task as Record<string, unknown>).lastDurationMs).toBeNull();
		});

		it("sets lastDurationMs to null when no turns exist", async () => {
			const app = await createWebApp(db, eventBus, { operatorUserId: "test-operator" });

			const taskId = randomUUID();
			const threadId = randomUUID();
			const now = new Date().toISOString();
			const claimedAt = new Date(Date.now() - 5000).toISOString();

			db.prepare(
				"INSERT INTO tasks (id, type, status, trigger_spec, payload, thread_id, origin_thread_id, claimed_by, claimed_at, lease_id, next_run_at, last_run_at, run_count, max_runs, requires, model_hint, no_history, inject_mode, depends_on, require_success, alert_threshold, consecutive_failures, event_depth, no_quiescence, heartbeat_at, result, error, created_at, created_by, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(
				taskId,
				"cron",
				"running",
				"0 * * * *",
				null,
				threadId,
				null,
				null,
				claimedAt,
				null,
				null,
				null,
				0,
				null,
				null,
				null,
				0,
				"append",
				null,
				0,
				3,
				0,
				0,
				0,
				null,
				null,
				null,
				now,
				null,
				now,
			);

			const response = await app.fetch(new Request("http://localhost:3000/api/tasks"));
			expect(response.status).toBe(200);

			const tasks = (await response.json()) as Array<Record<string, unknown>>;
			const task = tasks.find((t) => (t as Record<string, unknown>).id === taskId);
			expect(task).toBeDefined();
			expect((task as Record<string, unknown>).lastDurationMs).toBeNull();
		});
	});
});
