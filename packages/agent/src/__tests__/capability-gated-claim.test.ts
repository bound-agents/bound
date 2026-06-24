/**
 * Capability-gated claim (chain BEGINNING fix).
 *
 * A host must not claim an inference-bearing task whose model it cannot resolve
 * at claim time. The dead `webhook:bound-v2` handler (task d2ecf42d) was claimed
 * by a backend-less hub whose empty `model_hint` resolved to its configured
 * default `sonnet` — a model it had no local backend for and no live remote to
 * relay to. The claim succeeded, then the run failed with
 * `Unknown model "sonnet". Local backends: []. Model "sonnet" not available on
 * any remote host`, and the failure budget burned until the task was cancelled.
 *
 * The injected `modelValidator` closes over the LOCAL ModelRouter, so calling it
 * at claim time is precisely the per-host self-check this needs: the hub declines,
 * the event task stays pending, and a capable host (or the durable-intake drain)
 * picks it up.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult } from "@bound/agent";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Scheduler } from "../scheduler";

describe("Capability-gated claim", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `capgate-${randomBytes(4).toString("hex")}-`));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();
		db.run("DELETE FROM host_meta");
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);
	});

	afterEach(() => {
		db.run("DELETE FROM tasks");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus,
			hostName: "backendless-hub",
			siteId,
			config: {
				allowlist: {
					default_web_user: "test",
					users: { test: { display_name: "Test" } },
				},
			},
			optionalConfig: {},
		} as unknown as AppContext;
	}

	function makeAgentLoopFactory(): (config: AgentLoopConfig) => {
		run: () => Promise<AgentLoopResult>;
	} {
		return () => ({
			run: async () => ({ messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 }),
		});
	}

	function insertPendingEventTask(triggerSpec: string, modelHint: string | null): string {
		const id = randomUUID();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'event', 'pending', ?, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, ?, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[id, triggerSpec, modelHint, now, now],
		);
		return id;
	}

	function statusOf(taskId: string): string {
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		} | null;
		return row?.status ?? "<missing>";
	}

	it("does not claim a pending event task when the model is unresolvable on this host", () => {
		const triggerSpec = "webhook:capgate";
		const taskId = insertPendingEventTask(triggerSpec, "");

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {
			// Backend-less hub: empty model_hint resolves to default "sonnet", which
			// resolves nowhere. Mirrors the production validator's error shape.
			modelValidator: () => ({
				ok: false as const,
				error:
					'Unknown model "sonnet". Local backends: []. Model "sonnet" not available on any remote host',
				permanent: false,
			}),
		});

		scheduler.onEvent(triggerSpec, null);

		expect(statusOf(taskId)).toBe("pending");
	});

	it("claims a pending event task when the model resolves on this host", () => {
		const triggerSpec = "webhook:capgate";
		const taskId = insertPendingEventTask(triggerSpec, "");

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {
			modelValidator: () => ({ ok: true as const }),
		});

		scheduler.onEvent(triggerSpec, null);

		expect(statusOf(taskId)).toBe("claimed");
	});

	it("claims a pending event task when no model validator is configured (unchanged behavior)", () => {
		const triggerSpec = "webhook:capgate";
		const taskId = insertPendingEventTask(triggerSpec, "");

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {});

		scheduler.onEvent(triggerSpec, null);

		expect(statusOf(taskId)).toBe("claimed");
	});
});
