import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { Task } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import {
	canRunHere,
	computeNextRunAt,
	isDependencySatisfied,
	seedCronTasks,
} from "../task-resolution";

describe("task-resolution", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "task-resolution-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	describe("computeNextRunAt", () => {
		it("parses simple cron expression", () => {
			const from = new Date("2026-03-22T10:00:00Z");
			const next = computeNextRunAt("0 11 * * *", from);
			expect(next.getHours()).toBe(11);
			expect(next.getMinutes()).toBe(0);
		});

		it("handles specific day/month", () => {
			const from = new Date("2026-03-22T08:00:00Z");
			const next = computeNextRunAt("30 9 22 * *", from);
			// Next 9:30am on the 22nd (same day, future time)
			expect(next.getDate()).toBe(22);
			expect(next.getHours()).toBe(9);
			expect(next.getMinutes()).toBe(30);
		});

		it("handles intervals with /", () => {
			const from = new Date("2026-03-22T10:15:00Z");
			const next = computeNextRunAt("*/30 * * * *", from);
			// Next 30-minute interval should be :30 or :00 of next hour
			expect(next.getMinutes() % 30).toBe(0);
		});

		it("throws on invalid cron expression", () => {
			expect(() => {
				computeNextRunAt("invalid");
			}).toThrow();
		});
	});

	describe("isDependencySatisfied", () => {
		it("returns true when no dependencies", () => {
			const task: Task = {
				id: randomUUID(),
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
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
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: "test",
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			expect(isDependencySatisfied(db, task)).toBe(true);
		});

		it("returns false when dependency not found", () => {
			const missingDepId = randomUUID();
			const task: Task = {
				id: randomUUID(),
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
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
				inject_mode: "status",
				depends_on: JSON.stringify([missingDepId]),
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: new Date().toISOString(),
				created_by: "test",
				modified_at: new Date().toISOString(),
				deleted: 0,
			};

			expect(isDependencySatisfied(db, task)).toBe(false);
		});

		it("returns true when dependency completed", () => {
			const depId = randomUUID();
			const taskId = randomUUID();
			const now = new Date().toISOString();

			// Insert dependency task
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${depId}', 'deferred', 'completed', 'in 10m', NULL, NULL,
					NULL, NULL, NULL, NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, '${now}', 'test', '${now}', 0
				)
			`);

			const task: Task = {
				id: taskId,
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
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
				inject_mode: "status",
				depends_on: JSON.stringify([depId]),
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			};

			expect(isDependencySatisfied(db, task)).toBe(true);
		});
	});

	describe("canRunHere", () => {
		it("returns true for unconstrained task", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			const task: Task = {
				id: taskId,
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
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
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			};

			expect(canRunHere(db, task, "localhost", randomUUID())).toBe(true);
		});

		it("respects host requirements", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			const task: Task = {
				id: taskId,
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: JSON.stringify({ host: "specific-host" }),
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			};

			// Should fail on different host
			expect(canRunHere(db, task, "other-host", randomUUID())).toBe(false);

			// Should succeed on matching host
			expect(canRunHere(db, task, "specific-host", randomUUID())).toBe(true);
		});

		it("supports array of hosts", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			const task: Task = {
				id: taskId,
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: JSON.stringify({ host: ["host-a", "host-b", "host-c"] }),
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			};

			// Should succeed on any host in the array
			expect(canRunHere(db, task, "host-a", randomUUID())).toBe(true);
			expect(canRunHere(db, task, "host-b", randomUUID())).toBe(true);
			expect(canRunHere(db, task, "host-c", randomUUID())).toBe(true);

			// Should fail on host not in array
			expect(canRunHere(db, task, "host-d", randomUUID())).toBe(false);
		});

		it("supports glob patterns", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			const task: Task = {
				id: taskId,
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: JSON.stringify({ host: "prod-*" }),
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			};

			// Should match hosts starting with "prod-"
			expect(canRunHere(db, task, "prod-server1", randomUUID())).toBe(true);
			expect(canRunHere(db, task, "prod-web", randomUUID())).toBe(true);

			// Should not match other hosts
			expect(canRunHere(db, task, "staging-server", randomUUID())).toBe(false);
			expect(canRunHere(db, task, "dev-machine", randomUUID())).toBe(false);
		});

		it("supports site_id requirements", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const expectedSiteId = randomUUID();

			const task: Task = {
				id: taskId,
				type: "deferred",
				status: "pending",
				trigger_spec: null,
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: JSON.stringify({ site_id: expectedSiteId }),
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: "test",
				modified_at: now,
				deleted: 0,
			};

			// Should succeed on matching site_id
			expect(canRunHere(db, task, "any-host", expectedSiteId)).toBe(true);

			// Should fail on different site_id
			expect(canRunHere(db, task, "any-host", randomUUID())).toBe(false);
		});
	});

	describe("seedCronTasks", () => {
		it("creates cron tasks from config", () => {
			const siteId = randomUUID();
			const cronConfigs = [
				{ name: "hourly-task", cron: "0 * * * *" },
				{ name: "daily-task", cron: "0 9 * * *", payload: '{"data":"test"}' },
			];

			seedCronTasks(db, cronConfigs, siteId);

			// Query back the tasks
			const tasks = db
				.query("SELECT id, type, status, trigger_spec FROM tasks ORDER BY created_at")
				.all() as Array<{
				id: string;
				type: string;
				status: string;
				trigger_spec: string;
			}>;

			expect(tasks.length).toBeGreaterThanOrEqual(2);

			const hourlyTask = tasks.find((t) => t.trigger_spec === "0 * * * *");
			expect(hourlyTask).toBeDefined();
			expect(hourlyTask?.type).toBe("cron");
			expect(hourlyTask?.status).toBe("pending");

			const dailyTask = tasks.find((t) => t.trigger_spec === "0 9 * * *");
			expect(dailyTask).toBeDefined();
			expect(dailyTask?.type).toBe("cron");
		});

		it("is idempotent (INSERT OR IGNORE)", () => {
			const siteId = randomUUID();
			const cronConfigs = [{ name: "test-idempotent", cron: "0 * * * *" }];

			seedCronTasks(db, cronConfigs, siteId);
			const countAfterFirst = (db.query("SELECT COUNT(*) as c FROM tasks").get() as { c: number })
				.c;

			seedCronTasks(db, cronConfigs, siteId);
			const countAfterSecond = (db.query("SELECT COUNT(*) as c FROM tasks").get() as { c: number })
				.c;

			expect(countAfterFirst).toBe(countAfterSecond);
		});
	});
});
