/**
 * Invariant #19 regression: role='system' is forbidden in the `messages` table.
 *
 * insertRow() enforces this at the write boundary. The sync reducers must
 * enforce it on replay too — a peer running pre-fix code (or a buggy fork)
 * can emit role='system' rows that Stage 2.5 of context assembly silently
 * drops, producing the "agent received a notification but didn't respond"
 * symptom observed live on thread a83b945f-d4b1-4b77-904f-bb9b465edc1d.
 *
 * Kept in its own file with a minimal schema so a future verification run
 * finishes in ~100ms with tight output:
 *   bun test packages/sync/src/__tests__/reducers-invariant-19.test.ts
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChangeLogEntry, Logger } from "@bound/shared";
import { applyAppendOnlyReducer, replayEvents } from "../reducers.js";

interface CapturedWarning {
	msg: string;
	ctx?: Record<string, unknown>;
}

/** Bare logger that only records warns — all other levels are no-ops. */
function captureWarnings(): { logger: Logger; warnings: CapturedWarning[] } {
	const warnings: CapturedWarning[] = [];
	const logger: Logger = {
		warn: (msg: string, ctx?: Record<string, unknown>) => {
			warnings.push({ msg, ctx });
		},
		info: () => {},
		error: () => {},
		debug: () => {},
	};
	return { logger, warnings };
}

/** Build a messages-table ChangeLogEntry with sensible defaults. */
function makeMessageEvent(overrides: {
	rowId: string;
	role: string;
	hlc?: string;
	siteId?: string;
	hostOrigin?: string;
}): ChangeLogEntry {
	const hlc = overrides.hlc ?? `2026-04-26T21:00:00.000Z_0001_${overrides.rowId}`;
	const siteId = overrides.siteId ?? "site-hub";
	const hostOrigin = overrides.hostOrigin ?? "hub";
	return {
		hlc,
		table_name: "messages",
		row_id: overrides.rowId,
		site_id: siteId,
		timestamp: "2026-04-26T21:00:00Z",
		row_data: JSON.stringify({
			id: overrides.rowId,
			thread_id: "thread-1",
			role: overrides.role,
			content: "body",
			created_at: "2026-04-26T21:00:00Z",
			host_origin: hostOrigin,
		}),
	};
}

describe("reducers — invariant #19 (role='system' forbidden in messages)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		// Minimal schema — just enough for the reducers to run. No semantic_memory,
		// hosts, memory_edges etc. so setup is tiny and fast.
		db.run(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				model_id TEXT,
				tool_name TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT,
				host_origin TEXT NOT NULL
			)
		`);
		db.run(`
			CREATE TABLE change_log (
				hlc TEXT PRIMARY KEY,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				site_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				row_data TEXT NOT NULL
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	it("applyAppendOnlyReducer drops role='system' and logs a warn with source metadata", () => {
		const { logger, warnings } = captureWarnings();
		const event = makeMessageEvent({
			rowId: "sys-notif-1",
			role: "system",
			hlc: "2026-04-26T21:01:56.000Z_0001_hub",
			hostOrigin: "00dbcaa4d6f9",
		});

		const result = applyAppendOnlyReducer(db, event, { logger });

		expect(result.applied).toBe(false);
		expect(db.query("SELECT id FROM messages").get()).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0].msg).toContain("role='system'");
		expect(warnings[0].ctx).toMatchObject({
			row_id: "sys-notif-1",
			site_id: "site-hub",
			host_origin: "00dbcaa4d6f9",
		});
	});

	// All legitimate roles in the messages domain (MessageRole in @bound/shared
	// minus 'system'). One assertion per role so a regression reports WHICH role
	// broke, not "one of them".
	for (const role of ["user", "assistant", "developer", "tool_call", "tool_result"]) {
		it(`applyAppendOnlyReducer applies role='${role}' normally`, () => {
			const result = applyAppendOnlyReducer(db, makeMessageEvent({ rowId: `ok-${role}`, role }));
			expect(result.applied).toBe(true);
		});
	}

	it("replayEvents skips role='system' mid-batch without blocking surrounding rows", () => {
		const { logger, warnings } = captureWarnings();
		const events: ChangeLogEntry[] = [
			makeMessageEvent({ rowId: "ok-user", role: "user" }),
			makeMessageEvent({ rowId: "bad-system", role: "system" }),
			makeMessageEvent({ rowId: "ok-developer", role: "developer" }),
		];

		const result = replayEvents(db, events, { logger });

		expect(result).toEqual({ applied: 2, skipped: 1 });
		const ids = (db.query("SELECT id FROM messages ORDER BY id").all() as { id: string }[]).map(
			(r) => r.id,
		);
		expect(ids).toEqual(["ok-developer", "ok-user"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].ctx?.row_id).toBe("bad-system");
	});
});
