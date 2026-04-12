import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { PlatformConnectorConfig } from "@bound/shared";
import type { PlatformConnector } from "../connector.js";
import { PlatformLeaderElection } from "../leader-election.js";

// Mock connector for testing
class MockConnector implements PlatformConnector {
	readonly platform = "discord";
	readonly delivery = "broadcast" as const;
	connectCallCount = 0;
	disconnectCallCount = 0;
	disconnectError: Error | null = null;

	async connect(_hostBaseUrl?: string): Promise<void> {
		this.connectCallCount++;
	}

	async disconnect(): Promise<void> {
		this.disconnectCallCount++;
		if (this.disconnectError) {
			throw this.disconnectError;
		}
	}

	async deliver(): Promise<void> {
		// no-op for testing
	}
}

let db: Database;
let testDbPath: string;
let mockConnector: MockConnector;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-leader-election-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);

	mockConnector = new MockConnector();

	// Initialize cluster_hub for getHubSiteId() calls
	db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
		"cluster_hub",
		"hub-site-id",
		new Date().toISOString(),
	]);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("PlatformLeaderElection", () => {
	describe("AC5.1: Claims leadership when no leader exists", () => {
		it("should claim leadership and call connect() when cluster_config has no leader entry", async () => {
			const config: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 50,
				allowed_users: [],
			};

			const siteId = "site-1";
			const election = new PlatformLeaderElection(
				mockConnector,
				config,
				db,
				siteId,
				"https://localhost:3000",
			);

			await election.start();

			expect(election.isLeader()).toBe(true);
			expect(mockConnector.connectCallCount).toBe(1);

			// Verify cluster_config was written
			const leaderRow = db
				.query<{ value: string }, [string]>(
					"SELECT value FROM cluster_config WHERE key = ? LIMIT 1",
				)
				.get("platform_leader:discord");
			expect(leaderRow?.value).toBe(siteId);

			election.stop();
		});
	});

	describe("AC5.2: Enters standby when another host is already leader", () => {
		it("should not call connect() when another host is leader", async () => {
			const otherSiteId = "other-site";
			const now = new Date().toISOString();

			// Pre-insert leader entry for other host
			db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
				"platform_leader:discord",
				otherSiteId,
				now,
			]);

			// Insert hosts row for other site (needed for staleness check)
			db.run(
				"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
				[otherSiteId, "other-host", "https://other:3000", now, 0],
			);

			const config: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 50,
				allowed_users: [],
			};

			const siteId = "site-1";
			db.run(
				"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
				[siteId, "host-1", "https://localhost:3000", now, 0],
			);

			const election = new PlatformLeaderElection(mockConnector, config, db, siteId);

			await election.start();

			expect(election.isLeader()).toBe(false);
			expect(mockConnector.connectCallCount).toBe(0);

			election.stop();
		});
	});

	describe("AC5.3: Standby promotes when leader's modified_at is stale", () => {
		it("should promote to leader when leader is stale", async () => {
			const otherSiteId = "stale-leader";
			const selfSiteId = "site-1";
			const config: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 50,
				allowed_users: [],
			};

			// Pre-insert stale leader
			const now = new Date().toISOString();
			db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
				"platform_leader:discord",
				otherSiteId,
				now,
			]);

			// Insert stale host row (10 minutes old)
			const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			db.run(
				"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
				[otherSiteId, "stale-host", "https://stale:3000", staleTime, 0],
			);

			// Insert self host row
			db.run(
				"INSERT INTO hosts (site_id, host_name, sync_url, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
				[selfSiteId, "my-host", "https://localhost:3000", now, 0],
			);

			const election = new PlatformLeaderElection(mockConnector, config, db, selfSiteId);

			await election.start();

			// Should initially be standby
			expect(election.isLeader()).toBe(false);
			expect(mockConnector.connectCallCount).toBe(0);

			// Wait for failover check to run (failover_threshold_ms + buffer)
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Should have promoted to leader
			expect(election.isLeader()).toBe(true);
			expect(mockConnector.connectCallCount).toBe(1);

			election.stop();
		});
	});

	// AC5.4 (hosts.modified_at heartbeat) is now handled by startHostHeartbeat() in @bound/core.
	// See packages/core/src/__tests__/host-heartbeat.test.ts for coverage.

	describe("stop() cleanup", () => {
		it("should clear timers and call disconnect() on stop", async () => {
			const config: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 50,
				allowed_users: [],
			};

			const siteId = "site-1";
			const election = new PlatformLeaderElection(mockConnector, config, db, siteId);

			await election.start();
			expect(mockConnector.connectCallCount).toBe(1);

			election.stop();

			expect(mockConnector.disconnectCallCount).toBe(1);
			expect(election.isLeader()).toBe(false);
		});

		it("should handle disconnect errors gracefully", async () => {
			const config: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 50,
				allowed_users: [],
			};

			mockConnector.disconnectError = new Error("Disconnect failed");

			const siteId = "site-1";
			const election = new PlatformLeaderElection(mockConnector, config, db, siteId);

			await election.start();
			expect(mockConnector.connectCallCount).toBe(1);

			// Should not throw
			expect(() => election.stop()).not.toThrow();

			expect(mockConnector.disconnectCallCount).toBe(1);
		});
	});

	describe("idempotency", () => {
		it("should handle being called as leader multiple times", async () => {
			const config: PlatformConnectorConfig = {
				platform: "discord",
				failover_threshold_ms: 50,
				allowed_users: [],
			};

			const siteId = "site-1";
			const election = new PlatformLeaderElection(mockConnector, config, db, siteId);

			await election.start();
			expect(mockConnector.connectCallCount).toBe(1);
			expect(election.isLeader()).toBe(true);

			// Manually claim leadership again (simulates idempotent restart)
			const leaderKey = "platform_leader:discord";
			const leaderRow = db
				.query<{ value: string }, [string]>(
					"SELECT value FROM cluster_config WHERE key = ? LIMIT 1",
				)
				.get(leaderKey);
			expect(leaderRow?.value).toBe(siteId);

			election.stop();
		});
	});
});
