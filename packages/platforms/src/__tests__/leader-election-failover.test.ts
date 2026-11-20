import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { PlatformLeaderElection, platformMetricName } from "../leader-election.js";

// Covers the failure/transition branches leader-election.test.ts leaves cold:
// the claimLeadership connect-rejection unwind, the ownership-watch disconnect
// failure log ("ownership_replaced"), and the standby-staleness takeover when
// the current leader's hosts row has vanished entirely.

let db: Database;
let testDbPath: string;

const createCapturingLogger = () => {
	const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: (message, context) => warnings.push({ message, context }),
		error: () => {},
		isLevelEnabled: () => true,
	};
	return { logger, warnings };
};

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-leader-failover-${testId}.db`);
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// already deleted
	}
});

const config: PlatformConnectorConfig = {
	platform: "discord",
	failover_threshold_ms: 50,
	allowed_users: [],
};

describe("platformMetricName", () => {
	it("maps known platforms to themselves and unknown ones to 'other'", () => {
		expect(platformMetricName("discord")).toBe("discord");
		expect(platformMetricName("rss")).toBe("rss");
		expect(platformMetricName("discord-interaction")).toBe("discord-interaction");
		expect(platformMetricName("telegram")).toBe("other");
	});
});

describe("claimLeadership failure unwind", () => {
	it("resets the leader flag and rethrows when connect() rejects", async () => {
		const connector = {
			platform: "discord",
			connect: async () => {
				throw new Error("gateway login failed");
			},
			disconnect: async () => {},
		};
		const election = new PlatformLeaderElection(connector, config, db, "site-1");

		await expect(election.start()).rejects.toThrow("gateway login failed");
		// The claim wrote cluster_config, but the connect rejection must leave the
		// host NOT believing it is leader.
		expect(election.isLeader()).toBe(false);
		election.stop();
	});
});

describe("ownership watch disconnect-failure logging", () => {
	it("logs 'ownership_replaced' when the deposed leader's disconnect throws", async () => {
		const { logger, warnings } = createCapturingLogger();
		let connectCalls = 0;
		const connector = {
			platform: "discord",
			connect: async () => {
				connectCalls++;
			},
			disconnect: async () => {
				throw new Error("disconnect boom");
			},
		};
		const self = "site-1";
		const usurper = "usurper-site";
		const now = new Date().toISOString();
		// Usurper's heartbeat pinned fresh so the demoted host stays in standby
		// rather than immediately re-promoting through the staleness path.
		const fresh = new Date(Date.now() + 60_000).toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
			[self, "my-host", "https://localhost:3000", now, 0],
		);
		db.run(
			"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
			[usurper, "usurper-host", "https://usurper:3000", fresh, 0],
		);

		const election = new PlatformLeaderElection(connector, config, db, self, undefined, logger);
		await election.start();
		expect(election.isLeader()).toBe(true);
		expect(connectCalls).toBe(1);

		// Another site takes the seat (LWW), delivered via sync.
		db.run("UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?", [
			usurper,
			new Date().toISOString(),
			"platform_leader:discord",
		]);

		// Ownership watch (threshold/3 ≈ 16ms) notices and steps down; disconnect throws.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(election.isLeader()).toBe(false);
		expect(warnings).toContainEqual({
			message: "Platform leader connector disconnect failed",
			context: {
				platform: "discord",
				site_id: self,
				reason: "ownership_replaced",
				error: "disconnect boom",
			},
		});
		election.stop();
	});
});

describe("standby takeover when leader host record is gone", () => {
	it("claims leadership when the leader's hosts row has vanished", async () => {
		let connectCalls = 0;
		const connector = {
			platform: "discord",
			connect: async () => {
				connectCalls++;
			},
			disconnect: async () => {},
		};
		const self = "site-1";
		const ghostLeader = "ghost-leader";
		const now = new Date().toISOString();
		// cluster_config names ghostLeader, but there is NO hosts row for it — the
		// staleness JOIN returns nothing, which is the "leader host record gone"
		// branch that takes over immediately rather than waiting out a threshold.
		db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
			"platform_leader:discord",
			ghostLeader,
			now,
		]);
		db.run(
			"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
			[self, "my-host", "https://localhost:3000", now, 0],
		);

		const election = new PlatformLeaderElection(connector, config, db, self);
		await election.start();
		// No hosts row named us as leader; we enter standby.
		expect(election.isLeader()).toBe(false);

		// Staleness check fires (threshold/3 ≈ 16ms); the missing leader host row
		// triggers an immediate claim.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(election.isLeader()).toBe(true);
		expect(connectCalls).toBe(1);

		const leaderRow = db
			.query<{ value: string }, [string]>("SELECT value FROM cluster_config WHERE key = ? LIMIT 1")
			.get("platform_leader:discord");
		expect(leaderRow?.value).toBe(self);
		election.stop();
	});
});
