/**
 * Purge-summary provenance marker (Class D, sub-mechanism F2b).
 *
 * The `purge` tool accepts a free-text `summary` argument from the
 * agent and persists it inside a `role='purge'` message
 * (`tools/purge.ts:106-112`). On the next cold assembly, Stage 2
 * (PURGE_SUBSTITUTION) of `assembleContext` substitutes that purge
 * group with a synthetic `role='developer'` message whose content is:
 *
 *   `(purged ${N} messages) ${summary}`
 *
 * Because the bridge wraps developer-role messages in
 * `<system-context>...</system-context>`, the agent reads its own
 * past purge summary back as authoritative system context — exactly
 * the framing it used at write time.
 *
 * Live evidence (`_feedback:correction:compaction_summary_not_ground_truth:recurrence_20260524`):
 * the agent purged ~500 webhook messages with the summary "Bulk
 * purge of 500 webhook processing messages. All issue entries have
 * been logged to memory with proper cross-linking. GitHub webhook
 * deliveries 8dc3c3d0 through edc5c960 processed successfully —
 * issues #20-36 captured." On audit, ZERO of those issues were
 * actually in memory. The summary was a confabulation at WRITE
 * time. On every subsequent cold assembly, the agent read its own
 * confabulation as system fact and gate-dismissed real events for
 * ~50 turns. From the agent's own filing: "the pre-deliberative
 * pattern-match level absorbed the summary's claim as fact and
 * used it to gate-dismiss subsequent events."
 *
 * The fix shape: when rendering the substitution, prefix the
 * agent-authored summary with a provenance marker that flags it as
 * a past assertion the agent should verify before relying on. Any
 * marker that the agent will read as "this is your prior claim, not
 * confirmed system state" satisfies the invariant. The exact
 * wording is left open; the test asserts on the presence of an
 * agent-authored signal.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { assembleContext } from "../context-assembly";

function createTempDb(dbPath: string): Database {
	const { Database: BunDatabase } = require("bun:sqlite");
	const db = new BunDatabase(dbPath);
	applySchema(db);
	return db;
}

describe("purge-summary provenance marker", () => {
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

	it("renders agent-authored summary with provenance marker, not as authoritative system state", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "purge-provenance-thread";
		const now = new Date().toISOString();

		// Setup: a user, a thread, and a chunk of messages that the
		// agent has "purged" with a confabulated summary string.
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Kara", null, now, now, 0],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, summary, summary_through, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[threadId, userId, "web", "local", 0, now, now, now, null, null, 0],
		);

		const userMsgId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[userMsgId, threadId, "user", "Hello, please process the webhooks", now, "local", 0],
		);

		// Insert a few "purged" target messages
		const purgedMsgIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = randomUUID();
			purgedMsgIds.push(id);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[id, threadId, "assistant", `Webhook batch ${i} processed`, now, "local", 0],
			);
		}

		// Insert the purge marker. The summary text mirrors the d0372be6
		// 2026-05-24 incident — a confabulated agent-authored claim.
		const purgeMsgId = randomUUID();
		const confabulatedSummary =
			"Bulk purge of webhook processing messages. All issue entries have been logged to memory with proper cross-linking. Issues #20-36 captured.";
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				purgeMsgId,
				threadId,
				"purge",
				JSON.stringify({ target_ids: purgedMsgIds, summary: confabulatedSummary }),
				now,
				"local",
				0,
			],
		);

		const result = assembleContext({
			db,
			threadId,
			userId,
			configDir,
		});

		// Find the synthetic developer-role substitution message.
		// Stage 2 emits exactly one developer message per purge group.
		const devMessages = result.messages.filter((m) => m.role === "developer");
		const purgeStub = devMessages.find(
			(m) => typeof m.content === "string" && m.content.includes(confabulatedSummary),
		);
		expect(purgeStub).toBeDefined();
		expect(purgeStub).not.toBeUndefined();
		const stubContent = typeof purgeStub?.content === "string" ? purgeStub.content : "";

		// Sanity: the substitution still includes the purged-count and
		// the agent's original summary so context isn't lost.
		expect(stubContent).toContain(confabulatedSummary);
		expect(stubContent).toContain("3"); // purged count

		// The B-class / D2 invariant: the rendered substitution must
		// flag the summary as agent-authored and unverified, so the
		// agent reads it as a past assertion to verify rather than
		// authoritative system state.
		//
		// The exact wording is left open — the test accepts any of
		// several reasonable provenance signals: "agent-authored",
		// "your prior", "unverified", or "verify". Today this fails
		// because the substitution is just `(purged N messages) <summary>`
		// with no provenance signal at all.
		const provenanceMarkers = ["agent-authored", "your prior", "unverified", "verify"];
		const hasProvenance = provenanceMarkers.some((m) =>
			stubContent.toLowerCase().includes(m.toLowerCase()),
		);
		expect(hasProvenance).toBe(true);

		db.close();
	});
});
