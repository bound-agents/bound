import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, getSiteId } from "@bound/core";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { type CliIO, main } from "../boundctl-main";

/**
 * Success-path coverage for the boundctl `main()` dispatch bodies. The sibling
 * boundctl-main.test.ts exercises the parse/error branches; this file drives the
 * DB-backed delegate commands (set-hub / set-persona / stop / resume /
 * sync-status / config reload / restore) all the way through their success
 * bodies against real temp SQLite DBs, so the instrumented `run*` call + return-0
 * lines execute rather than only the `catch` arms.
 *
 * Layout mirrors `bound init`: a `config/` dir and a sibling `data/bound.db`.
 * The delegate commands derive `dataDir` as the sibling `data` of `resolve(configDir)`.
 */

const SITE_ID = "site-ctl-success-1234";

function captureIO(): { io: CliIO; logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		io: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
		logs,
		errors,
	};
}

interface Harness {
	tmp: string;
	configDir: string;
	dataDir: string;
	dbPath: string;
}

function seed(): Harness {
	const tmp = mkdtempSync(join(tmpdir(), `boundctl-success-${randomBytes(4).toString("hex")}-`));
	const configDir = join(tmp, "config");
	const dataDir = join(tmp, "data");
	mkdirSync(configDir);
	mkdirSync(dataDir);
	const dbPath = join(dataDir, "bound.db");
	const db = new Database(dbPath);
	applySchema(db);
	applyMetricsSchema(db);
	db.query("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE_ID);
	db.close();
	return { tmp, configDir, dataDir, dbPath };
}

/** Read a cluster_config value (live, deleted = 0) from the data DB. */
function readClusterConfig(dbPath: string, key: string): string | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.query("SELECT value FROM cluster_config WHERE key = ? AND deleted = 0")
			.get(key) as { value: string } | null;
		return row?.value ?? null;
	} finally {
		db.close();
	}
}

describe("boundctl main() — success bodies against real DBs", () => {
	let h: Harness;

	beforeEach(() => {
		h = seed();
	});

	afterEach(() => {
		cleanupTmpDirSync(h.tmp);
	});

	it("set-hub writes cluster_hub and returns 0", async () => {
		const { io } = captureIO();
		const code = await main(["set-hub", "primary-host", "--config-dir", h.configDir], io);
		expect(code).toBe(0);
		expect(readClusterConfig(h.dbPath, "cluster_hub")).toBe("primary-host");
	});

	it("set-hub re-set updates the existing (un-tombstoned) row", async () => {
		expect(await main(["set-hub", "host-a", "--config-dir", h.configDir], captureIO().io)).toBe(0);
		const { io } = captureIO();
		expect(await main(["set-hub", "host-b", "--config-dir", h.configDir], io)).toBe(0);
		expect(readClusterConfig(h.dbPath, "cluster_hub")).toBe("host-b");
	});

	it("stop sets the emergency_stop flag and returns 0", async () => {
		const { io } = captureIO();
		const code = await main(["stop", "--config-dir", h.configDir], io);
		expect(code).toBe(0);
		expect(readClusterConfig(h.dbPath, "emergency_stop")).not.toBeNull();
	});

	it("resume clears the emergency_stop flag (set then cleared) and returns 0", async () => {
		expect(await main(["stop", "--config-dir", h.configDir], captureIO().io)).toBe(0);
		expect(readClusterConfig(h.dbPath, "emergency_stop")).not.toBeNull();

		const { io } = captureIO();
		const code = await main(["resume", "--config-dir", h.configDir], io);
		expect(code).toBe(0);
		expect(readClusterConfig(h.dbPath, "emergency_stop")).toBeNull();
	});

	it("resume with no flag set is a no-op success", async () => {
		const { io } = captureIO();
		const code = await main(["resume", "--config-dir", h.configDir], io);
		expect(code).toBe(0);
		// No emergency_stop row was ever written, so the clear is a no-op.
		expect(readClusterConfig(h.dbPath, "emergency_stop")).toBeNull();
	});

	it("sync-status reads change_log + hosts and returns 0", async () => {
		const { io } = captureIO();
		const code = await main(["sync-status", "--config-dir", h.configDir], io);
		expect(code).toBe(0);
	});

	it("set-persona --file writes the persona cluster_config row and returns 0", async () => {
		const personaPath = join(h.tmp, "persona.md");
		writeFileSync(personaPath, "You are a careful operator.");
		const { io } = captureIO();
		const code = await main(
			["set-persona", "--file", personaPath, "--config-dir", h.configDir],
			io,
		);
		expect(code).toBe(0);
		// The persona is stored under the shared PERSONA_CLUSTER_CONFIG_KEY; assert
		// the row now exists with the content we passed.
		const db = new Database(h.dbPath, { readonly: true });
		try {
			const row = db
				.query("SELECT COUNT(*) AS n FROM cluster_config WHERE deleted = 0 AND value = ?")
				.get("You are a careful operator.") as { n: number };
			expect(row.n).toBe(1);
		} finally {
			db.close();
		}
	});

	it("set-persona with a missing --file surfaces the read error (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(
			["set-persona", "--file", join(h.tmp, "nope.md"), "--config-dir", h.configDir],
			io,
		);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("set-persona failed");
	});

	it("config reload mcp evaluates an empty server list and returns 0", async () => {
		writeFileSync(join(h.configDir, "mcp.json"), JSON.stringify({ servers: [] }));
		const { io, errors } = captureIO();
		const code = await main(["config", "reload", "mcp", "--config-dir", h.configDir], io);
		expect(code).toBe(0);
		expect(errors).toEqual([]);
	});

	it("restore --preview against the data dir returns 0", async () => {
		// `restore` treats --config-dir AS the data dir (resolve(configDir, 'bound.db')).
		const { io, errors } = captureIO();
		const code = await main(
			["restore", "--before", "2099-01-01T00:00:00Z", "--preview", "--config-dir", h.dataDir],
			io,
		);
		expect(code).toBe(0);
		expect(errors).toEqual([]);
	});

	it("restore with a bad timestamp surfaces the validation error (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(["restore", "--before", "not-a-date", "--config-dir", h.dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("restore failed");
	});

	it("set-hub on an uninitialized data dir surfaces the site_id error (exit 1)", async () => {
		// Fresh config/ sibling data/ with an empty DB (schema but no site_id row).
		const bare = mkdtempSync(join(tmpdir(), `boundctl-bare-${randomBytes(4).toString("hex")}-`));
		try {
			const cfg = join(bare, "config");
			const data = join(bare, "data");
			mkdirSync(cfg);
			mkdirSync(data);
			const db = new Database(join(data, "bound.db"));
			applySchema(db);
			applyMetricsSchema(db);
			expect(getSiteId(db)).toBe("unknown");
			db.close();

			const { io, errors } = captureIO();
			const code = await main(["set-hub", "h", "--config-dir", cfg], io);
			expect(code).toBe(1);
			expect(errors.join("\n")).toContain("set-hub failed");
		} finally {
			cleanupTmpDirSync(bare);
		}
	});

	it("webhook create then rotate-secret, update, and delete all return 0", async () => {
		// create
		expect(
			await main(
				["webhook", "create", "--data-dir", h.dataDir, "--name", "gh-hook", "--format", "github"],
				captureIO().io,
			),
		).toBe(0);
		// rotate-secret
		expect(
			await main(["webhook", "rotate-secret", "gh-hook", "--data-dir", h.dataDir], captureIO().io),
		).toBe(0);
		// update (change description)
		expect(
			await main(
				["webhook", "update", "--data-dir", h.dataDir, "--name", "gh-hook", "--description", "d"],
				captureIO().io,
			),
		).toBe(0);
		// delete
		expect(
			await main(["webhook", "delete", "gh-hook", "--data-dir", h.dataDir], captureIO().io),
		).toBe(0);
	});

	it("webhook delete on a missing webhook surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(await main(["webhook", "delete", "ghost-hook", "--data-dir", h.dataDir], io)).toBe(1);
		expect(errors.join("\n")).toContain("webhook command failed");
	});

	it("webhook rotate-secret on a missing webhook surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(
			await main(["webhook", "rotate-secret", "ghost-hook", "--data-dir", h.dataDir], io),
		).toBe(1);
		expect(errors.join("\n")).toContain("webhook command failed");
	});

	it("webhook create on a bad name surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(
			await main(["webhook", "create", "--data-dir", h.dataDir, "--name", "Bad Name!"], io),
		).toBe(1);
		expect(errors.join("\n")).toContain("webhook command failed");
	});

	it("webhook allow-unauthenticated then disallow-unauthenticated return 0", async () => {
		expect(
			await main(["webhook", "allow-unauthenticated", "--data-dir", h.dataDir], captureIO().io),
		).toBe(0);
		expect(readClusterConfig(h.dbPath, "webhooks_allow_unauthenticated")).toBe("true");
		expect(
			await main(["webhook", "disallow-unauthenticated", "--data-dir", h.dataDir], captureIO().io),
		).toBe(0);
		// disallow flips the row to "false" (it is not soft-deleted).
		expect(readClusterConfig(h.dbPath, "webhooks_allow_unauthenticated")).toBe("false");
	});

	it("task update on a missing id surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(
			await main(["task", "update", "no-such-task", "--no-history", "--data-dir", h.dataDir], io),
		).toBe(1);
		expect(errors.join("\n")).toContain("task command failed");
	});

	it("skill view on a missing skill surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(await main(["skill", "view", "ghost-skill", "--data-dir", h.dataDir], io)).toBe(1);
		expect(errors.join("\n")).toContain("skill command failed");
	});

	it("skill delete on a missing skill surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(await main(["skill", "delete", "no-such-skill", "--data-dir", h.dataDir], io)).toBe(1);
		expect(errors.join("\n")).toContain("skill command failed");
	});

	it("skill import on a nonexistent path surfaces the error (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(
			await main(["skill", "import", join(h.tmp, "no-such-dir"), "--data-dir", h.dataDir], io),
		).toBe(1);
		expect(errors.join("\n")).toContain("skill command failed");
	});

	it("skill import from a real directory writes the skill and returns 0", async () => {
		const skillDir = join(h.tmp, "my-skill");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: my-skill\ndescription: A test skill for coverage.\n---\n\nBody.\n",
		);
		const { io, errors } = captureIO();
		const code = await main(["skill", "import", skillDir, "--data-dir", h.dataDir], io);
		expect(code).toBe(0);
		expect(errors).toEqual([]);
		// view the imported skill through the DB-backed path (success body)
		expect(await main(["skill", "view", "my-skill", "--data-dir", h.dataDir], captureIO().io)).toBe(
			0,
		);
		// list --verbose exercises the verbose branch
		expect(
			await main(["skill", "list", "--verbose", "--data-dir", h.dataDir], captureIO().io),
		).toBe(0);
		// delete it (success body with filesDeleted)
		expect(
			await main(["skill", "delete", "my-skill", "--data-dir", h.dataDir], captureIO().io),
		).toBe(0);
	});
});
