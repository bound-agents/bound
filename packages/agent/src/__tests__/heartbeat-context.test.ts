/**
 * Heartbeat context builder tests.
 *
 * Verifies that buildHeartbeatContext queries all data sources correctly
 * and formats them into a usable prompt for the heartbeat task.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { buildHeartbeatContext } from "../heartbeat-context";

describe("buildHeartbeatContext", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `heartbeat-ctx-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		// Clean up synced tables
		db.run("DELETE FROM semantic_memory");
		db.run("DELETE FROM advisories");
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM threads");
		db.run("DELETE FROM messages");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	// AC2.1: Standing instructions loaded from _heartbeat_instructions memory key
	it("loads standing instructions from semantic_memory key", () => {
		const customInstructions = "Check disk space and report.";
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: "_heartbeat_instructions",
				value: customInstructions,
				source: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		const context = buildHeartbeatContext(db, null);
		expect(context).toContain("## Standing Instructions");
		expect(context).toContain(customInstructions);
	});

	// AC2.2: Default prompt used when _heartbeat_instructions key is missing
	it("uses default instructions when key is missing", () => {
		const context = buildHeartbeatContext(db, null);
		expect(context).toContain("## Standing Instructions");
		expect(context).toContain("Review system state");
	});

	// AC2.3: Pending advisory titles listed in context
	it("lists pending advisories in context", () => {
		insertRow(
			db,
			"advisories",
			{
				id: randomUUID(),
				type: "general",
				status: "proposed",
				title: "High CPU Usage",
				detail: "CPU is at 90%",
				action: null,
				impact: null,
				evidence: null,
				proposed_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				created_by: siteId,
				defer_until: null,
				resolved_at: null,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"advisories",
			{
				id: randomUUID(),
				type: "general",
				status: "proposed",
				title: "Low Disk Space",
				detail: "Disk is 95% full",
				action: null,
				impact: null,
				evidence: null,
				proposed_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				created_by: siteId,
				defer_until: null,
				resolved_at: null,
				deleted: 0,
			},
			siteId,
		);

		const context = buildHeartbeatContext(db, null);
		expect(context).toContain("Pending (2):");
		expect(context).toContain("High CPU Usage");
		expect(context).toContain("Low Disk Space");
	});

	// AC2.4: Advisory status changes since last run shown (approved/dismissed/applied)
	it("shows advisory status changes since last run", () => {
		const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
		const now = new Date().toISOString();

		insertRow(
			db,
			"advisories",
			{
				id: randomUUID(),
				type: "general",
				status: "approved",
				title: "Issue Fixed",
				detail: "The issue has been resolved",
				action: null,
				impact: null,
				evidence: null,
				proposed_at: lastRunAt,
				modified_at: now,
				created_by: siteId,
				defer_until: null,
				resolved_at: now,
				deleted: 0,
			},
			siteId,
		);

		const context = buildHeartbeatContext(db, lastRunAt);
		expect(context).toContain("Since last check:");
		expect(context).toContain("Issue Fixed");
		expect(context).toContain("approved");
	});

	// AC2.5: Recent task completions with status and error snippets included
	it("includes recent task completions with status and error snippets", () => {
		const lastRunAt = new Date(Date.now() - 3600_000).toISOString();
		const completedAt = new Date().toISOString();

		insertRow(
			db,
			"tasks",
			{
				id: randomUUID(),
				type: "deferred",
				status: "completed",
				trigger_spec: JSON.stringify({ type: "once", at: completedAt }),
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: completedAt,
				run_count: 1,
				max_runs: 1,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: null,
				depends_on: null,
				require_success: 0,
				alert_threshold: null,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: completedAt,
				created_by: siteId,
				modified_at: completedAt,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"tasks",
			{
				id: randomUUID(),
				type: "deferred",
				status: "failed",
				trigger_spec: JSON.stringify({ type: "daily", at: "10:00" }),
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: completedAt,
				run_count: 3,
				max_runs: 3,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: null,
				depends_on: null,
				require_success: 0,
				alert_threshold: null,
				consecutive_failures: 3,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: "Connection timeout after 30 seconds",
				created_at: completedAt,
				created_by: siteId,
				modified_at: completedAt,
				deleted: 0,
			},
			siteId,
		);

		const context = buildHeartbeatContext(db, lastRunAt);
		expect(context).toContain("## Recent Tasks");
		expect(context).toContain("[completed]");
		expect(context).toContain("[failed]");
		expect(context).toContain("Connection timeout after 30 seconds");
	});

	// AC2.6: Per-thread activity counts since last run included
	it("includes per-thread activity counts since last run", () => {
		const lastRunAt = new Date(Date.now() - 3600_000).toISOString();
		const now = new Date().toISOString();

		const threadId = randomUUID();
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: randomUUID(),
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Debug Session",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: lastRunAt,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		// Insert 3 messages after lastRunAt
		for (let i = 0; i < 3; i++) {
			insertRow(
				db,
				"messages",
				{
					id: randomUUID(),
					thread_id: threadId,
					role: i === 0 ? "user" : "assistant",
					content: `Message ${i}`,
					model_id: null,
					tool_name: null,
					created_at: new Date(Date.now() - 1000 * (3 - i)).toISOString(),
					modified_at: new Date(Date.now() - 1000 * (3 - i)).toISOString(),
					host_origin: "local",
					deleted: 0,
				},
				siteId,
			);
		}

		const context = buildHeartbeatContext(db, lastRunAt);
		expect(context).toContain("## Thread Activity");
		expect(context).toContain("Debug Session");
		expect(context).toContain("3 new message(s)");
	});

	// AC2.7: Edge case - gracefully handle zero advisories/tasks/threads
	it("gracefully handles empty database state", () => {
		const context = buildHeartbeatContext(db, new Date().toISOString());
		expect(context).toContain("Pending (0): None");
		expect(context).toContain("No recent task completions.");
		expect(context).toContain("No thread activity since last check.");
	});

	// Additional: Soft-deleted advisory not included in pending count
	it("excludes soft-deleted advisories from pending count", () => {
		insertRow(
			db,
			"advisories",
			{
				id: randomUUID(),
				type: "general",
				status: "proposed",
				title: "Active Advisory",
				detail: "This is active",
				action: null,
				impact: null,
				evidence: null,
				proposed_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				created_by: siteId,
				defer_until: null,
				resolved_at: null,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"advisories",
			{
				id: randomUUID(),
				type: "general",
				status: "proposed",
				title: "Deleted Advisory",
				detail: "This is deleted",
				action: null,
				impact: null,
				evidence: null,
				proposed_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				created_by: siteId,
				defer_until: null,
				resolved_at: null,
				deleted: 1,
			},
			siteId,
		);

		const context = buildHeartbeatContext(db, null);
		expect(context).toContain("Pending (1):");
		expect(context).toContain("Active Advisory");
		expect(context).not.toContain("Deleted Advisory");
	});

	// Additional: Error snippet truncation
	it("truncates long error messages to 150 characters", () => {
		const lastRunAt = new Date(Date.now() - 3600_000).toISOString();
		const now = new Date().toISOString();
		const longError = "A".repeat(200); // 200 chars

		insertRow(
			db,
			"tasks",
			{
				id: randomUUID(),
				type: "deferred",
				status: "failed",
				trigger_spec: JSON.stringify({ type: "manual" }),
				payload: null,
				thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: now,
				run_count: 1,
				max_runs: 1,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: null,
				depends_on: null,
				require_success: 0,
				alert_threshold: null,
				consecutive_failures: 1,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: longError,
				created_at: now,
				created_by: siteId,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const context = buildHeartbeatContext(db, lastRunAt);
		const errorInContext = context.match(/Error: (.+?)(?:\n|-|$)/)?.[1] ?? "";
		expect(errorInContext.length).toBeLessThanOrEqual(150);
	});

	// Additional: Thread activity cap at 10
	it("caps thread activity display at 10 threads", () => {
		const lastRunAt = new Date(Date.now() - 3600_000).toISOString();

		// Insert 15 threads with recent messages
		for (let i = 0; i < 15; i++) {
			const threadId = randomUUID();
			const msgTime = new Date(Date.now() - 1000 * (15 - i)).toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: randomUUID(),
					interface: "web",
					host_origin: "local",
					color: 0,
					title: `Thread ${i}`,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: lastRunAt,
					last_message_at: msgTime,
					modified_at: msgTime,
					deleted: 0,
				},
				siteId,
			);

			insertRow(
				db,
				"messages",
				{
					id: randomUUID(),
					thread_id: threadId,
					role: "user",
					content: "Message",
					model_id: null,
					tool_name: null,
					created_at: msgTime,
					modified_at: msgTime,
					host_origin: "local",
					deleted: 0,
				},
				siteId,
			);
		}

		const context = buildHeartbeatContext(db, lastRunAt);
		const threadMatches = context.match(/- Thread \d+:/g);
		expect(threadMatches?.length ?? 0).toBeLessThanOrEqual(10);
	});

	// Additional: First run (null lastRunAt) shows appropriate messages
	it("shows first run messages when lastRunAt is null", () => {
		const context = buildHeartbeatContext(db, null);
		expect(context).toContain("First heartbeat run - no previous check to compare against.");
	});
});
