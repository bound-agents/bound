import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHlc } from "@bound/shared";
import { createChangeLogEntry, insertRow } from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("HLC Change Log", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "aaaa1111aaaa1111aaaa1111aaaa1111";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("creates change_log entries with HLC primary key instead of seq", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		createChangeLogEntry(db, "users", userId, siteId, {
			id: userId,
			display_name: "Alice",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		});

		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(userId) as Record<
			string,
			unknown
		>;

		expect(entry).toBeDefined();
		// Must have hlc column, not seq
		expect(entry.hlc).toBeDefined();
		expect(typeof entry.hlc).toBe("string");
		expect(entry.seq).toBeUndefined();

		// HLC must be parseable
		const [ts, counter, hlcSiteId] = parseHlc(entry.hlc as string);
		expect(ts).toBeDefined();
		expect(counter).toBe("0000");
		expect(hlcSiteId).toBe(siteId);
	});

	it("generates monotonically increasing HLCs across multiple entries", () => {
		const now = new Date().toISOString();

		for (let i = 0; i < 5; i++) {
			const id = randomUUID();
			insertRow(
				db,
				"users",
				{
					id,
					display_name: `User${i}`,
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}

		const entries = db.query("SELECT hlc FROM change_log ORDER BY hlc ASC").all() as Array<{
			hlc: string;
		}>;

		expect(entries.length).toBe(5);
		for (let i = 1; i < entries.length; i++) {
			expect(entries[i].hlc > entries[i - 1].hlc).toBe(true);
		}
	});

	it("embeds site_id in the HLC value", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Bob",
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const entry = db.query("SELECT hlc FROM change_log WHERE row_id = ?").get(userId) as {
			hlc: string;
		};

		const [, , hlcSiteId] = parseHlc(entry.hlc);
		expect(hlcSiteId).toBe(siteId);
	});

	it("ORDER BY hlc preserves insertion order", () => {
		const now = new Date().toISOString();
		const ids: string[] = [];

		for (let i = 0; i < 3; i++) {
			const id = randomUUID();
			ids.push(id);
			insertRow(
				db,
				"users",
				{
					id,
					display_name: `User${i}`,
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}

		const entries = db.query("SELECT row_id FROM change_log ORDER BY hlc ASC").all() as Array<{
			row_id: string;
		}>;

		expect(entries.map((e) => e.row_id)).toEqual(ids);
	});

	it("fresh install schema has hlc TEXT PRIMARY KEY on change_log", () => {
		const tableInfo = db.query("PRAGMA table_info(change_log)").all() as Array<{
			name: string;
			type: string;
			pk: number;
		}>;

		const hlcCol = tableInfo.find((c) => c.name === "hlc");
		expect(hlcCol).toBeDefined();
		expect(hlcCol?.type).toBe("TEXT");
		expect(hlcCol?.pk).toBe(1);

		const seqCol = tableInfo.find((c) => c.name === "seq");
		expect(seqCol).toBeUndefined();
	});

	it("fresh install schema has TEXT cursors on sync_state", () => {
		const tableInfo = db.query("PRAGMA table_info(sync_state)").all() as Array<{
			name: string;
			type: string;
		}>;

		const lastReceived = tableInfo.find((c) => c.name === "last_received");
		expect(lastReceived).toBeDefined();
		expect(lastReceived?.type).toBe("TEXT");

		const lastSent = tableInfo.find((c) => c.name === "last_sent");
		expect(lastSent).toBeDefined();
		expect(lastSent?.type).toBe("TEXT");
	});

	it("createChangeLogEntry with remoteHlc produces HLC greater than remote", () => {
		const remoteHlc = "2099-12-31T23:59:59.999Z_0005_bbbb2222bbbb2222bbbb2222bbbb2222";

		const userId = randomUUID();
		createChangeLogEntry(db, "users", userId, siteId, { id: userId }, remoteHlc);

		const entry = db.query("SELECT hlc FROM change_log WHERE row_id = ?").get(userId) as {
			hlc: string;
		};

		expect(entry.hlc > remoteHlc).toBe(true);

		const [, , hlcSiteId] = parseHlc(entry.hlc);
		expect(hlcSiteId).toBe(siteId);
	});
});
