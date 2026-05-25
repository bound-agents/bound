/**
 * L3 recency rendering visibility (Class B1).
 *
 * Companion to `l3-recency-self-driving-thread.test.ts`. That test
 * verified that with the B2 baseline fix, `tier='default'` memorizes
 * that landed between wakeups now reach `result.tiers.L3`. This test
 * pins the next-stage invariant: **entries that reach `tiers.L3` must
 * also be rendered into `result.content`** so the agent actually sees
 * them on the wire.
 *
 * Today this fails because the post-R-VC24 renderers
 * (`renderWorkingKnowledge`, `renderDiscoverableArchive`,
 * `renderLiveState`) all filter by tier:
 *   - `renderWorkingKnowledge`: `tier='pinned' OR tier='summary'` (or
 *     pinned-prefix keys). Skips default.
 *   - `renderDiscoverableArchive`: `tier='detail'` only. Skips default.
 *   - `renderLiveState`: cross-thread digest, task digest, file
 *     modifications, applied advisories. Doesn't read semantic_memory.
 *
 * `loadRecencyEntries` in `buildVolatileEnrichment` produces L3
 * entries (default tier + orphaned details) and they land in
 * `tiers.L3` and `memoryDeltaLines`. But `composeVolatileSections`
 * never reads `tiers.L3` or `memoryDeltaLines` — they're returned by
 * `buildVolatileContext` as data fields but not rendered.
 *
 * Live evidence: thread d0372be6 had recent `bound:issue:51`,
 * `_outcome:bound-release-v0.0.162-…`, and other fresh `tier='default'`
 * memorizes. Even with the B2 baseline fix lifting them into
 * `tiers.L3`, the agent still wouldn't see them on the wire because
 * `result.content` (and `result.varyingContent`) doesn't include
 * them — leading to the "Working knowledge is months stale"
 * misperception even when the data is fresh.
 *
 * This test pins the surface invariant. The fix shape is left open:
 * inject `memoryDeltaLines` into the varying tail, add a new
 * `renderRecency` to `composeVolatileSections`, extend
 * `renderLiveState` with a `[recency]` subsection — any of these
 * would satisfy the assertion.
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

describe("L3 recency rendering visibility", () => {
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

	it("renders a default-tier entry that L3 surfaces into the varying volatile tail", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "user-driven-thread";
		const siteId = "test-site";

		// Use a user-driven thread where the user typed 30 minutes ago
		// and the agent has been memorizing things since. With the B2
		// fix, baseline = the user message timestamp, so any memorize
		// after that lands in tiers.L3.
		const threadCreatedAt = "2026-05-24T10:00:00.000Z";
		const userMessageAt = "2026-05-24T11:30:00.000Z";
		const memorizeAt = "2026-05-24T11:45:00.000Z";
		const nowMs = Date.parse("2026-05-24T12:00:00.000Z");

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
				title: "User Thread",
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
				content: "What's the latest on bound?",
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

		const freshMemoryKey = "bound:issue:l3-rendering-marker";
		const freshMemoryValue =
			"ISSUE: github.com/bound-agents/bound#42 OPEN, label=enhancement. Fresh marker for L3 rendering test.";
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key: freshMemoryKey,
				value: freshMemoryValue,
				source: threadId,
				tier: "default",
				created_at: memorizeAt,
				modified_at: memorizeAt,
				last_accessed_at: memorizeAt,
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
			nowMs,
		});

		// Sanity: B2's baseline fix already lifted the entry into
		// tiers.L3. If this assertion fails, B2 regressed.
		const l3Keys = (result.tiers?.L3 ?? []).map((e) => e.key);
		expect(l3Keys).toContain(freshMemoryKey);

		// The B1 invariant: entries surfaced into tiers.L3 must also
		// appear in result.content so the agent reads them on the wire.
		// Today this fails — none of the three R-VC24 renderers
		// surface `tier='default'` entries, so result.content omits
		// them entirely even though loadRecencyEntries produced them.
		expect(result.content).toContain(freshMemoryKey);

		// Specifically the entry must be in the varying half (the dev
		// tail message), since that's where per-turn-changing content
		// belongs. The stable prefix (cached system prompt) is for
		// turn-invariant content.
		expect(result.varyingContent).toContain(freshMemoryKey);

		db.close();
	});
});
