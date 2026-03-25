import type { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { applySchema, type AppContext } from "@bound/core";
import { randomBytes } from "crypto";
import {
	findEligibleHosts,
	isHostStale,
	buildIdempotencyKey,
	createRelayOutboxEntry,
} from "../relay-router";

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-router-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("Relay Router", () => {
	describe("findEligibleHosts", () => {
		it("returns empty result when tool not available on any host (AC1.6)", () => {
			// Insert a host with different tools
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-1",
					"Remote Host 1",
					JSON.stringify(["other-tool"]),
					0,
					new Date().toISOString(),
					new Date().toISOString(),
				],
			);

			const result = findEligibleHosts(db, "nonexistent-tool", "local-site");
			expect(result.ok).toBe(false);
			expect((result as any).error).toContain("not available");
		});

		it("returns stale host info for offline hosts (AC1.7)", () => {
			const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-1",
					"Remote Host 1",
					JSON.stringify(["remote-tool"]),
					0,
					staleTime,
					new Date().toISOString(),
				],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(isHostStale(result.hosts[0])).toBe(true);
			}
		});

		it("excludes deleted hosts from routing", () => {
			const now = new Date().toISOString();
			// Deleted host
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["deleted-1", "Deleted Host", JSON.stringify(["remote-tool"]), 1, now, now],
			);

			// Active host with same tool
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["active-1", "Active Host", JSON.stringify(["remote-tool"]), 0, now, now],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("active-1");
			}
		});

		it("excludes local siteId from routing", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["local-site", "Local Host", JSON.stringify(["remote-tool"]), 0, now, now],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(false);
		});

		it("sorts hosts by online_at descending (most recent first)", () => {
			const now = new Date();
			const recentTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString(); // 1 min ago
			const olderTime = new Date(now.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"older-1",
					"Older Host",
					JSON.stringify(["remote-tool"]),
					0,
					olderTime,
					new Date().toISOString(),
				],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"recent-1",
					"Recent Host",
					JSON.stringify(["remote-tool"]),
					0,
					recentTime,
					new Date().toISOString(),
				],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].site_id).toBe("recent-1");
				expect(result.hosts[1].site_id).toBe("older-1");
			}
		});

		it("handles hosts with null online_at (sorted to end)", () => {
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["no-sync-1", "Never Synced", JSON.stringify(["remote-tool"]), 0, null, now],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["synced-1", "Synced Host", JSON.stringify(["remote-tool"]), 0, now, now],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].site_id).toBe("synced-1");
				expect(result.hosts[1].site_id).toBe("no-sync-1");
			}
		});
	});

	describe("isHostStale", () => {
		it("returns true for hosts with null online_at", () => {
			const host = {
				site_id: "test",
				host_name: "Test",
				sync_url: null,
				online_at: null,
			};
			expect(isHostStale(host)).toBe(true);
		});

		it("returns true for hosts not seen in 5+ minutes", () => {
			const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
			const host = {
				site_id: "test",
				host_name: "Test",
				sync_url: null,
				online_at: staleTime,
			};
			expect(isHostStale(host)).toBe(true);
		});

		it("returns false for recently synced hosts (< 5 min ago)", () => {
			const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
			const host = {
				site_id: "test",
				host_name: "Test",
				sync_url: null,
				online_at: recentTime,
			};
			expect(isHostStale(host)).toBe(false);
		});
	});

	describe("buildIdempotencyKey", () => {
		it("generates deterministic key for same inputs within same minute", () => {
			const key1 = buildIdempotencyKey("tool_call", "test-tool", { arg: "value" });
			const key2 = buildIdempotencyKey("tool_call", "test-tool", { arg: "value" });
			expect(key1).toBe(key2);
		});

		it("generates different keys for different inputs", () => {
			const key1 = buildIdempotencyKey("tool_call", "tool1", { arg: "value1" });
			const key2 = buildIdempotencyKey("tool_call", "tool2", { arg: "value1" });
			expect(key1).not.toBe(key2);
		});

		it("generates 32-character hex string", () => {
			const key = buildIdempotencyKey("tool_call", "test-tool", {});
			expect(key).toMatch(/^[0-9a-f]{32}$/);
		});
	});

	describe("createRelayOutboxEntry", () => {
		it("creates relay outbox entry with all required fields", () => {
			const entry = createRelayOutboxEntry(
				"target-site",
				"tool_call",
				JSON.stringify({ test: "payload" }),
				30_000,
			);

			expect(entry.target_site_id).toBe("target-site");
			expect(entry.kind).toBe("tool_call");
			expect(entry.id).toBeDefined();
			expect(entry.created_at).toBeDefined();
			expect(entry.expires_at).toBeDefined();
			expect(entry.payload).toContain("test");
		});

		it("sets expires_at to created_at + timeoutMs", () => {
			const before = Date.now();
			const entry = createRelayOutboxEntry(
				"target-site",
				"tool_call",
				"payload",
				30_000,
			);
			const after = Date.now();

			const createdTime = new Date(entry.created_at).getTime();
			const expiresTime = new Date(entry.expires_at).getTime();
			const diff = expiresTime - createdTime;

			// Should be approximately 30 seconds
			expect(diff).toBeGreaterThanOrEqual(29_900); // Allow small timing variations
			expect(diff).toBeLessThanOrEqual(30_100);
		});

		it("uses provided refId if given", () => {
			const refId = "custom-ref-id";
			const entry = createRelayOutboxEntry(
				"target-site",
				"tool_call",
				"payload",
				30_000,
				refId,
			);
			expect(entry.ref_id).toBe(refId);
		});

		it("uses provided idempotencyKey if given", () => {
			const key = "custom-key";
			const entry = createRelayOutboxEntry(
				"target-site",
				"tool_call",
				"payload",
				30_000,
				undefined,
				key,
			);
			expect(entry.idempotency_key).toBe(key);
		});

		it("generates UUID for id field", () => {
			const entry = createRelayOutboxEntry(
				"target-site",
				"tool_call",
				"payload",
				30_000,
			);
			// UUID v4 format check
			expect(entry.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
			);
		});
	});
});
