import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertRow, updateRow } from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";
describe("Database Schema", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("creates database with WAL mode and foreign keys enabled", () => {
		const db = createDatabase(dbPath);

		const journalMode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
		expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

		const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(foreignKeys.foreign_keys).toBe(1);

		db.close();
	});

	it("applies schema successfully creating all 22 tables + FTS5", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const tables = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all() as Array<{ name: string }>;

		const tableNames = tables.map((t) => t.name);

		// Verify all 21 base tables exist
		expect(tableNames).toContain("users");
		expect(tableNames).toContain("threads");
		expect(tableNames).toContain("messages");
		expect(tableNames).toContain("semantic_memory");
		expect(tableNames).toContain("tasks");
		expect(tableNames).toContain("files");
		expect(tableNames).toContain("hosts");
		expect(tableNames).toContain("cluster_config");
		expect(tableNames).toContain("advisories");
		expect(tableNames).toContain("skills");
		expect(tableNames).toContain("memory_edges");
		expect(tableNames).toContain("connector_handles");
		expect(tableNames).toContain("webhooks");
		expect(tableNames).toContain("change_log");
		expect(tableNames).toContain("sync_state");
		expect(tableNames).toContain("host_meta");
		expect(tableNames).not.toContain("relay_outbox");
		expect(tableNames).not.toContain("relay_inbox");
		expect(tableNames).toContain("relay_cycles");
		expect(tableNames).toContain("dispatch_queue");

		// FTS5 virtual table + its shadow tables
		expect(tableNames).toContain("semantic_memory_fts");

		// 24 base tables (relay_outbox/relay_inbox retired at release N+1; includes
		// local-only row_state_hashes cache, durable_work, and local_flags) + FTS5
		// virtual table + 5 FTS5 shadow tables = 30
		const baseTables = tableNames.filter((n) => !n.startsWith("semantic_memory_fts_"));
		expect(baseTables.length).toBe(25); // 24 base + 1 FTS5 virtual table

		db.close();
	});

	it("creates all indexes", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const indexes = db
			.query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
			.all() as Array<{ name: string }>;

		const indexNames = indexes.map((i) => i.name);

		expect(indexNames).toContain("idx_threads_user");
		expect(indexNames).toContain("idx_messages_thread");
		expect(indexNames).toContain("idx_messages_live_thread_created");
		expect(indexNames).toContain("idx_messages_consistency");
		expect(indexNames).toContain("idx_semantic_memory_consistency");
		const consistencyPlan = db
			.query(
				"EXPLAIN QUERY PLAN SELECT id, modified_at FROM messages WHERE role != 'system' AND id > ? ORDER BY id ASC LIMIT ?",
			)
			.all("", 100) as Array<{ detail: string }>;
		expect(consistencyPlan.map((row) => row.detail).join(" ")).toContain(
			"COVERING INDEX idx_messages_consistency",
		);
		expect(indexNames).not.toContain("idx_relay_inbox_ref_unprocessed_received");

		const messagePlan = db
			.query(
				"EXPLAIN QUERY PLAN SELECT * FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at ASC",
			)
			.all("thread-1") as Array<{ detail: string }>;
		expect(messagePlan.map((row) => row.detail).join(" ")).toContain(
			"idx_messages_live_thread_created",
		);

		expect(indexNames).toContain("idx_memory_key");
		expect(indexNames).toContain("idx_files_path");
		expect(indexNames).toContain("idx_skills_name");
		expect(indexNames).toContain("idx_edges_triple");
		expect(indexNames).toContain("idx_edges_source");
		expect(indexNames).toContain("idx_edges_target");
		// idx_changelog_seq removed in HLC migration â hlc is TEXT PRIMARY KEY
		expect(indexNames).toContain("idx_memory_modified");
		expect(indexNames).toContain("idx_tasks_last_run");
		expect(indexNames).toContain("idx_memory_detail_recency");

		db.close();
	});

	it("idx_memory_detail_recency exists and supports R-VC4 SELECT predicate", () => {
		const db = createDatabase(":memory:");
		applySchema(db);

		// Verify the index exists
		const indexes = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_detail_recency'",
			)
			.all() as Array<{ name: string }>;
		expect(indexes).toHaveLength(1);

		// Verify the index is COVERING by including key column (for planner to prefer it)
		const indexInfo = db.query("PRAGMA index_info(idx_memory_detail_recency)").all() as Array<{
			seqno: number;
			cid: number;
			name: string;
		}>;

		// Should have last_accessed_at and key (covering index)
		expect(indexInfo).toHaveLength(2);
		expect(indexInfo[0].name).toBe("last_accessed_at");
		expect(indexInfo[1].name).toBe("key");

		// Verify the index WHERE clause by querying sqlite_master
		const indexDef = db
			.query(
				"SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memory_detail_recency'",
			)
			.get() as { sql: string };
		expect(indexDef.sql).toContain("tier = 'detail'");
		expect(indexDef.sql).toContain("deleted = 0");

		// Insert large dataset (1000+ rows) to make planner favor the specialized index
		// Mix of tiers to exercise the partial index WHERE clause filtering
		for (let i = 0; i < 1200; i++) {
			const tier = i % 10 < 4 ? "detail" : i % 10 < 7 ? "summary" : "pinned";
			const deleted = i === 42 ? 1 : 0; // soft-delete one detail row
			db.run(`
				INSERT INTO semantic_memory (
					id, key, value, tier, source, created_at, last_accessed_at, modified_at, deleted
				) VALUES (
					'test-id-${i}',
					'test-key-${i}',
					'test-value-${i}',
					'${tier}',
					'test-source',
					datetime('now'),
					datetime('now', '-${1200 - i} seconds'),
					datetime('now'),
					${deleted}
				)
			`);
		}

		// Run ANALYZE so the query planner has statistics to make decisions
		db.run("ANALYZE");

		// Verify that the query with the correct predicate (deleted = 0) returns expected results
		// Rows with tier='detail' and deleted=0 should be returned, ordered by recency
		const results = db
			.prepare(
				"SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted = 0 ORDER BY last_accessed_at DESC",
			)
			.all() as Array<{ key: string; last_accessed_at: string | null }>;

		// Should have ~480 detail rows (1200 * 0.4 â 480, minus 1 deleted)
		expect(results.length).toBeGreaterThan(400);
		expect(results.length).toBeLessThan(500);
		// Verify they are sorted by last_accessed_at descending
		for (let i = 1; i < results.length; i++) {
			const prev = results[i - 1].last_accessed_at;
			const curr = results[i].last_accessed_at;
			if (prev !== null && curr !== null) {
				// Timestamps are ISO 8601 strings, which sort lexicographically in descending order
				expect(prev >= curr).toBe(true);
			}
		}

		// CRITICAL: Verify the EXPLAIN QUERY PLAN shows idx_memory_detail_recency is selected
		// The covering index must be used (not idx_memory_tier), and no TEMP B-TREE sort
		const queryPlan = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted = 0 ORDER BY last_accessed_at DESC",
			)
			.all() as Array<{ detail: string }>;
		const planText = queryPlan.map((row) => row.detail).join(" ");

		// Regression guard: must use the covering partial index for recency ordering
		expect(planText).toContain("idx_memory_detail_recency");
		// Must NOT require a temporary B-tree for sorting (would indicate wrong index)
		expect(planText).not.toContain("TEMP B-TREE");

		db.close();
	});

	it("enforces STRICT mode on tables", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		// STRICT tables reject wrong types
		const result = db.query("PRAGMA table_info(users)").all() as Array<{
			cid: number;
			name: string;
			type: string;
		}>;

		expect(result.length).toBeGreaterThan(0);

		// Verify users table is STRICT by trying to insert wrong type
		db.run(`INSERT INTO users (id, display_name, first_seen_at, modified_at)
			VALUES ('user-123', 'Alice', '2026-03-22T00:00:00Z', '2026-03-22T00:00:00Z')`);

		const users = db.query("SELECT * FROM users").all();
		expect(users).toHaveLength(1);

		db.close();
	});

	it("allows idempotent schema application", () => {
		const db = createDatabase(dbPath);

		// Apply schema twice
		applySchema(db);
		applySchema(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>;

		// Still exactly 30 tables (24 base after relay_outbox/relay_inbox retired at
		// release N+1, incl. local-only durable_work, local_flags, row_state_hashes
		// cache, + 1 FTS5 virtual + 5 FTS5 shadow)
		expect(tables.length).toBe(30);

		db.close();
	});

	it("boot never creates the retired relay tables (release N+1)", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		// The retired tables must never be created on a fresh N+1 host.
		const outbox = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'")
			.get();
		const inbox = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_inbox'")
			.get();
		expect(outbox).toBeNull();
		expect(inbox).toBeNull();

		// A restart is a no-op — still never created.
		applySchema(db);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
		).toBeNull();

		// relay_cycles (retained telemetry) still exists.
		const cycles = db
			.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_cycles'")
			.get();
		expect(cycles).not.toBeNull();

		db.close();
	});

	describe("startup refusal on populated legacy relay tables (release N+1)", () => {
		// A host reaching this binary with a legacy relay table that still holds
		// rows skipped the release-N drain-and-drop migration. applySchema must
		// refuse to start rather than silently strand that undelivered work.
		// `relaxed` drops the NOT NULL on expires_at and the DEFAULT 0 on the
		// consumed column so a test can insert NULL expires_at / NULL delivered
		// rows — the boot gate must classify those as unsafe (live) even though the
		// release-N schema declared them NOT NULL / DEFAULT 0, because SQLite never
		// validated ISO syntax and a hand-migrated legacy table may hold anything.
		function createLegacyRelayTable(
			db: ReturnType<typeof createDatabase>,
			table: string,
			opts: { relaxed?: boolean } = {},
		): void {
			// STRICT is the release-N table shape (30bf4693) and stays the default:
			// `relaxed` opts OUT of STRICT (and drops NOT NULL / DEFAULT 0) ONLY so a
			// test can insert the deliberately-malformed values a STRICT INTEGER /
			// NOT NULL column would reject (NULL expires_at, NULL / '' / 'garbage'
			// consumed flag). The boot gate must still classify those as unsafe (live),
			// because SQLite never validated ISO syntax and a hand-migrated non-STRICT
			// legacy table may hold anything.
			const notNull = opts.relaxed ? "" : " NOT NULL";
			const consumedDefault = opts.relaxed ? "" : " DEFAULT 0";
			const strict = opts.relaxed ? "" : " STRICT";
			if (table === "relay_outbox") {
				db.run(`
					CREATE TABLE relay_outbox (
						id              TEXT PRIMARY KEY,
						source_site_id  TEXT,
						target_site_id  TEXT NOT NULL,
						kind            TEXT NOT NULL,
						ref_id          TEXT,
						idempotency_key TEXT,
						payload         TEXT NOT NULL,
						created_at      TEXT NOT NULL,
						expires_at      TEXT${notNull},
						delivered       INTEGER${consumedDefault}
					)${strict}
				`);
			} else {
				db.run(`
					CREATE TABLE relay_inbox (
						id              TEXT PRIMARY KEY,
						source_site_id  TEXT NOT NULL,
						kind            TEXT NOT NULL,
						ref_id          TEXT,
						idempotency_key TEXT,
						payload         TEXT NOT NULL,
						expires_at      TEXT${notNull},
						received_at     TEXT NOT NULL,
						processed       INTEGER${consumedDefault}
					)${strict}
				`);
			}
		}

		// Pull the advertised `SELECT ... ;` statement out of a refusal message so a
		// test can execute it against the live table and prove it is valid SQL for
		// that specific table (objection 2: the round-1 message named outbox columns
		// for both tables).
		function extractInspectionSql(message: string): string {
			const m = /(SELECT[\s\S]*?;)/i.exec(message);
			if (!m) throw new Error(`no inspection SQL found in message: ${message}`);
			return m[1];
		}

		// ISO 8601 timestamps relative to now so "unexpired" tests stay live.
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

		it("refuses to start on a LIVE (undelivered + unexpired) relay_outbox row", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["e1", "peer", "result", "{}", past, future],
			);

			expect(() => applySchema(db)).toThrow(/relay_outbox/);
			// message names the live count and the inspection SQL an operator can run
			expect(() => applySchema(db)).toThrow(/1 live/i);
			expect(() => applySchema(db)).toThrow(/SELECT .*FROM relay_outbox/i);

			db.close();
		});

		it("refuses to start on a LIVE (unprocessed + unexpired) relay_inbox row", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_inbox");
			db.run(
				"INSERT INTO relay_inbox (id, source_site_id, kind, payload, expires_at, received_at, processed) VALUES (?,?,?,?,?,?,0)",
				["e1", "peer", "inference", "{}", future, past],
			);

			expect(() => applySchema(db)).toThrow(/relay_inbox/);
			expect(() => applySchema(db)).toThrow(/1 live/i);

			db.close();
		});

		it("warns + drops + boots when relay_outbox holds only EXPIRED rows", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// undelivered but expired: contractually dead (requester's await timed out)
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["e1", "peer", "result", "{}", past, past],
			);

			expect(() => applySchema(db)).not.toThrow();
			// table is dropped after the clean boot
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		it("warns + drops + boots when relay_outbox holds only DELIVERED rows", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// delivered rows are consumed even if not yet expired
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,1)",
				["e1", "peer", "result", "{}", past, future],
			);

			expect(() => applySchema(db)).not.toThrow();
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		it("refuses on MIXED live+expired rows and reports the correct breakdown", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// one live, two expired, one delivered → 1 live, 3 non-live
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["live1", "peer", "result", "{}", past, future],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["exp1", "peer", "result", "{}", past, past],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["exp2", "peer", "result", "{}", past, past],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,1)",
				["del1", "peer", "result", "{}", past, future],
			);

			expect(() => applySchema(db)).toThrow(/1 live/i);
			// breakdown mentions the non-live counts too
			expect(() => applySchema(db)).toThrow(/expired/i);
			expect(() => applySchema(db)).toThrow(/delivered/i);

			db.close();
		});

		it("refuses on a NULL expires_at undelivered relay_outbox row (unprovable → live)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox", { relaxed: true });
			// expires_at IS NULL: NULL > now and NULL <= now both evaluate NULL, so the
			// round-1 predicate-per-bucket SQL classified this row as neither live nor
			// expired. It is not PROVABLY expired → the exhaustive remainder must count
			// it live and refuse.
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,NULL,0)",
				["e1", "peer", "result", "{}", past],
			);

			expect(() => applySchema(db)).toThrow(/relay_outbox/);
			expect(() => applySchema(db)).toThrow(/1 live/i);

			db.close();
		});

		it("refuses on a malformed (garbage / empty-string) expires_at row (unprovable → live)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// '' <= nowIso is TRUE in SQLite string comparison, so the round-1 SQL
			// misclassified an empty/garbage expires_at as validly expired. A row whose
			// expires_at is not a sane ISO shape is not PROVABLY expired → live.
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["garbage1", "peer", "result", "{}", past, "garbage"],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["empty1", "peer", "result", "{}", past, ""],
			);

			expect(() => applySchema(db)).toThrow(/relay_outbox/);
			expect(() => applySchema(db)).toThrow(/2 live/i);

			db.close();
		});

		// Renders a Date as an ISO 8601 timestamp with an explicit non-UTC offset
		// (e.g. "2026-09-03T20:00:00-05:00"). The instant is preserved; only the
		// wall-clock representation shifts, so the RAW STRING sorts differently from
		// the same instant rendered as a 'Z' timestamp. This is exactly the shape the
		// round-3 objection exposed: a raw-string `expires_at <= nowIso` compare
		// misclassifies a future instant carrying a negative offset as expired.
		function isoWithOffset(instantMs: number, offsetHours: number): string {
			// Shift the wall-clock fields by the offset, then append the offset suffix
			// so the string denotes the SAME UTC instant as `instantMs`.
			const shifted = new Date(instantMs + offsetHours * 60 * 60 * 1000);
			const pad = (n: number, w = 2) => String(n).padStart(w, "0");
			const sign = offsetHours <= 0 ? "-" : "+";
			const abs = Math.abs(offsetHours);
			return (
				`${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
				`T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
				`${sign}${pad(abs)}:00`
			);
		}

		it("refuses on an undelivered row whose negative-offset expires_at instant is in the FUTURE (parsed-instant compare, not string sort)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// now = T; expires_at = (T + 4h) rendered with a -05:00 offset. The parsed
			// UTC instant is 4h in the FUTURE, so the row is LIVE. But the raw string —
			// wall-clock fields shifted back 5h and suffixed "-05:00" — sorts BEFORE the
			// 'Z' nowIso, so a string `expires_at <= nowIso` would wrongly call it
			// expired and DROP LIVE WORK. The fix compares datetime()-normalized instants.
			const futureOffset = isoWithOffset(Date.now() + 4 * 60 * 60 * 1000, -5);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["futoff1", "peer", "result", "{}", past, futureOffset],
			);

			let message = "";
			try {
				applySchema(db);
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).toMatch(/relay_outbox/);
			expect(message).toMatch(/1 live/i);

			// The advertised inspection SQL must return EXACTLY that row — proving the
			// aggregate classifier and the operator query agree on the parsed-instant
			// comparison (shared-fragment parity holds under the fix).
			const inspectSql = extractInspectionSql(message);
			const rows = db.query(inspectSql).all() as Array<{ expires_at: string }>;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.expires_at).toBe(futureOffset);

			db.close();
		});

		it("drops + boots on an undelivered row whose negative-offset expires_at instant is in the PAST (mirror)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// now = T; expires_at = (T - 4h) rendered with a -05:00 offset. The parsed
			// UTC instant is 4h in the PAST → provably expired → drop + boot. A plain
			// guard that past offset timestamps still classify expired under the
			// normalized-instant comparison.
			const pastOffset = isoWithOffset(Date.now() - 4 * 60 * 60 * 1000, -5);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["pastoff1", "peer", "result", "{}", past, pastOffset],
			);

			expect(() => applySchema(db)).not.toThrow();
			// table is dropped after the clean boot (no live work)
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		it("refuses on a NULL delivered/processed row (unprovable consumed → live)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox", { relaxed: true });
			// delivered IS NULL: `!= 0` is NULL (not consumed) and `= 0` is NULL (not
			// expired/live under the round-1 predicate). A row not PROVABLY consumed and
			// not PROVABLY expired → live. expires_at is in the past to prove the live
			// classification comes from the NULL consumed column, not the TTL.
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,NULL)",
				["nulldel1", "peer", "result", "{}", past, past],
			);

			expect(() => applySchema(db)).toThrow(/relay_outbox/);
			expect(() => applySchema(db)).toThrow(/1 live/i);

			db.close();
		});

		it("reports a breakdown whose live+expired+consumed sums to total", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox", { relaxed: true });
			// 2 live (1 unexpired-undelivered + 1 NULL-expires), 1 expired, 1 delivered
			// → total 4. The remainder arithmetic guarantees the buckets sum to total.
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["live1", "peer", "result", "{}", past, future],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,NULL,0)",
				["nullexp1", "peer", "result", "{}", past],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["exp1", "peer", "result", "{}", past, past],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,1)",
				["del1", "peer", "result", "{}", past, future],
			);

			let message = "";
			try {
				applySchema(db);
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).toMatch(/relay_outbox/);

			// Parse the numeric breakdown out of the message and assert it sums.
			const live = Number(/(\d+) live/i.exec(message)?.[1]);
			const expired = Number(/(\d+) expired/i.exec(message)?.[1]);
			const consumed = Number(/(\d+) delivered/i.exec(message)?.[1]);
			const total = Number(/(\d+) total/i.exec(message)?.[1]);
			expect(live).toBe(2);
			expect(expired).toBe(1);
			expect(consumed).toBe(1);
			expect(total).toBe(4);
			expect(live + expired + consumed).toBe(total);

			db.close();
		});

		it("emits a structured warn line with the correct breakdown on the drop path", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// 2 expired + 1 delivered, no live → warn + drop + boot.
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["exp1", "peer", "result", "{}", past, past],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["exp2", "peer", "result", "{}", past, past],
			);
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,1)",
				["del1", "peer", "result", "{}", past, future],
			);

			const warnings: string[] = [];
			const originalWarn = console.warn;
			console.warn = (...args: unknown[]) => {
				warnings.push(args.map(String).join(" "));
			};
			try {
				expect(() => applySchema(db)).not.toThrow();
			} finally {
				console.warn = originalWarn;
			}

			const dropLine = warnings.find((w) => w.includes("relay_outbox"));
			expect(dropLine).toBeDefined();
			expect(dropLine).toMatch(/3 row/); // total
			expect(dropLine).toMatch(/2 expired/);
			expect(dropLine).toMatch(/1 delivered/);

			db.close();
		});

		it("hands the operator VALID inspection SQL for a live relay_outbox refusal", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			db.run(
				"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,0)",
				["live1", "peer", "result", "{}", past, future],
			);

			let message = "";
			try {
				applySchema(db);
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).toMatch(/SELECT .*FROM relay_outbox/i);
			// The advertised SQL must reference relay_outbox columns only (target_site_id,
			// created_at) and must actually execute against the live table.
			const sql = extractInspectionSql(message);
			expect(sql).toContain("target_site_id");
			expect(sql).toContain("created_at");
			expect(() => db.query(sql).all()).not.toThrow();
			expect((db.query(sql).all() as unknown[]).length).toBe(1);

			db.close();
		});

		it("hands the operator VALID inspection SQL for a live relay_inbox refusal", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_inbox");
			db.run(
				"INSERT INTO relay_inbox (id, source_site_id, kind, payload, expires_at, received_at, processed) VALUES (?,?,?,?,?,?,0)",
				["live1", "peer", "inference", "{}", future, past],
			);

			let message = "";
			try {
				applySchema(db);
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).toMatch(/SELECT .*FROM relay_inbox/i);
			// relay_inbox has NO target_site_id / created_at — the round-1 shared SQL
			// named those and would error against this table. The per-table SQL must
			// name source_site_id / received_at and execute cleanly.
			const sql = extractInspectionSql(message);
			expect(sql).toContain("source_site_id");
			expect(sql).toContain("received_at");
			expect(sql).not.toContain("target_site_id");
			expect(() => db.query(sql).all()).not.toThrow();
			expect((db.query(sql).all() as unknown[]).length).toBe(1);

			db.close();
		});

		// --- Round 3: the advertised inspection SQL must return EXACTLY the rows the
		// classifier counted live (objection 1). The round-2 SQL was
		// `WHERE <flag> = 0 AND expires_at > now`, which EXCLUDES every indeterminate
		// live row (NULL/malformed expires_at, NULL flag), so the error could report N
		// live while the advertised query returned 0. These tests drive each
		// classifier-live category, run the advertised SQL against the live table, and
		// assert the returned row count equals the live count named in the message.

		function refusalMessage(db: ReturnType<typeof createDatabase>): string {
			try {
				applySchema(db);
			} catch (err) {
				return (err as Error).message;
			}
			throw new Error("expected applySchema to throw a refusal");
		}

		function liveCountFromMessage(message: string): number {
			const m = /(\d+) live/i.exec(message);
			if (!m) throw new Error(`no live count in message: ${message}`);
			return Number(m[1]);
		}

		// Each case inserts exactly one row of the named category into relay_outbox,
		// then asserts (a) the row is classified live and (b) the advertised SQL,
		// executed against the very same table, returns exactly the live rows the
		// message named. `relaxed` where the fixture needs NULLs a STRICT column rejects.
		const outboxInsert =
			"INSERT INTO relay_outbox (id, target_site_id, kind, payload, created_at, expires_at, delivered) VALUES (?,?,?,?,?,?,?)";
		type LiveCase = {
			name: string;
			relaxed?: boolean;
			// [id, expires_at, delivered]
			row: [string, string | null, number | string | null];
		};
		const liveCases: LiveCase[] = [
			{ name: "ordinary unexpired (undelivered)", row: ["live1", future, 0] },
			{ name: "NULL expires_at", relaxed: true, row: ["nullexp1", null, 0] },
			{ name: "empty-string expires_at", row: ["empty1", "", 0] },
			{ name: "garbage expires_at", row: ["garb1", "garbage", 0] },
			{ name: "date-prefix + garbage suffix expires_at", row: ["pfx1", "2026-01-01Tgarbage", 0] },
			{ name: "impossible-date expires_at (2026-99-99)", row: ["imp1", "2026-99-99T00:00:00", 0] },
			{ name: "year-0000 expires_at", row: ["zero1", "0000-00-00T00:00:00", 0] },
			{ name: "NULL delivered flag (past TTL)", relaxed: true, row: ["nulldel1", past, null] },
			{
				name: "empty-string delivered flag (past TTL)",
				relaxed: true,
				row: ["emptydel1", past, ""],
			},
			{
				name: "garbage delivered flag (past TTL)",
				relaxed: true,
				row: ["garbdel1", past, "garbage"],
			},
			{
				name: "delivered=2 flag (never written by release N, past TTL)",
				row: ["twodel1", past, 2],
			},
			{ name: "delivered=-1 flag (past TTL)", row: ["negdel1", past, -1] },
		];

		for (const c of liveCases) {
			it(`classifies ${c.name} as live AND the advertised SQL returns exactly that row`, () => {
				const db = createDatabase(dbPath);
				createLegacyRelayTable(db, "relay_outbox", c.relaxed ? { relaxed: true } : {});
				db.run(outboxInsert, [c.row[0], "peer", "result", "{}", past, c.row[1], c.row[2]]);

				const message = refusalMessage(db);
				const live = liveCountFromMessage(message);
				expect(live).toBe(1);

				// The advertised SQL must be valid against relay_outbox AND return exactly
				// the classifier-live rows: count returned == live count named (obj 1 — no
				// more would over-report, no fewer would omit indeterminate live rows the
				// round-2 `<flag> = 0 AND expires_at > now` SQL silently dropped). The
				// column list intentionally omits `id`, so identity is asserted via the
				// projected target_site_id — this row is the only one in the table.
				const sql = extractInspectionSql(message);
				const rows = db.query(sql).all() as { target_site_id: string }[];
				expect(rows.length).toBe(live);
				expect(rows.map((r) => r.target_site_id)).toContain("peer");

				db.close();
			});
		}

		it("advertised SQL returns exactly the live rows across a mixed table (obj 1)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox", { relaxed: true });
			// 4 live (ordinary unexpired, NULL expires, garbage expires, NULL flag),
			// 1 expired, 1 delivered → total 6; advertised SQL must return the 4 live.
			// Distinct target_site_id per row (the advertised SQL projects it, not id).
			const live: string[] = ["t_ord", "t_nullexp", "t_garb", "t_nullflag"];
			db.run(outboxInsert, ["L_ord", "t_ord", "result", "{}", past, future, 0]);
			db.run(outboxInsert, ["L_nullexp", "t_nullexp", "result", "{}", past, null, 0]);
			db.run(outboxInsert, ["L_garb", "t_garb", "result", "{}", past, "garbage", 0]);
			db.run(outboxInsert, ["L_nullflag", "t_nullflag", "result", "{}", past, past, null]);
			db.run(outboxInsert, ["exp1", "t_exp", "result", "{}", past, past, 0]);
			db.run(outboxInsert, ["del1", "t_del", "result", "{}", past, future, 1]);

			const message = refusalMessage(db);
			expect(liveCountFromMessage(message)).toBe(4);
			const sql = extractInspectionSql(message);
			const rows = db.query(sql).all() as { target_site_id: string }[];
			expect(rows.length).toBe(4);
			expect(new Set(rows.map((r) => r.target_site_id))).toEqual(new Set(live));

			db.close();
		});

		// --- Round 3, objection 2: a date-shaped PREFIX is not proof of a valid
		// timestamp. The round-2 GLOB `YYYY-MM-DDT*` accepted '2026-01-01Tgarbage',
		// '2026-99-99T...', '0000-00-00T...' — all of which can sort before now and be
		// wrongly dropped as expired. The full-shape GLOB + SQLite datetime() parse
		// must keep them live. (These specific values are also covered per-row above;
		// this test proves they are NOT swept into the drop path when alone.)
		// The full-shape GLOB + SQLite datetime() parse must keep them live. Only
		// values datetime() rejects (returns NULL) count here: '2026-99-99T...' and
		// '2026-13-01T...' (out-of-range month/day), '0000-00-00T...' (verified NULL,
		// so no year floor is needed), and '2026-01-01Tgarbage' (fails the shape GLOB).
		// NOTE: SQLite datetime() NORMALIZES an overflow day like '2026-02-31' to a
		// real instant ('2026-03-03'), so that IS provably expired and is covered by
		// the drop-path test below, not here — a genuine (if operator-typo'd) past
		// timestamp SQLite accepts is safe to drop.
		const notProvablyExpired = [
			"2026-01-01Tgarbage",
			"2026-99-99T00:00:00",
			"0000-00-00T00:00:00",
			"2026-13-01T00:00:00",
		];
		for (const bad of notProvablyExpired) {
			it(`refuses (does not drop) an undelivered row whose expires_at is ${bad}`, () => {
				const db = createDatabase(dbPath);
				createLegacyRelayTable(db, "relay_outbox");
				db.run(outboxInsert, ["b1", "peer", "result", "{}", past, bad, 0]);

				expect(() => applySchema(db)).toThrow(/1 live/i);
				// table must survive the refusal (not dropped)
				expect(
					db
						.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'")
						.get(),
				).not.toBeNull();

				db.close();
			});
		}

		it("still drops a genuinely expired ISO row (incident convergence preserved)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// A real, well-formed, past ISO timestamp is provably expired → drop + boot.
			db.run(outboxInsert, ["g1", "peer", "result", "{}", past, "2026-08-31T12:00:00.000Z", 0]);

			expect(() => applySchema(db)).not.toThrow();
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		// --- Round 3, objection 3: `<flag> != 0` treats '' and 'garbage' as consumed
		// on a non-STRICT (hand-migrated) table (both compare != 0 TRUE under SQLite
		// affinity). Release-N code wrote integer 1 for delivered/processed, so
		// consumed must require a PROVEN consumed marker (1 or '1'); everything else
		// falls through to expired-or-live. The '' / 'garbage' / 2 / -1 flag rows are
		// exercised as live cases above; here we pin the positive consumed values.
		it("treats delivered=1 (integer, release-N marker) as consumed → drops", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			db.run(outboxInsert, ["c1", "peer", "result", "{}", past, future, 1]);

			expect(() => applySchema(db)).not.toThrow();
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		it("treats delivered='1' (text, hand-migrated non-STRICT) as consumed → drops", () => {
			const db = createDatabase(dbPath);
			// relaxed → non-STRICT, so a text '1' can be stored in the delivered column.
			createLegacyRelayTable(db, "relay_outbox", { relaxed: true });
			db.run(outboxInsert, ["c1", "peer", "result", "{}", past, future, "1"]);

			expect(() => applySchema(db)).not.toThrow();
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		it("the createLegacyRelayTable default fixture is STRICT (obj 3 regression guard)", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			// STRICT tables carry an entry in the STRICT column of the schema pragma.
			const row = db
				.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='relay_outbox'")
				.get() as { sql: string } | null;
			expect(row).not.toBeNull();
			expect((row as { sql: string }).sql).toMatch(/STRICT/);
			db.close();
		});

		it("starts (no throw) when empty legacy relay tables are present", () => {
			const db = createDatabase(dbPath);
			createLegacyRelayTable(db, "relay_outbox");
			createLegacyRelayTable(db, "relay_inbox");

			expect(() => applySchema(db)).not.toThrow();
			expect(
				db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='relay_outbox'").get(),
			).toBeNull();

			db.close();
		});

		it("starts clean when the legacy tables are absent (post-4E host)", () => {
			const db = createDatabase(dbPath);
			expect(() => applySchema(db)).not.toThrow();
			db.close();
		});
	});

	it("verifies threads table has model_hint column", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(threads)").all() as Array<{
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
		}>;

		const columnNames = columns.map((c) => c.name);
		expect(columnNames).toContain("model_hint");

		const modelHintCol = columns.find((c) => c.name === "model_hint");
		expect(modelHintCol?.type).toBe("TEXT");
		expect(modelHintCol?.notnull).toBe(0); // nullable
		expect(modelHintCol?.dflt_value).toBeNull(); // no default

		db.close();
	});

	it("verifies messages table has correct columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;

		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("id");
		expect(columnNames).toContain("thread_id");
		expect(columnNames).toContain("role");
		expect(columnNames).toContain("content");
		expect(columnNames).toContain("model_id");
		expect(columnNames).toContain("tool_name");
		expect(columnNames).toContain("created_at");
		expect(columnNames).toContain("modified_at");
		expect(columnNames).toContain("host_origin");

		db.close();
	});

	it("verifies tasks table has all required columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;

		const columnNames = columns.map((c) => c.name);

		// Verify all task columns are present
		const requiredColumns = [
			"id",
			"type",
			"status",
			"trigger_spec",
			"payload",
			"created_at",
			"created_by",
			"thread_id",
			"claimed_by",
			"claimed_at",
			"lease_id",
			"next_run_at",
			"last_run_at",
			"run_count",
			"max_runs",
			"requires",
			"model_hint",
			"no_history",
			"inject_mode",
			"depends_on",
			"require_success",
			"alert_threshold",
			"consecutive_failures",
			"event_depth",
			"no_quiescence",
			"heartbeat_at",
			"result",
			"error",
			"modified_at",
			"deleted",
		];

		for (const col of requiredColumns) {
			expect(columnNames).toContain(col);
		}

		db.close();
	});

	it("defaults alert_threshold to 3 for new tasks", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const siteId = "test-site";
		const now = new Date().toISOString();

		insertRow(
			db,
			"tasks",
			{
				id: randomUUID(),
				type: "deferred",
				status: "pending",
				trigger_spec: "in 10m",
				payload: null,
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: now,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				// alert_threshold intentionally omitted to test DEFAULT
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
			},
			siteId,
		);

		const task = db.query("SELECT alert_threshold FROM tasks").get() as { alert_threshold: number };
		expect(task.alert_threshold).toBe(3);

		db.close();
	});

	it("verifies skills table has all required columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("id");
		expect(columnNames).toContain("name");
		expect(columnNames).toContain("description");
		expect(columnNames).not.toContain("status");
		expect(columnNames).toContain("skill_root");
		expect(columnNames).toContain("content_hash");
		expect(columnNames).toContain("allowed_tools");
		expect(columnNames).toContain("compatibility");
		expect(columnNames).toContain("metadata_json");
		expect(columnNames).toContain("activated_at");
		expect(columnNames).toContain("created_by_thread");
		expect(columnNames).toContain("activation_count");
		expect(columnNames).toContain("last_activated_at");
		expect(columnNames).not.toContain("retired_by");
		expect(columnNames).not.toContain("retired_reason");
		expect(columnNames).toContain("modified_at");
		expect(columnNames).toContain("deleted");

		db.close();
	});

	it("enforces unique index on active skill name", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO skills (id, name, description, skill_root, activation_count, modified_at, deleted)
			 VALUES ('id-1', 'pr-review', 'Review PRs', '/home/user/skills/pr-review', 0, ?, 0)`,
			[now],
		);

		// Inserting a second active skill with the same name must fail
		expect(() => {
			db.run(
				`INSERT INTO skills (id, name, description, skill_root, activation_count, modified_at, deleted)
				 VALUES ('id-2', 'pr-review', 'Duplicate', '/home/user/skills/pr-review', 0, ?, 0)`,
				[now],
			);
		}).toThrow();

		db.close();
	});

	it("insertRow and updateRow write change-log entries for skills table", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const siteId = "test-site";
		const skillId = randomUUID();
		const now = new Date().toISOString();

		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: "test-skill",
				description: "A test skill",
				skill_root: "/home/user/skills/test-skill",
				content_hash: null,
				allowed_tools: null,
				compatibility: null,
				metadata_json: null,
				activated_at: null,
				created_by_thread: null,
				activation_count: 0,
				last_activated_at: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(skillId) as Record<
			string,
			unknown
		>;
		expect(entry).toBeDefined();
		expect(entry.table_name).toBe("skills");

		updateRow(
			db,
			"skills",
			skillId,
			{ description: "Updated description", modified_at: now },
			siteId,
		);

		const entries = db
			.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY hlc")
			.all(skillId) as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(2);
		expect(entries[1].table_name).toBe("skills");

		db.close();
	});

	it("can insert and query data after applying schema", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const now = new Date().toISOString();

		db.run(
			`INSERT INTO users (id, display_name, first_seen_at, modified_at)
			VALUES (?, ?, ?, ?)`,
			["user-123", "Alice", now, now],
		);

		const user = db.query("SELECT * FROM users WHERE id = ?").get("user-123") as {
			id: string;
			display_name: string;
			first_seen_at: string;
			modified_at: string;
		};

		expect(user.id).toBe("user-123");
		expect(user.display_name).toBe("Alice");

		db.close();
	});
});

describe("platform-connectors Phase 1 migrations", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("AC1.1: users table has platform_ids column after applySchema", () => {
		// Create fresh in-memory DB and apply schema
		const db = createDatabase(":memory:");
		applySchema(db);
		const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toContain("platform_ids");
		db.close();
	});

	it("AC1.2: existing discord_id rows are migrated to platform_ids", () => {
		const db = createDatabase(":memory:");
		// Apply OLD schema (before platform_ids exists) by running the base
		// CREATE TABLE with discord_id but without platform_ids
		db.run(`
			CREATE TABLE IF NOT EXISTS users (
				id           TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				discord_id   TEXT,
				first_seen_at TEXT NOT NULL,
				modified_at  TEXT NOT NULL,
				deleted      INTEGER DEFAULT 0
			) STRICT
		`);
		db.run(`INSERT INTO users VALUES ('u1', 'Alice', '12345', '2026-01-01', '2026-01-01', 0)`);
		// Now run the full schema (triggers the migration)
		applySchema(db);
		const row = db.query("SELECT platform_ids FROM users WHERE id = 'u1'").get() as {
			platform_ids: string | null;
		};
		expect(row.platform_ids).toBe('{"discord":"12345"}');
		db.close();
	});

	it("AC1.3: discord_id column does not exist after applySchema", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).not.toContain("discord_id");
		db.close();
	});

	it("AC1.4: hosts table has platforms column after applySchema", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		const cols = db.query("PRAGMA table_info(hosts)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toContain("platforms");
		db.close();
	});

	it("AC1.5: threads table accepts non-web-non-discord interface values", () => {
		const db = createDatabase(":memory:");
		applySchema(db);
		// Insert a thread with interface = "telegram" â should not throw
		expect(() => {
			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, created_at, last_message_at, modified_at, deleted)
				 VALUES ('t1', 'u1', 'telegram', 'host1', 0, '2026-01-01', '2026-01-01', '2026-01-01', 0)`,
			);
		}).not.toThrow();
		const row = db.query("SELECT interface FROM threads WHERE id = 't1'").get() as {
			interface: string;
		};
		expect(row.interface).toBe("telegram");
		db.close();
	});

	it("drops skills.status / retired_by / retired_reason from an existing DB", () => {
		const db = createDatabase(":memory:");
		// Apply the OLD skills schema (with the status / retired_* columns) and
		// seed a live skill row, then run the full schema to trigger the drop.
		db.run(`
			CREATE TABLE IF NOT EXISTS skills (
				id                TEXT PRIMARY KEY,
				name              TEXT NOT NULL,
				description       TEXT NOT NULL,
				status            TEXT NOT NULL,
				skill_root        TEXT NOT NULL,
				content_hash      TEXT,
				allowed_tools     TEXT,
				compatibility     TEXT,
				metadata_json     TEXT,
				activated_at      TEXT,
				created_by_thread TEXT,
				activation_count  INTEGER DEFAULT 0,
				last_activated_at TEXT,
				retired_by        TEXT,
				retired_reason    TEXT,
				modified_at       TEXT NOT NULL,
				deleted           INTEGER DEFAULT 0
			) STRICT
		`);
		db.run(
			`INSERT INTO skills (id, name, description, status, skill_root, activation_count, modified_at, deleted)
			 VALUES ('s1', 'pr-review', 'Review PRs', 'active', '/home/user/skills/pr-review', 0, '2026-01-01', 0)`,
		);
		applySchema(db);

		const cols = db.query("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);
		expect(names).not.toContain("status");
		expect(names).not.toContain("retired_by");
		expect(names).not.toContain("retired_reason");
		// The row and its non-dropped data survive the migration.
		const row = db.query("SELECT name, skill_root FROM skills WHERE id = 's1'").get() as {
			name: string;
			skill_root: string;
		} | null;
		expect(row?.name).toBe("pr-review");
		expect(row?.skill_root).toBe("/home/user/skills/pr-review");
		db.close();
	});

	it("webhooks table has all required columns", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(webhooks)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		const requiredColumns = [
			"id",
			"name",
			"secret",
			"signature_format",
			"description",
			"task_id",
			"thread_id",
			"created_at",
			"deleted",
			"modified_at",
		];

		for (const col of requiredColumns) {
			expect(columnNames).toContain(col);
		}

		db.close();
	});

	it("enforces unique index on active webhook name", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
			 VALUES ('wh-1', 'my-webhook', 'secret123', 'github', 'test webhook', 'task-1', 'thread-1', ?, 0, ?)`,
			[now, now],
		);

		// Inserting a second active webhook with the same name must fail
		expect(() => {
			db.run(
				`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
				 VALUES ('wh-2', 'my-webhook', 'secret456', 'github', 'duplicate', 'task-2', 'thread-2', ?, 0, ?)`,
				[now, now],
			);
		}).toThrow();

		db.close();
	});

	it("allows soft-deleted webhook names to be reused", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		const now = new Date().toISOString();

		db.run(
			`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
			 VALUES ('wh-1', 'my-webhook', 'secret123', 'github', 'test webhook', 'task-1', 'thread-1', ?, 0, ?)`,
			[now, now],
		);

		// Soft-delete the first webhook
		db.run(`UPDATE webhooks SET deleted = 1 WHERE id = 'wh-1'`);

		// Inserting a second webhook with the same name should succeed (first is soft-deleted)
		expect(() => {
			db.run(
				`INSERT INTO webhooks (id, name, secret, signature_format, description, task_id, thread_id, created_at, deleted, modified_at)
				 VALUES ('wh-2', 'my-webhook', 'secret456', 'github', 'reused', 'task-2', 'thread-2', ?, 0, ?)`,
				[now, now],
			);
		}).not.toThrow();

		db.close();
	});

	it("tasks table has system_prompt_addition column", () => {
		const db = createDatabase(dbPath);
		applySchema(db);

		const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
		const columnNames = columns.map((c) => c.name);

		expect(columnNames).toContain("system_prompt_addition");

		db.close();
	});
});
