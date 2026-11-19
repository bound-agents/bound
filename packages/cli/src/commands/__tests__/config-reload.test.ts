import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, findClusterConfigValueByKey } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runConfigReload } from "../config-reload.js";

/**
 * runConfigReload opens bound.db in a `data` directory sibling to the config
 * directory and reads mcp config from configDir, writing a
 * config_reload_requested marker into cluster_config on success. The fixture
 * lays out <root>/config and <root>/data.
 */

const SITE = "reload-site";

describe("runConfigReload", () => {
	let root: string;
	let configDir: string;
	let dataDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bound-reload-"));
		configDir = join(root, "config");
		dataDir = join(root, "data");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTmpDir(root);
	});

	function setupDb(withSiteId = true) {
		const db = createDatabase(join(dataDir, "bound.db"));
		applySchema(db);
		if (withSiteId) {
			db.exec("INSERT OR REPLACE INTO host_meta (key, value) VALUES ('site_id', ?)", [SITE]);
		}
		db.close();
	}

	function silence() {
		const orig = console.log;
		console.log = () => {};
		return () => {
			console.log = orig;
		};
	}

	it("rejects an unsupported config target before opening the DB", async () => {
		await expect(runConfigReload({ target: "sync", configDir })).rejects.toThrow(
			/unsupported config target: sync/,
		);
	});

	it("throws when site_id is unreadable", async () => {
		setupDb(false);
		writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ servers: [] }));
		const restore = silence();
		try {
			await expect(runConfigReload({ target: "mcp", configDir })).rejects.toThrow(
				/Failed to read site_id/,
			);
		} finally {
			restore();
		}
	});

	it("throws when the mcp config fails to load", async () => {
		setupDb();
		// Invalid JSON → loader returns a non-ok result.
		writeFileSync(join(configDir, "mcp.json"), "{ not valid json");
		const restore = silence();
		try {
			await expect(runConfigReload({ target: "mcp", configDir })).rejects.toThrow(/Failed to load/);
		} finally {
			restore();
		}
	});

	it("throws on a duplicate server name in the mcp config", async () => {
		setupDb();
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({
				servers: [
					{ name: "dup", transport: "stdio", command: "a" },
					{ name: "dup", transport: "stdio", command: "b" },
				],
			}),
		);
		const restore = silence();
		try {
			await expect(runConfigReload({ target: "mcp", configDir })).rejects.toThrow(
				/duplicate server name: dup/,
			);
		} finally {
			restore();
		}
	});

	it("writes a config_reload_requested marker on a valid mcp config", async () => {
		setupDb();
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({ servers: [{ name: "ok", transport: "stdio", command: "x" }] }),
		);
		const restore = silence();
		try {
			await runConfigReload({ target: "mcp", configDir });
		} finally {
			restore();
		}

		const db = createDatabase(join(dataDir, "bound.db"));
		const marker = findClusterConfigValueByKey(db, "config_reload_requested");
		expect(marker?.value).toBeTruthy();
		db.close();
	});

	it("un-tombstones the marker via UPDATE on a second reload (single row)", async () => {
		setupDb();
		writeFileSync(
			join(configDir, "mcp.json"),
			JSON.stringify({ servers: [{ name: "ok", transport: "stdio", command: "x" }] }),
		);
		const restore = silence();
		try {
			await runConfigReload({ target: "mcp", configDir });
			await runConfigReload({ target: "mcp", configDir });
		} finally {
			restore();
		}

		const db = createDatabase(join(dataDir, "bound.db"));
		const count = db
			.query("SELECT COUNT(*) AS n FROM cluster_config WHERE key = 'config_reload_requested'")
			.get() as { n: number };
		expect(count.n).toBe(1);
		db.close();
	});
});
