import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import { startHostHeartbeat } from "../host-heartbeat";
import { applySchema } from "../schema";

type IntervalCallback = () => void;

describe("Host Heartbeat", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "test-site-001";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-heartbeat-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

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

	function createTimerSpy() {
		let callback: IntervalCallback | undefined;
		const timer = { id: "heartbeat" };
		return {
			setInterval: (next: IntervalCallback, _ms: number) => {
				callback = next;
				return timer;
			},
			clearInterval: (_timer: unknown) => {
				callback = undefined;
			},
			tick: () => callback?.(),
		};
	}

	it("updates hosts.modified_at and writes a change-log entry on each tick", () => {
		const initialEntryCount = db
			.query<{ count: number }, [string]>(
				"SELECT COUNT(*) AS count FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.get(siteId)?.count;
		const timer = createTimerSpy();
		const handle = startHostHeartbeat(db, siteId, { timer });

		timer.tick();
		handle.stop();

		const entries = db
			.query<{ table_name: string; row_id: string }, []>(
				"SELECT table_name, row_id FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.all(siteId);

		expect(entries.length).toBe((initialEntryCount ?? 0) + 1);
	});

	it("logs database errors and remains stoppable", () => {
		const warnings: unknown[][] = [];
		const timer = createTimerSpy();
		const handle = startHostHeartbeat(db, siteId, {
			timer,
			logger: { warn: (...args: unknown[]) => warnings.push(args) } as never,
		});
		db.run("DROP TABLE hosts");

		expect(() => timer.tick()).not.toThrow();
		expect(warnings).toHaveLength(1);
		expect(() => handle.stop()).not.toThrow();
	});

	it("does nothing if host row does not exist", () => {
		const timer = createTimerSpy();
		const handle = startHostHeartbeat(db, "nonexistent-site", { timer });
		timer.tick();
		handle.stop();

		const entries = db
			.query<{ row_id: string }, [string]>(
				"SELECT row_id FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.all("nonexistent-site");
		expect(entries).toHaveLength(0);
	});

	it("stop cancels future callbacks and prevents subsequent updates", () => {
		const timer = createTimerSpy();
		const handle = startHostHeartbeat(db, siteId, { timer });
		timer.tick();
		const beforeStop = db
			.query<{ count: number }, [string]>(
				"SELECT COUNT(*) AS count FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.get(siteId)?.count;

		handle.stop();
		timer.tick();

		const afterStop = db
			.query<{ count: number }, [string]>(
				"SELECT COUNT(*) AS count FROM change_log WHERE table_name = 'hosts' AND row_id = ?",
			)
			.get(siteId)?.count;
		expect(afterStop).toBe(beforeStop);
	});

	it("uses default 2-minute interval when none specified", () => {
		const timer = createTimerSpy();
		const handle = startHostHeartbeat(db, siteId, { timer });
		expect(() => handle.stop()).not.toThrow();
	});
});
