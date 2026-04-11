import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HLC_ZERO } from "@bound/shared";
import {
	type Changeset,
	deserializeChangeset,
	fetchInboundChangeset,
	fetchOutboundChangeset,
	serializeChangeset,
} from "../changeset.js";

describe("changeset", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");

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

		db.run(`
			CREATE TABLE sync_state (
				peer_site_id TEXT PRIMARY KEY,
				last_received TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sent TEXT NOT NULL DEFAULT '${HLC_ZERO}',
				last_sync_at TEXT,
				sync_errors INTEGER NOT NULL DEFAULT 0
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	describe("fetchOutboundChangeset", () => {
		it("fetches events where hlc > last_sent for a peer", () => {
			// Insert change log entries
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:00:00.000Z_0000_local-site",
					"messages",
					"msg-1",
					"local-site",
					"2026-03-22T10:00:00Z",
					JSON.stringify({}),
				],
			);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:01:00.000Z_0000_local-site",
					"messages",
					"msg-2",
					"local-site",
					"2026-03-22T10:01:00Z",
					JSON.stringify({}),
				],
			);

			// Set peer cursor to first HLC (last_sent)
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_sent, last_received)
				VALUES (?, ?, ?)`,
				["peer-site", "2026-03-22T10:00:00.000Z_0000_local-site", HLC_ZERO],
			);

			const changeset = fetchOutboundChangeset(db, "peer-site", "local-site");

			expect(changeset.events.length).toBe(1);
			expect(changeset.events[0].row_id).toBe("msg-2");
			expect(changeset.source_site_id).toBe("local-site");
			expect(changeset.source_hlc_start).toBe("2026-03-22T10:01:00.000Z_0000_local-site");
			expect(changeset.source_hlc_end).toBe("2026-03-22T10:01:00.000Z_0000_local-site");
		});

		it("includes events from all sites (not just local)", () => {
			// Insert events from different sites
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:00:00.000Z_0000_site-a",
					"messages",
					"msg-1",
					"site-a",
					"2026-03-22T10:00:00Z",
					JSON.stringify({}),
				],
			);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:01:00.000Z_0000_site-b",
					"messages",
					"msg-2",
					"site-b",
					"2026-03-22T10:01:00Z",
					JSON.stringify({}),
				],
			);

			const changeset = fetchOutboundChangeset(db, "peer-site", "hub-site");

			expect(changeset.events.length).toBe(2);
		});

		it("returns empty changeset when no new events", () => {
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:00:00.000Z_0000_local-site",
					"messages",
					"msg-1",
					"local-site",
					"2026-03-22T10:00:00Z",
					JSON.stringify({}),
				],
			);

			// Peer already has all events
			db.run(
				`INSERT INTO sync_state (peer_site_id, last_sent, last_received)
				VALUES (?, ?, ?)`,
				["peer-site", "2026-03-22T10:00:00.000Z_0000_local-site", HLC_ZERO],
			);

			const changeset = fetchOutboundChangeset(db, "peer-site", "local-site");

			expect(changeset.events.length).toBe(0);
		});
	});

	describe("fetchInboundChangeset", () => {
		it("fetches events with echo suppression", () => {
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:00:00.000Z_0000_remote-site",
					"messages",
					"msg-1",
					"remote-site",
					"2026-03-22T10:00:00Z",
					JSON.stringify({}),
				],
			);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:01:00.000Z_0000_local-site",
					"messages",
					"msg-2",
					"local-site",
					"2026-03-22T10:01:00Z",
					JSON.stringify({}),
				],
			);

			const changeset = fetchInboundChangeset(db, "local-site", HLC_ZERO);

			// Should only get msg-1 from remote-site, not msg-2 from local-site
			expect(changeset.events.length).toBe(1);
			expect(changeset.events[0].site_id).toBe("remote-site");
		});

		it("excludes events from requester site_id", () => {
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:00:00.000Z_0000_requester-site",
					"messages",
					"msg-1",
					"requester-site",
					"2026-03-22T10:00:00Z",
					JSON.stringify({}),
				],
			);

			const changeset = fetchInboundChangeset(db, "requester-site", HLC_ZERO);

			expect(changeset.events.length).toBe(0);
		});

		it("excludes events with hlc <= sinceHlc", () => {
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:00:00.000Z_0000_remote-site",
					"messages",
					"msg-1",
					"remote-site",
					"2026-03-22T10:00:00Z",
					JSON.stringify({}),
				],
			);
			db.run(
				`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
				VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"2026-03-22T10:01:00.000Z_0000_remote-site",
					"messages",
					"msg-2",
					"remote-site",
					"2026-03-22T10:01:00Z",
					JSON.stringify({}),
				],
			);

			const changeset = fetchInboundChangeset(
				db,
				"other-site",
				"2026-03-22T10:00:00.000Z_0000_remote-site",
			);

			expect(changeset.events.length).toBe(1);
			expect(changeset.events[0].row_id).toBe("msg-2");
		});
	});

	describe("serializeChangeset", () => {
		it("serializes changeset to JSON", () => {
			const changeset: Changeset = {
				events: [
					{
						hlc: "2026-03-22T10:00:00.000Z_0000_site-a",
						table_name: "messages",
						row_id: "msg-1",
						site_id: "site-a",
						timestamp: "2026-03-22T10:00:00Z",
						row_data: JSON.stringify({ id: "msg-1" }),
					},
				],
				source_site_id: "site-a",
				source_hlc_start: "2026-03-22T10:00:00.000Z_0000_site-a",
				source_hlc_end: "2026-03-22T10:00:00.000Z_0000_site-a",
			};

			const json = serializeChangeset(changeset);
			const parsed = JSON.parse(json);

			expect(parsed.events.length).toBe(1);
			expect(parsed.events[0].row_id).toBe("msg-1");
			expect(parsed.source_site_id).toBe("site-a");
		});
	});

	describe("deserializeChangeset", () => {
		it("deserializes JSON to changeset", () => {
			const json = JSON.stringify({
				events: [
					{
						hlc: "2026-03-22T10:00:00.000Z_0000_site-a",
						table_name: "messages",
						row_id: "msg-1",
						site_id: "site-a",
						timestamp: "2026-03-22T10:00:00Z",
						row_data: JSON.stringify({ id: "msg-1" }),
					},
				],
				source_site_id: "site-a",
				source_hlc_start: "2026-03-22T10:00:00.000Z_0000_site-a",
				source_hlc_end: "2026-03-22T10:00:00.000Z_0000_site-a",
			});

			const result = deserializeChangeset(json);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.events.length).toBe(1);
				expect(result.value.source_site_id).toBe("site-a");
			}
		});

		it("returns error for invalid JSON", () => {
			const result = deserializeChangeset("invalid json");

			expect(result.ok).toBe(false);
		});
	});

	describe("round-trip serialization", () => {
		it("preserves changeset data through serialize/deserialize", () => {
			const original: Changeset = {
				events: [
					{
						hlc: "2026-03-22T10:05:00.000Z_0005_hub-site",
						table_name: "semantic_memory",
						row_id: "mem-1",
						site_id: "hub-site",
						timestamp: "2026-03-22T10:05:00Z",
						row_data: JSON.stringify({ id: "mem-1", value: "test" }),
					},
				],
				source_site_id: "hub-site",
				source_hlc_start: "2026-03-22T10:05:00.000Z_0005_hub-site",
				source_hlc_end: "2026-03-22T10:05:00.000Z_0005_hub-site",
			};

			const json = serializeChangeset(original);
			const result = deserializeChangeset(json);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.events[0].hlc).toBe("2026-03-22T10:05:00.000Z_0005_hub-site");
				expect(result.value.events[0].row_data).toBe(
					JSON.stringify({ id: "mem-1", value: "test" }),
				);
				expect(result.value.source_site_id).toBe("hub-site");
			}
		});
	});
});
