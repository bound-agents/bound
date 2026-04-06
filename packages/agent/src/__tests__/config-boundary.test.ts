import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { query } from "../commands/query";

describe("R-U16: Agent cannot read config files", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "config-boundary-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		const siteId = randomUUID();
		const eventBus = new TypedEventEmitter();

		ctx = {
			db,
			siteId,
			eventBus,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: randomUUID(),
			taskId: randomUUID(),
		};
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
	});

	it("query command cannot access config data (no config table exists)", async () => {
		// Config is loaded into AppContext.config, never written to DB
		// Verify there's no table named "config" or similar
		const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
			name: string;
		}>;
		const tableNames = tables.map((t) => t.name);

		expect(tableNames).not.toContain("config");
		expect(tableNames).not.toContain("allowlist");
		expect(tableNames).not.toContain("model_backends");
		expect(tableNames).not.toContain("discord_config");
		expect(tableNames).not.toContain("keyring");
		expect(tableNames).not.toContain("network_config");
	});

	it("query command can only access synced tables (not config)", async () => {
		// Verify agent can query data tables but not config
		const result = await query.handler(
			{ query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" },
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Agent should see synced tables and internal tables
		const output = result.stdout;
		expect(output).toContain("users");
		expect(output).toContain("threads");
		expect(output).toContain("messages");
		expect(output).toContain("tasks");
		expect(output).toContain("files");
		expect(output).toContain("cluster_config"); // This is a synced table but only for cluster settings

		// But NOT any standalone config tables
		expect(output).not.toContain("allowlist");
		expect(output).not.toContain("model_backends");
		expect(output).not.toContain("discord_config");
		expect(output).not.toContain("keyring");
	});

	it("cluster_config table does not contain sensitive config values", async () => {
		// cluster_config is synced but only for cluster-level settings
		// Verify it doesn't contain sensitive values like API keys or bot tokens
		const result = await query.handler({ query: "SELECT * FROM cluster_config" }, ctx);

		expect(result.exitCode).toBe(0);

		// Should be empty or only contain innocuous cluster settings
		const output = result.stdout;
		expect(output).not.toContain("api_key");
		expect(output).not.toContain("bot_token");
		expect(output).not.toContain("secret");
		expect(output).not.toContain("password");
	});

	it("no sensitive config data appears in any synced table", async () => {
		// Verify sensitive values don't leak into synced tables
		const tables = [
			"users",
			"threads",
			"messages",
			"semantic_memory",
			"tasks",
			"files",
			"hosts",
			"overlay_index",
			"cluster_config",
			"advisories",
		];

		for (const table of tables) {
			const result = await query.handler({ query: `SELECT * FROM ${table}` }, ctx);
			expect(result.exitCode).toBe(0);

			const output = result.stdout.toLowerCase();
			// Check common sensitive field patterns don't appear
			expect(output).not.toContain("anthropic_api_key");
			expect(output).not.toContain("openai_api_key");
			expect(output).not.toContain("discord_bot_token");
			expect(output).not.toContain("aws_access_key");
			expect(output).not.toContain("aws_secret");
		}
	});
});
