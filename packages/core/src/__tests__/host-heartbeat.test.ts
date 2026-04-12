import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import { startHostHeartbeat } from "../host-heartbeat";
import { applySchema } from "../schema";

describe("Host Heartbeat", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "test-site-001";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-heartbeat-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		// Insert a host row for our test site
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			[siteId, "test-host", now, now],
		);
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

	it("updates hosts.modified_at on each tick", async () => {
		const initial = db
			.query<{ modified_at: string }, [string]>("SELECT modified_at FROM hosts WHERE site_id = ?")
			.get(siteId);
		expect(initial).toBeDefined();
		const initialTime = new Date(initial?.modified_at ?? "").getTime();

		const handle = startHostHeartbeat(db, siteId, { intervalMs: 30 });

		// Wait for at least one tick
		await new Promise((resolve) => setTimeout(resolve, 80));

		handle.stop();

		const updated = db
			.query<{ modified_at: string }, [string]>("SELECT modified_at FROM hosts WHERE site_id = ?")
			.get(siteId);
		expect(updated).toBeDefined();
		const updatedTime = new Date(updated?.modified_at ?? "").getTime();

		expect(updatedTime).toBeGreaterThan(initialTime);
	});

	it("creates change_log entries with full row data", async () => {
		const handle = startHostHeartbeat(db, siteId, { intervalMs: 30 });

		await new Promise((resolve) => setTimeout(resolve, 80));

		handle.stop();

		const entries = db
			.query<{ table_name: string; row_id: string; row_data: string }, []>(
				"SELECT table_name, row_id, row_data FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.all(siteId);

		expect(entries.length).toBeGreaterThanOrEqual(1);

		// Verify the row_data contains the full row snapshot, not just modified_at
		const lastEntry = entries[entries.length - 1];
		const rowData = JSON.parse(lastEntry.row_data);
		expect(rowData.site_id).toBe(siteId);
		expect(rowData.host_name).toBe("test-host");
		expect(rowData.modified_at).toBeDefined();
	});

	it("stop() clears the timer and prevents further updates", async () => {
		const handle = startHostHeartbeat(db, siteId, { intervalMs: 30 });

		await new Promise((resolve) => setTimeout(resolve, 80));
		handle.stop();

		const afterStop = db
			.query<{ modified_at: string }, [string]>("SELECT modified_at FROM hosts WHERE site_id = ?")
			.get(siteId);
		const stoppedTime = new Date(afterStop?.modified_at ?? "").getTime();

		// Wait another interval — should NOT update
		await new Promise((resolve) => setTimeout(resolve, 80));

		const afterWait = db
			.query<{ modified_at: string }, [string]>("SELECT modified_at FROM hosts WHERE site_id = ?")
			.get(siteId);
		const waitTime = new Date(afterWait?.modified_at ?? "").getTime();

		expect(waitTime).toBe(stoppedTime);
	});

	it("survives DB errors without crashing", async () => {
		const handle = startHostHeartbeat(db, siteId, { intervalMs: 30 });

		// Drop the hosts table to force a DB error on next tick
		db.run("DROP TABLE hosts");

		// Wait for a tick — should not throw
		await new Promise((resolve) => setTimeout(resolve, 80));

		// Should still be stoppable without error
		expect(() => handle.stop()).not.toThrow();
	});

	it("does nothing if host row does not exist", async () => {
		const fakeSiteId = "nonexistent-site";
		const handle = startHostHeartbeat(db, fakeSiteId, { intervalMs: 30 });

		await new Promise((resolve) => setTimeout(resolve, 80));

		// No change_log entries for the fake site
		const entries = db
			.query<{ row_id: string }, [string]>(
				"SELECT row_id FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.all(fakeSiteId);

		expect(entries.length).toBe(0);

		handle.stop();
	});

	it("uses default 2-minute interval when none specified", () => {
		const handle = startHostHeartbeat(db, siteId);

		// Can't easily test the interval value, but verify it starts and stops cleanly
		expect(() => handle.stop()).not.toThrow();
	});
});
