/**
 * L3 recency baseline coherence on self-driving threads.
 *
 * `computeBaseline` returns `thread.last_message_at` for stateful
 * (non-noHistory) threads. On webhook-bound or scheduler-spawned threads
 * the agent itself emits a `developer`-role `[Task wakeup]` message into
 * the same thread on every wakeup, so `last_message_at` advances every
 * tick. `loadRecencyEntries` then filters with
 *   `WHERE modified_at > <baseline>`
 * which excludes any memorize that landed *between* wakeups — exactly
 * the entries the L3 recency surface is supposed to expose.
 *
 * Live evidence: thread d0372be6-bd60-452d-958b-249042c884a1 (interface
 * = "webhook") has hundreds of developer-role `[Task wakeup]` messages.
 * On 2026-05-24 at 23:10:26Z the agent had just memorized
 * `bound:issue:51`, `_outcome:bound-release-v0.0.162-…`, and several
 * peers around 04:57-04:59Z (all `tier='default'`, all 18 hours before
 * the wakeup). The agent's own report on that wakeup: "Working knowledge
 * is **months stale** — none of my recent bound_issue or outcome
 * entries." The entries existed; the L3 baseline excluded all of them.
 *
 * This test pins the invariant: **on a thread whose recent message tail
 * is dominated by self-emitted `developer` wakeups, a `tier='default'`
 * memorize that landed between wakeups must surface in the rendered
 * volatile context.** The test does NOT assert *how* the fix achieves
 * this (wallclock floor, baseline = last user message, interface-aware
 * dispatch, etc.) — only that the rendered volatile content surfaces
 * the entry.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { buildVolatileContext } from "../context-assembly";

function createTempDb(dbPath: string): Database {
	const { Database: BunDatabase } = require("bun:sqlite");
	const db = new BunDatabase(dbPath);
	applySchema(db);
	return db;
}

describe("L3 recency baseline on self-driving threads", () => {
	let dbPath: string;
	let configDir: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
	});

	afterEach(async () => {
		await cleanupTmpDir(configDir);
		try {
			unlinkSync(dbPath);
		} catch {}
	});

	it("renders a recently-memorized default-tier entry that landed between two task wakeups", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "webhook-event-handler-thread";
		const siteId = "test-site";

		// Mirror the d0372be6 shape: a webhook-interface thread driven
		// by a long-running scheduled event task. No `tasks` row is
		// needed for this test — the bug is purely a function of
		// `thread.last_message_at` driving `computeBaseline`.
		const threadCreatedAt = "2026-05-18T20:47:20.000Z";
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "webhook",
				host_origin: "local",
				color: 0,
				created_at: threadCreatedAt,
				last_message_at: "2026-05-24T23:10:26.727Z",
				modified_at: "2026-05-24T23:10:26.727Z",
				title: "Webhook: bound",
				summary: null,
				deleted: 0,
			},
			siteId,
		);

		// Seed a sequence of self-emitted developer wakeup messages,
		// progressively newer. The agent persists these into the same
		// thread that owns the task — exactly the production shape.
		const wakeupTimes = [
			"2026-05-24T18:03:16.608Z",
			"2026-05-24T18:22:28.717Z",
			"2026-05-24T18:24:58.750Z",
			"2026-05-24T21:33:29.700Z",
			"2026-05-24T22:28:00.186Z",
			"2026-05-24T22:46:10.969Z",
			"2026-05-24T22:53:11.083Z",
			"2026-05-24T23:04:11.510Z",
			"2026-05-24T23:10:18.955Z",
			"2026-05-24T23:10:26.727Z",
		];
		for (const t of wakeupTimes) {
			insertRow(
				db,
				"messages",
				{
					id: randomUUID(),
					thread_id: threadId,
					role: "developer",
					content: "[Task wakeup] Scheduled event task triggered.",
					model_id: null,
					tool_name: null,
					created_at: t,
					modified_at: t,
					host_origin: "local",
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
				siteId,
			);
		}

		// Memorize a fresh `tier='default'` entry that landed BETWEEN
		// the last user-driven message (none, in this scenario) and the
		// most recent wakeup. Production analog: `bound:issue:51`
		// memorized at 04:57Z while the latest wakeup is 23:10Z.
		const freshMemoryKey = "bound:issue:fresh-marker";
		const freshMemoryValue =
			"ISSUE: github.com/bound-agents/bound#999 OPEN, label=bug. Fresh marker for L3 recency test.";
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: freshMemoryKey,
				value: freshMemoryValue,
				source: threadId,
				tier: "default",
				created_at: "2026-05-24T04:57:00.000Z",
				modified_at: "2026-05-24T04:57:00.000Z",
				last_accessed_at: "2026-05-24T04:57:00.000Z",
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			// Pin nowMs so the relative-time fragments in volatile
			// context stay deterministic across test runs.
			nowMs: new Date("2026-05-24T23:10:30.000Z").getTime(),
		});

		// The L3 recency tier should contain the fresh memorize. Today
		// this fails because:
		//   computeBaseline returns thread.last_message_at = 23:10:26Z
		//   loadRecencyEntries filters WHERE modified_at > 23:10:26Z
		//   the fresh memory's modified_at = 04:57:00Z is BEFORE that
		//   so it is excluded from L3
		// After fix, baseline anchors to the most-recent user-role
		// message (none here) with a 24h wallclock floor; that puts
		// baseline at 22:10:30Z (24h before nowMs), well before the
		// memory's modified_at, so L3 picks it up.
		//
		// We assert against the structured `tiers.L3` channel rather
		// than `result.content`. The reason: post-R-VC24 the three
		// volatile renderers (renderWorkingKnowledge, render-
		// DiscoverableArchive, renderLiveState) don't surface
		// tier='default' entries at all — that's a separate
		// rendering-visibility bug filed in our notes as Class B1.
		// This test isolates the baseline correctness bug (B2) from
		// the rendering-visibility bug (B1) so each can be fixed and
		// verified independently.
		expect(result.tiers).toBeDefined();
		const l3Keys = (result.tiers?.L3 ?? []).map((e) => e.key);
		expect(l3Keys).toContain(freshMemoryKey);

		db.close();
	});
});
