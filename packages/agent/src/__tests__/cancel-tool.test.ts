import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { TypedEventEmitter as EventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { createCancelTool } from "../tools/cancel";
import type { ToolContext } from "../types";

describe("cancel tool — heartbeat guard", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `cancel-tool-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
		siteId = randomUUID();
		eventBus = new EventEmitter();
	});

	afterEach(() => {
		db.run("DELETE FROM tasks");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): ToolContext {
		return {
			db,
			siteId,
			eventBus,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		};
	}

	function insertTask(opts: {
		type: "heartbeat" | "cron" | "deferred";
		status?: string;
		payload?: string | null;
	}): string {
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const triggerSpec =
			opts.type === "heartbeat"
				? JSON.stringify({ type: "heartbeat", interval_ms: 1_800_000 })
				: opts.type === "cron"
					? JSON.stringify({ type: "cron", expression: "0 * * * *" })
					: JSON.stringify({ type: "deferred", run_at: now });
		const status = opts.status ?? "pending";
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, ?, ?, ?, ?, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, opts.type, status, triggerSpec, opts.payload ?? null, now, now],
		);
		return taskId;
	}

	// ─── task_id path ───────────────────────────────────────────────────────

	it("refuses to cancel a heartbeat task by task_id", async () => {
		const taskId = insertTask({ type: "heartbeat" });
		const tool = createCancelTool(makeCtx());

		const result = await tool.execute({ task_id: taskId });

		expect(result).toContain("Error");
		expect(result).toContain("heartbeat");

		// Task must still be in its original status
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		};
		expect(row.status).toBe("pending");
	});

	it("still cancels a non-heartbeat task by task_id", async () => {
		const taskId = insertTask({ type: "cron" });
		const tool = createCancelTool(makeCtx());

		const result = await tool.execute({ task_id: taskId });

		expect(result).not.toContain("Error");
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		};
		expect(row.status).toBe("cancelled");
	});

	// ─── payload_match path ─────────────────────────────────────────────────

	it("payload_match never cancels heartbeat tasks", async () => {
		const hbId = insertTask({
			type: "heartbeat",
			payload: "heartbeat:shared-payload",
			status: "pending",
		});
		const tool = createCancelTool(makeCtx());

		// Attempt to match the heartbeat's payload
		const result = await tool.execute({ payload_match: "heartbeat:shared-payload" });

		// The heartbeat row must survive
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(hbId) as {
			status: string;
		};
		expect(row.status).toBe("pending");
		// No tasks matched (the only match was a heartbeat, which is excluded)
		expect(result).toContain("No tasks found");
	});

	it("payload_match cancels non-heartbeat tasks while skipping heartbeat with the same payload", async () => {
		const hbId = insertTask({
			type: "heartbeat",
			payload: "shared-payload",
			status: "pending",
		});
		const cronId = insertTask({
			type: "cron",
			payload: "shared-payload",
			status: "pending",
		});
		const tool = createCancelTool(makeCtx());

		const result = await tool.execute({ payload_match: "shared-payload" });

		expect(result).toContain("Cancelled 1");

		const hbRow = db.query("SELECT status FROM tasks WHERE id = ?").get(hbId) as {
			status: string;
		};
		const cronRow = db.query("SELECT status FROM tasks WHERE id = ?").get(cronId) as {
			status: string;
		};
		expect(hbRow.status).toBe("pending"); // heartbeat untouched
		expect(cronRow.status).toBe("cancelled"); // cron cancelled
	});
});
