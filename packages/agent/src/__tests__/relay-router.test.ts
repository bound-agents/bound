import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, isHostFresh } from "@bound/core";
import { findEligibleHosts, findEligibleHostsByModel } from "../relay-router";
// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-relay-router-${testId}.db`);
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
		require("node:fs").unlinkSync(testDbPath);
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
			if (!result.ok) {
				expect(result.error).toContain("not available");
			}
		});

		it("returns stale host info for offline hosts (AC1.7)", () => {
			const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["remote-1", "Remote Host 1", JSON.stringify(["remote-tool"]), 0, staleTime, staleTime],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(isHostFresh(result.hosts[0])).toBe(false);
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

		it("sorts hosts by freshness descending (most recent first)", () => {
			const now = new Date();
			const recentTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString(); // 1 min ago
			const olderTime = new Date(now.getTime() - 3 * 60 * 1000).toISOString(); // 3 min ago

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["older-1", "Older Host", JSON.stringify(["remote-tool"]), 0, olderTime, olderTime],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["recent-1", "Recent Host", JSON.stringify(["remote-tool"]), 0, recentTime, recentTime],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].site_id).toBe("recent-1");
				expect(result.hosts[1].site_id).toBe("older-1");
			}
		});

		it("sorts stale hosts after fresh hosts", () => {
			const now = new Date().toISOString();
			const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["stale-1", "Stale Host", JSON.stringify(["remote-tool"]), 0, staleTime, staleTime],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, mcp_tools, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["fresh-1", "Fresh Host", JSON.stringify(["remote-tool"]), 0, now, now],
			);

			const result = findEligibleHosts(db, "remote-tool", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].site_id).toBe("fresh-1");
				expect(result.hosts[1].site_id).toBe("stale-1");
			}
		});
	});

	describe("findEligibleHostsByModel", () => {
		it("returns empty result when model not available on any host (AC2.2)", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-1",
					"Remote Host 1",
					JSON.stringify(["claude-opus", "claude-sonnet"]),
					0,
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-haiku", "local-site");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("not available");
			}
		});

		it("returns matching host for model present on remote (AC2.2)", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"remote-1",
					"Remote Host 1",
					JSON.stringify(["claude-opus", "claude-sonnet"]),
					0,
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("remote-1");
				expect(result.hosts[0].host_name).toBe("Remote Host 1");
			}
		});

		it("orders live hosts by stable RouteId, not heartbeat freshness (R-RT8)", () => {
			// Freshness gates liveness only; it never breaks ties between live routes.
			// The lexically-smaller route_id wins regardless of which host is newer.
			const now = new Date();
			const recentTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString(); // 1 min ago
			const olderTime = new Date(now.getTime() - 3 * 60 * 1000).toISOString(); // 3 min ago

			// "recent-host" is fresher but advertises a lexically-larger route_id.
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"recent-host",
					"Recent Host",
					JSON.stringify([{ id: "claude-opus", route_id: "recent-host:bedrock:claude-opus" }]),
					0,
					recentTime,
					recentTime,
				],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"older-host",
					"Older Host",
					JSON.stringify([{ id: "claude-opus", route_id: "older-host:bedrock:claude-opus" }]),
					0,
					olderTime,
					olderTime,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(2);
				// older-host:... < recent-host:... lexically, even though recent-host is fresher.
				expect(result.hosts[0].site_id).toBe("older-host");
				expect(result.hosts[1].site_id).toBe("recent-host");
			}
		});

		it("filters out stale hosts (modified_at older than 5 min) (AC2.5)", () => {
			const now = new Date();
			const freshTime = new Date(now.getTime() - 2 * 60 * 1000).toISOString(); // 2 min ago
			const staleTime = new Date(now.getTime() - 6 * 60 * 1000).toISOString(); // 6 min ago

			// Fresh host with model (modified_at is recent — heartbeat keeps this fresh)
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["fresh-host", "Fresh Host", JSON.stringify(["claude-opus"]), 0, freshTime, freshTime],
			);

			// Stale host: both online_at and modified_at are old
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["stale-host", "Stale Host", JSON.stringify(["claude-opus"]), 0, staleTime, staleTime],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("fresh-host");
			}
		});

		it("returns error when all matching hosts are stale (AC2.5)", () => {
			const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["stale-host", "Stale Host", JSON.stringify(["claude-opus"]), 0, staleTime, staleTime],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("not available");
			}
		});

		it("considers host fresh when modified_at is recent even if online_at is stale (AC2.5)", () => {
			const now = new Date();
			const bootTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
			const heartbeatTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString(); // 1 min ago

			// Host booted 10 min ago (stale online_at) but heartbeat bumped modified_at 1 min ago
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"heartbeat-host",
					"Heartbeat Host",
					JSON.stringify(["claude-opus"]),
					0,
					bootTime,
					heartbeatTime,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("heartbeat-host");
			}
		});

		it("includes host with null online_at but fresh modified_at (AC2.5)", () => {
			const now = new Date().toISOString();

			// Host with null online_at but fresh modified_at (heartbeat-only, never set online_at)
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["heartbeat-only", "Heartbeat Only", JSON.stringify(["claude-opus"]), 0, null, now],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("heartbeat-only");
			}
		});

		it("excludes deleted hosts", () => {
			const now = new Date().toISOString();

			// Deleted host
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["deleted-host", "Deleted", JSON.stringify(["claude-opus"]), 1, now, now],
			);

			// Active host
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["active-host", "Active", JSON.stringify(["claude-opus"]), 0, now, now],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("active-host");
			}
		});

		it("excludes local siteId from routing", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["local-site", "Local Host", JSON.stringify(["claude-opus"]), 0, now, now],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(false);
		});

		it("handles hosts with malformed models JSON", () => {
			const now = new Date().toISOString();

			// Host with malformed JSON
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["bad-host", "Bad Host", "not json", 0, now, now],
			);

			// Valid host
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["good-host", "Good Host", JSON.stringify(["claude-opus"]), 0, now, now],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("good-host");
			}
		});

		it("handles hosts with null models column", () => {
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["null-host", "Null Models Host", null, 0, now, now],
			);

			const result = findEligibleHostsByModel(db, "claude-opus", "local-site");
			expect(result.ok).toBe(false);
		});
	});

	describe("Phase 6: capability metadata in hosts.models", () => {
		it("legacy string-format hosts remain eligible for unconstrained requests (AC7.3, AC7.4)", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["legacy-host", "Legacy Host", JSON.stringify(["claude-3"]), 0, now, now],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].unverified).toBe(true);
			}
		});

		it("object-format HostModelEntry carries the advertised output-token ceiling", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (site_id, host_name, sync_url, models, online_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, 0)`,
				[
					"remote-output-cap",
					"Remote Output Cap",
					"https://remote.example",
					JSON.stringify([
						{
							id: "fable",
							max_output_tokens: 64_000,
							capabilities: { max_context: 700_000, tool_use: true },
						},
					]),
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "fable", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.hosts[0]?.maxOutputTokens).toBe(64_000);
		});

		it("object-format HostModelEntry is parsed and returned with capabilities (AC7.1)", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"verified-host",
					"Verified Host",
					JSON.stringify([
						{
							id: "claude-3",
							route_id: "verified-host:bedrock:claude-3",
							capabilities: {
								vision: true,
								tool_use: true,
								system_prompt: true,
								prompt_caching: false,
							},
						},
					]),
					0,
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].unverified).toBe(false);
				expect(result.hosts[0].capabilities?.vision).toBe(true);
				expect(result.hosts[0].capabilities?.tool_use).toBe(true);
				expect(result.hosts[0].routeId).toBe("verified-host:bedrock:claude-3");
			}
		});

		it("excludes object-format hosts lacking vision capability when requirements.vision is set (AC7.2)", () => {
			const now = new Date().toISOString();

			// Host with vision: false
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"no-vision-host",
					"No Vision Host",
					JSON.stringify([
						{
							id: "claude-3",
							capabilities: { vision: false, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			// Host with vision: true
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"vision-host",
					"Vision Host",
					JSON.stringify([
						{
							id: "claude-3",
							capabilities: { vision: true, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site", { vision: true });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].capabilities?.vision).toBe(true);
				expect(result.hosts[0].site_id).toBe("vision-host");
			}
		});

		it("uses unverified hosts as fallback when no verified capability match exists (AC7.3)", () => {
			const now = new Date().toISOString();

			// Verified host with vision: false
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"verified-no-vision",
					"Verified No Vision",
					JSON.stringify([
						{
							id: "claude-3",
							capabilities: { vision: false, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			// Legacy string format (unverified)
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["legacy-fallback", "Legacy Fallback", JSON.stringify(["claude-3"]), 0, now, now],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site", { vision: true });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts[0].unverified).toBe(true);
				expect(result.hosts[0].site_id).toBe("legacy-fallback");
			}
		});

		it("handles mixed string/object entries in hosts.models without error (AC7.4)", () => {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"mixed-host",
					"Mixed Host",
					JSON.stringify([
						"old-model",
						{
							id: "new-model",
							capabilities: { vision: true, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			const r1 = findEligibleHostsByModel(db, "old-model", "local-site");
			const r2 = findEligibleHostsByModel(db, "new-model", "local-site");
			expect(r1.ok).toBe(true);
			expect(r2.ok).toBe(true);
			if (r1.ok) expect(r1.hosts[0].unverified).toBe(true);
			if (r2.ok) expect(r2.hosts[0].unverified).toBe(false);
		});

		it("orders verified hosts by stable RouteId, not tier or freshness (R-RT8)", () => {
			const now = new Date();
			const recentTime = new Date(now.getTime() - 1 * 60 * 1000).toISOString(); // 1 min ago
			const olderTime = new Date(now.getTime() - 3 * 60 * 1000).toISOString(); // 3 min ago

			// "charlie" host is fresher but sorts last by RouteId. tier is gone;
			// freshness gates liveness only. The three live routes come back in
			// lexical route_id order: alpha, bravo, charlie.
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"charlie",
					"Charlie",
					JSON.stringify([
						{
							id: "claude-3",
							route_id: "charlie:bedrock:claude-3",
							capabilities: { vision: true, tool_use: true },
						},
					]),
					0,
					recentTime,
					recentTime,
				],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"alpha",
					"Alpha",
					JSON.stringify([
						{
							id: "claude-3",
							route_id: "alpha:bedrock:claude-3",
							capabilities: { vision: true, tool_use: true },
						},
					]),
					0,
					olderTime,
					olderTime,
				],
			);

			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"bravo",
					"Bravo",
					JSON.stringify([
						{
							id: "claude-3",
							route_id: "bravo:bedrock:claude-3",
							capabilities: { vision: true, tool_use: true },
						},
					]),
					0,
					recentTime,
					recentTime,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.map((h) => h.site_id)).toEqual(["alpha", "bravo", "charlie"]);
			}
		});

		it("filters by tool_use requirement", () => {
			const now = new Date().toISOString();

			// Host without tool_use
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"no-tools-host",
					"No Tools Host",
					JSON.stringify([
						{
							id: "claude-3",
							capabilities: { vision: true, tool_use: false },
						},
					]),
					0,
					now,
					now,
				],
			);

			// Host with tool_use
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"with-tools-host",
					"With Tools Host",
					JSON.stringify([
						{
							id: "claude-3",
							capabilities: { vision: true, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site", { tool_use: true });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.hosts.length).toBe(1);
				expect(result.hosts[0].site_id).toBe("with-tools-host");
			}
		});

		it("returns verified hosts before unverified when requirements set", () => {
			const now = new Date().toISOString();

			// Unverified (legacy string)
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				["legacy-host", "Legacy Host", JSON.stringify(["claude-3"]), 0, now, now],
			);

			// Verified but no vision
			db.run(
				`INSERT INTO hosts (
					site_id, host_name, models, deleted, online_at, modified_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"verified-no-vision",
					"Verified No Vision",
					JSON.stringify([
						{
							id: "claude-3",
							capabilities: { vision: false, tool_use: true },
						},
					]),
					0,
					now,
					now,
				],
			);

			const result = findEligibleHostsByModel(db, "claude-3", "local-site", { vision: true });
			expect(result.ok).toBe(true);
			if (result.ok) {
				// Fallback to unverified since no verified match with vision
				expect(result.hosts[0].unverified).toBe(true);
			}
		});
	});
});
