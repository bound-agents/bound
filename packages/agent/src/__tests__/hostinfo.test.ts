import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { hostinfo } from "../commands/hostinfo";

describe("hostinfo command", () => {
	let tmpDir: string;
	let db: Database;
	let ctx: CommandContext;
	let localSiteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "hostinfo-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);

		localSiteId = "local-site-0001";
		db.run("INSERT OR REPLACE INTO host_meta (key, value) VALUES ('site_id', ?)", [localSiteId]);

		ctx = {
			db,
			siteId: localSiteId,
			eventBus: new TypedEventEmitter(),
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: randomUUID(),
			taskId: randomUUID(),
		} as unknown as CommandContext;
	});

	beforeEach(() => {
		// Clean tables between tests
		db.run("DELETE FROM hosts");
		db.run("DELETE FROM sync_state");
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM advisories");
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
	});

	function insertHost(
		siteId: string,
		hostName: string,
		opts: {
			modifiedAt?: string;
			onlineAt?: string;
			syncUrl?: string;
			models?: string;
			mcpServers?: string;
		} = {},
	) {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, sync_url, models, mcp_servers, mcp_tools, online_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			[
				siteId,
				hostName,
				opts.syncUrl ?? null,
				opts.models ?? null,
				opts.mcpServers ?? null,
				null,
				opts.onlineAt ?? opts.modifiedAt ?? now,
				opts.modifiedAt ?? now,
			],
		);
	}

	describe("Phase 1: per-node cluster health stats", () => {
		it("shows (local) marker for this node's site_id", async () => {
			insertHost(localSiteId, "my-host");
			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("my-host (local)");
		});

		it("shows ONLINE status for recently modified host", async () => {
			insertHost(localSiteId, "my-host");
			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("ONLINE");
		});

		it("shows STALE status when modified_at is old", async () => {
			const oldDate = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10min ago
			insertHost("remote-site", "old-host", { modifiedAt: oldDate });
			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("STALE");
		});

		it("shows sync health for remote peer", async () => {
			const remoteSite = "remote-site-1234";
			insertHost(remoteSite, "remote-host", { syncUrl: "http://remote:3000" });
			db.run("INSERT INTO sync_state (peer_site_id, sync_errors, last_sync_at) VALUES (?, ?, ?)", [
				remoteSite,
				3,
				new Date().toISOString(),
			]);

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("sync:");
			expect(result.stdout).toContain("3 errors");
		});

		it("shows task stats per host", async () => {
			insertHost(localSiteId, "my-host");
			// Insert some tasks claimed by this host
			const now = new Date().toISOString();
			for (let i = 0; i < 3; i++) {
				db.run(
					`INSERT INTO tasks (id, type, status, trigger_spec, claimed_by, consecutive_failures, created_at, modified_at, deleted)
					 VALUES (?, 'cron', 'pending', '*/5 * * * *', ?, ?, ?, ?, 0)`,
					[randomUUID(), localSiteId, i === 0 ? 2 : 0, now, now],
				);
			}

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("tasks:");
			expect(result.stdout).toContain("3 claimed");
			expect(result.stdout).toContain("1 failing");
		});

		it("shows message counts per host_origin in last hour", async () => {
			insertHost(localSiteId, "my-host");
			const now = new Date().toISOString();
			for (let i = 0; i < 5; i++) {
				db.run(
					`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
					 VALUES (?, ?, 'assistant', 'msg', ?, ?, ?, 0)`,
					[randomUUID(), randomUUID(), now, now, "my-host"],
				);
			}

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("messages:");
			expect(result.stdout).toContain("5/hr");
		});

		it("shows open advisory count per node", async () => {
			insertHost(localSiteId, "my-host");
			for (let i = 0; i < 2; i++) {
				db.run(
					`INSERT INTO advisories (id, type, status, title, detail, proposed_at, created_by, modified_at, deleted)
					 VALUES (?, 'general', 'proposed', 'test', 'detail', ?, ?, ?, 0)`,
					[randomUUID(), new Date().toISOString(), localSiteId, new Date().toISOString()],
				);
			}

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("advisories:");
			expect(result.stdout).toContain("2 open");
		});

		it("shows 0 claimed when host has no tasks", async () => {
			insertHost(localSiteId, "my-host");
			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("0 claimed");
		});

		it("shows 0/hr when host has no recent messages", async () => {
			insertHost(localSiteId, "my-host");
			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("0/hr");
		});

		it("resolves identity across hostname and site_id for messages", async () => {
			insertHost(localSiteId, "my-host");
			const now = new Date().toISOString();
			// Some messages use hostname, some use site_id
			db.run(
				`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
				 VALUES (?, ?, 'assistant', 'msg', ?, ?, ?, 0)`,
				[randomUUID(), randomUUID(), now, now, "my-host"],
			);
			db.run(
				`INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted)
				 VALUES (?, ?, 'assistant', 'msg', ?, ?, ?, 0)`,
				[randomUUID(), randomUUID(), now, now, localSiteId],
			);

			const result = await hostinfo.handler({}, ctx);
			// Both messages should be counted for this host
			expect(result.stdout).toContain("2/hr");
		});

		it("uses relative time for modified_at", async () => {
			insertHost(localSiteId, "my-host");
			const result = await hostinfo.handler({}, ctx);
			// Just-created host should show seconds ago
			expect(result.stdout).toMatch(/\d+s ago/);
		});
	});

	describe("Phase 3: cluster topology summary", () => {
		it("shows topology header with node count and status breakdown", async () => {
			insertHost(localSiteId, "host-a");
			const oldDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
			insertHost("remote-1", "host-b", { modifiedAt: oldDate });

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("2 nodes");
			expect(result.stdout).toContain("1 online");
			expect(result.stdout).toContain("1 stale");
		});

		it("shows model distribution across hosts", async () => {
			insertHost(localSiteId, "host-a", {
				models: JSON.stringify([{ id: "opus", tier: 1, capabilities: { max_context: 200000 } }]),
			});
			insertHost("remote-1", "host-b", {
				models: JSON.stringify([
					{ id: "opus", tier: 1, capabilities: { max_context: 200000 } },
					{ id: "sonnet", tier: 2, capabilities: { max_context: 200000 } },
				]),
			});

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("Models:");
			// opus on both hosts
			expect(result.stdout).toMatch(/opus\s+→\s+host-a, host-b/);
			// sonnet only on host-b
			expect(result.stdout).toMatch(/sonnet\s+→\s+host-b/);
		});

		it("shows MCP server distribution across hosts", async () => {
			insertHost(localSiteId, "host-a", {
				mcpServers: JSON.stringify(["github", "slack"]),
			});

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("MCP Servers:");
			expect(result.stdout).toMatch(/github\s+→\s+host-a/);
			expect(result.stdout).toMatch(/slack\s+→\s+host-a/);
		});

		it("shows sync mesh with error count and recency", async () => {
			insertHost(localSiteId, "host-a");
			const remoteSite = "remote-site-5678";
			insertHost(remoteSite, "host-b");
			db.run("INSERT INTO sync_state (peer_site_id, sync_errors, last_sync_at) VALUES (?, ?, ?)", [
				remoteSite,
				0,
				new Date().toISOString(),
			]);

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("Sync Mesh:");
		});

		it("warns about single points of failure", async () => {
			insertHost(localSiteId, "host-a", {
				models: JSON.stringify([{ id: "opus", tier: 1, capabilities: {} }]),
				mcpServers: JSON.stringify(["github"]),
			});
			// Only one node — everything is a SPOF
			const result = await hostinfo.handler({}, ctx);
			// Single node clusters should not show SPOF warnings (nothing to be redundant with)
			expect(result.stdout).not.toContain("Single points of failure");
		});

		it("shows SPOF warnings in multi-node clusters", async () => {
			insertHost(localSiteId, "host-a", {
				models: JSON.stringify([{ id: "opus", tier: 1, capabilities: {} }]),
				mcpServers: JSON.stringify(["github"]),
			});
			insertHost("remote-1", "host-b", {
				models: JSON.stringify([{ id: "sonnet", tier: 2, capabilities: {} }]),
			});

			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).toContain("Single points of failure");
			expect(result.stdout).toContain("opus");
			expect(result.stdout).toContain("github");
		});

		it("single host shows no topology sections for sync/SPOF", async () => {
			insertHost(localSiteId, "solo-host");
			const result = await hostinfo.handler({}, ctx);
			expect(result.stdout).not.toContain("Sync Mesh:");
			expect(result.stdout).not.toContain("Single points of failure");
		});
	});
});
