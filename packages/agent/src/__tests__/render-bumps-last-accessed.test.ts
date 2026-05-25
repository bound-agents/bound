/**
 * Render-time `last_accessed_at` bumping (Class B3).
 *
 * Discoverable Archive sorts detail entries by `last_accessed_at DESC`
 * and renders each line with a `(last accessed Nd ago)` fragment from
 * `relativeTimeFragment`. R-MV5 (delta-read invariant) forbids bumping
 * `last_accessed_at` on `query` / `memory --action search` SELECT
 * calls — that's the agent's deliberate lookups, which should remain
 * audit-pure.
 *
 * But the volatile-context render is a different kind of access: every
 * cold assembly LOADS detail entries (`loadDetailEntries`) and renders
 * them into the agent's reading surface. The agent reads those entries
 * on every turn. Yet `last_accessed_at` only advances on writes (the
 * `memorize` tool's `INSERT` / `UPDATE` paths), so detail entries the
 * agent has been actively referencing through render-side reads still
 * show as `(last accessed 26d ago)` and the DA sort doesn't reflect
 * actual relevance.
 *
 * Live evidence: thread d0372be6 has detail entries with
 * `last_accessed_at` from 2026-04-XX (e.g.,
 * `curiosity:smolagents-codeact-paradigm:2026-04-28`) that have been
 * rendered into the agent's context every turn for weeks. They still
 * appear as "26d ago / 28d ago / 38d ago" — the agent reads them and
 * concludes "Working knowledge is months stale" because the time
 * fragments scream OLD even though the agent has been actively using
 * them.
 *
 * This test pins the invariant: **after a cold assembly that renders
 * a detail entry into the volatile context, that entry's
 * `last_accessed_at` in the DB must be newer than before the
 * assembly.** The fix shape is open — bump `last_accessed_at`
 * directly on render, add a separate `last_rendered_at` column,
 * fold it into the DA sort key, anything that satisfies the
 * surface-visible invariant.
 *
 * R-MV5 (no-bump on `query` / `memory --action search`) is
 * preserved: the rendering path is structurally distinct from the
 * agent's deliberate read tools and the bump is a render-time
 * write, not a read-time mutation.
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

describe("render-time last_accessed_at bumping", () => {
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

	it("bumps last_accessed_at when a detail entry is rendered into Discoverable Archive", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "render-bump-thread";
		const siteId = "test-site";

		const threadCreatedAt = "2026-05-24T10:00:00.000Z";
		const userMessageAt = "2026-05-25T11:30:00.000Z";
		const ancientAccessAt = "2026-04-01T00:00:00.000Z"; // ~2 months before nowMs
		const nowMs = Date.parse("2026-05-25T12:00:00.000Z");

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				created_at: threadCreatedAt,
				last_message_at: userMessageAt,
				modified_at: userMessageAt,
				title: "Render Bump Test",
				summary: null,
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
				content: "tell me what you know",
				model_id: null,
				tool_name: null,
				created_at: userMessageAt,
				modified_at: userMessageAt,
				host_origin: "local",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);

		// Insert a tier='detail' entry with last_accessed_at far in the
		// past. This entry has NOT been written to recently — only
		// rendered into volatile context. Without the B3 fix,
		// `last_accessed_at` stays frozen at this ancient value across
		// every render because `loadDetailEntries` is pure SELECT.
		const detailKey = "curiosity:render-bump-marker";
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: detailKey,
				value:
					"# Marker entry for render-bump test\n\nA detail-tier entry that should be rendered into Discoverable Archive on every cold assembly.",
				source: threadId,
				tier: "detail",
				created_at: ancientAccessAt,
				modified_at: ancientAccessAt,
				last_accessed_at: ancientAccessAt,
				deleted: 0,
			},
			siteId,
		);

		// Sanity: the entry exists with the ancient timestamp.
		const before = db
			.prepare("SELECT last_accessed_at FROM semantic_memory WHERE key = ?")
			.get(detailKey) as { last_accessed_at: string };
		expect(before.last_accessed_at).toBe(ancientAccessAt);

		// Build the volatile context. With ≤200 detail entries this
		// hits Tier 1 of `renderDiscoverableArchive` (flat list), so
		// our marker entry is definitely rendered.
		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			nowMs,
		});

		// Sanity: the entry actually rendered into the volatile content.
		// (If this fails, the test setup didn't reach the render path
		// and the bump assertion below would be misleading.)
		expect(result.content).toContain(detailKey);

		// The B3 invariant: after rendering, the entry's
		// last_accessed_at must be newer than the ancient pre-render
		// value. This fails today because `loadDetailEntries` is
		// pure SELECT and no other code path bumps the column on
		// render. After fix, it should reflect the render time.
		const after = db
			.prepare("SELECT last_accessed_at FROM semantic_memory WHERE key = ?")
			.get(detailKey) as { last_accessed_at: string };
		expect(after.last_accessed_at > before.last_accessed_at).toBe(true);

		db.close();
	});

	it("debounces: skips bumping when last_accessed_at is within the 1h window", () => {
		// Per-cold-assembly bumps on busy threads with ~200 detail
		// entries would generate one DB write per entry per cold pass
		// without a debounce. The 1h window caps the bump rate to at
		// most one write per entry per hour. This test pins that
		// behavior: an entry accessed 5 minutes ago should not be
		// bumped on the next cold assembly.
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "debounce-thread";
		const siteId = "test-site";

		const nowMs = Date.parse("2026-05-25T12:00:00.000Z");
		const recentAccessAt = "2026-05-25T11:55:00.000Z"; // 5 min before nowMs

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				created_at: "2026-05-24T10:00:00.000Z",
				last_message_at: "2026-05-25T11:30:00.000Z",
				modified_at: "2026-05-25T11:30:00.000Z",
				title: "Debounce Test",
				summary: null,
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
				content: "ping",
				model_id: null,
				tool_name: null,
				created_at: "2026-05-25T11:30:00.000Z",
				modified_at: "2026-05-25T11:30:00.000Z",
				host_origin: "local",
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);

		const detailKey = "curiosity:debounce-marker";
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: detailKey,
				value: "Marker entry recently accessed; should not be re-bumped within debounce.",
				source: threadId,
				tier: "detail",
				created_at: recentAccessAt,
				modified_at: recentAccessAt,
				last_accessed_at: recentAccessAt,
				deleted: 0,
			},
			siteId,
		);

		buildVolatileContext({ db, threadId, userId, siteId, nowMs });

		const after = db
			.prepare("SELECT last_accessed_at FROM semantic_memory WHERE key = ?")
			.get(detailKey) as { last_accessed_at: string };

		// The entry was accessed 5 minutes ago — well within the 1h
		// debounce window. The render-time bumper should leave it
		// alone, preserving the original timestamp.
		expect(after.last_accessed_at).toBe(recentAccessAt);

		db.close();
	});
});
