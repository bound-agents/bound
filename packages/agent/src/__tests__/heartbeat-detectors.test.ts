import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase, insertRow } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { buildDetectorSection } from "../heartbeat-detectors";

describe("buildDetectorSection", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `detectors-${randomBytes(4).toString("hex")}-`));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM turns");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM threads");
		db.run("DELETE FROM semantic_memory");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	it("returns null when nothing is anomalous", () => {
		expect(buildDetectorSection(db)).toBeNull();
	});

	// ─── A. Long-running tasks ────────────────────────────────────

	it("detects tasks running longer than 15 minutes", () => {
		const oldClaim = new Date(Date.now() - 20 * 60 * 1000).toISOString();
		const recentClaim = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const threadId = randomUUID();

		insertRow(db, "threads", {
			id: threadId, user_id: "u", interface: "web", host_origin: siteId,
			color: 0, title: "t", created_at: oldClaim, last_message_at: oldClaim,
			modified_at: oldClaim, deleted: 0,
		}, siteId);

		insertRow(db, "tasks", {
			id: randomUUID(), type: "cron", status: "running",
			trigger_spec: JSON.stringify({ type: "cron", cron: "0 * * * *" }),
			payload: "run something", thread_id: threadId,
			created_at: oldClaim, last_run_at: oldClaim, modified_at: oldClaim,
			deleted: 0, claimed_by: siteId, claimed_at: oldClaim,
			lease_id: randomUUID(), run_count: 0, consecutive_failures: 0,
			heartbeat_at: null, next_run_at: null, no_history: 0,
		}, siteId);

		insertRow(db, "tasks", {
			id: randomUUID(), type: "cron", status: "running",
			trigger_spec: JSON.stringify({ type: "cron", cron: "0 * * * *" }),
			payload: "recent task", thread_id: threadId,
			created_at: recentClaim, last_run_at: recentClaim, modified_at: recentClaim,
			deleted: 0, claimed_by: siteId, claimed_at: recentClaim,
			lease_id: randomUUID(), run_count: 0, consecutive_failures: 0,
			heartbeat_at: null, next_run_at: null, no_history: 0,
		}, siteId);

		const result = buildDetectorSection(db);
		expect(result).not.toBeNull();
		expect(result).toContain("Long-running tasks");
		expect(result).toContain("20min");
		expect(result).not.toContain("5min");
	});

	// ─── B. Cost spikes ──────────────────────────────────────────

	it("detects cost spikes in the turns table", () => {
		const now = new Date().toISOString();
		const taskId = randomUUID();

		// Insert 25 turns with high token counts
		for (let i = 0; i < 25; i++) {
			insertRow(db, "turns", {
				id: randomUUID(), thread_id: randomUUID(), task_id: taskId,
				model_id: "test", tokens_in: 25000, tokens_out: 5000,
				cost_usd: 0.01, created_at: now,
				deleted: 0, host_origin: siteId,
			}, siteId);
		}

		const result = buildDetectorSection(db);
		expect(result).not.toBeNull();
		expect(result).toContain("Cost spikes");
		expect(result).toContain(taskId);
	});

	it("excludes self-taskId from cost spike detection", () => {
		const now = new Date().toISOString();
		const selfTaskId = randomUUID();

		for (let i = 0; i < 25; i++) {
			insertRow(db, "turns", {
				id: randomUUID(), thread_id: randomUUID(), task_id: selfTaskId,
				model_id: "test", tokens_in: 25000, tokens_out: 5000,
				cost_usd: 0.01, created_at: now,
				deleted: 0, host_origin: siteId,
			}, siteId);
		}

		expect(buildDetectorSection(db, selfTaskId)).toBeNull();
	});

	// ─── C. Unsurfaced completions ───────────────────────────────

	it("detects completed tasks not surfaced in the grace window", () => {
		const completedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		const threadId = randomUUID();

		insertRow(db, "tasks", {
			id: randomUUID(), type: "deferred", status: "completed",
			trigger_spec: JSON.stringify({ type: "deferred", delay: "5m" }),
			payload: "do a thing", thread_id: threadId,
			created_at: completedAt, last_run_at: completedAt, modified_at: completedAt,
			deleted: 0, claimed_by: null, claimed_at: null, lease_id: null,
			run_count: 1, consecutive_failures: 0, result: "done",
			heartbeat_at: null, next_run_at: null, no_history: 0,
		}, siteId);

		const result = buildDetectorSection(db);
		expect(result).not.toBeNull();
		expect(result).toContain("Unsurfaced completions");
	});

	// ─── E. Unanswered user threads ──────────────────────────────

	it("detects user messages with no assistant reply", () => {
		const threadId = randomUUID();
		const userMsgTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

		insertRow(db, "threads", {
			id: threadId, user_id: "u", interface: "web", host_origin: siteId,
			color: 0, title: "test", created_at: userMsgTime, last_message_at: userMsgTime,
			modified_at: userMsgTime, deleted: 0,
		}, siteId);

		insertRow(db, "messages", {
			id: randomUUID(), thread_id: threadId, role: "user",
			content: "hello?", model_id: null, tool_name: null,
			created_at: userMsgTime, modified_at: null, host_origin: siteId,
			deleted: 0, exit_code: null, metadata: null,
		}, siteId);

		const result = buildDetectorSection(db);
		expect(result).not.toBeNull();
		expect(result).toContain("Unanswered user threads");
		expect(result).toContain(threadId);
	});

	it("does not flag mid-turn threads as unanswered", () => {
		const threadId = randomUUID();
		const userMsgTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		const toolCallTime = new Date(Date.now() - 29 * 60 * 1000).toISOString();

		insertRow(db, "threads", {
			id: threadId, user_id: "u", interface: "web", host_origin: siteId,
			color: 0, title: "coding", created_at: userMsgTime, last_message_at: toolCallTime,
			modified_at: toolCallTime, deleted: 0,
		}, siteId);

		insertRow(db, "messages", {
			id: randomUUID(), thread_id: threadId, role: "user",
			content: "fix this", model_id: null, tool_name: null,
			created_at: userMsgTime, modified_at: null, host_origin: siteId,
			deleted: 0, exit_code: null, metadata: null,
		}, siteId);

		// Tool call after the user message = mid-turn
		insertRow(db, "messages", {
			id: randomUUID(), thread_id: threadId, role: "tool_call",
			content: "boundless_read", model_id: null, tool_name: "boundless_read",
			created_at: toolCallTime, modified_at: null, host_origin: siteId,
			deleted: 0, exit_code: null, metadata: null,
		}, siteId);

		// Should NOT flag this thread — mid-turn false positive
		const result = buildDetectorSection(db);
		// Other detectors might fire, but "Unanswered" should not be present
		if (result) {
			expect(result).not.toContain("Unanswered user threads");
		}
	});

	// ─── Memory pressure ────────────────────────────────────────

	it("detects memory pressure when total exceeds threshold", () => {
		const now = new Date().toISOString();
		// Insert 501 default-tier entries
		for (let i = 0; i < 501; i++) {
			insertRow(db, "semantic_memory", {
				id: randomUUID(), key: `test:${i}`, value: "x",
				source: "test", created_at: now, modified_at: now,
				last_accessed_at: now, deleted: 0, tier: "default",
			}, siteId);
		}

		const result = buildDetectorSection(db);
		expect(result).not.toBeNull();
		expect(result).toContain("Memory pressure");
	});

	it("does not flag memory pressure when under threshold", () => {
		const now = new Date().toISOString();
		for (let i = 0; i < 10; i++) {
			insertRow(db, "semantic_memory", {
				id: randomUUID(), key: `test:${i}`, value: "x",
				source: "test", created_at: now, modified_at: now,
				last_accessed_at: now, deleted: 0, tier: "default",
			}, siteId);
		}

		// Should not have memory pressure (but might have other findings on empty db)
		const result = buildDetectorSection(db);
		if (result) {
			expect(result).not.toContain("Memory pressure");
		}
	});
});
