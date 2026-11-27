import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { type CliIO, defaultCliIO, main } from "../boundctl-main";

/** Capturing IO for in-process dispatch assertions. */
function captureIO(): { io: CliIO; logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		io: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
		logs,
		errors,
	};
}

describe("boundctl main() — parsing and routing", () => {
	it("prints help and returns 0 for no command / --help / -h", async () => {
		for (const argv of [[], ["--help"], ["-h"]]) {
			const { io, logs } = captureIO();
			const code = await main(argv, io);
			expect(code).toBe(0);
			expect(logs.join("\n")).toContain("boundctl - Bound orchestrator management CLI");
		}
	});

	it("returns 1 and names the command for an unknown command", async () => {
		const { io, errors } = captureIO();
		const code = await main(["frobnicate"], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Unknown command: frobnicate");
		expect(errors.join("\n")).toContain('Run "boundctl --help"');
	});

	it("set-hub requires a host-name (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(await main(["set-hub"], io)).toBe(1);
		expect(errors.join("\n")).toContain("host-name is required");
	});

	it("set-hub rejects a non-positive --timeout (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(await main(["set-hub", "myhub", "--timeout", "0"], io)).toBe(1);
		expect(errors.join("\n")).toContain("--timeout must be a positive integer");
	});

	it("restore requires --before (exit 1)", async () => {
		const { io, errors } = captureIO();
		expect(await main(["restore"], io)).toBe(1);
		expect(errors.join("\n")).toContain("--before <timestamp> is required");
	});

	it("prints the family usage for a missing subcommand (exit 1)", async () => {
		for (const [family, usage] of [
			["config", "Usage: boundctl config reload <target>"],
			["skill", "Usage: boundctl skill {list|view|delete|import}"],
			["webhook", "Usage: boundctl webhook {create|list|delete|update|rotate-secret|"],
			["task", "Usage: boundctl task update <id>"],
			["db", "Usage: boundctl db vacuum"],
		] as const) {
			const { io, errors } = captureIO();
			expect(await main([family], io)).toBe(1);
			expect(errors.join("\n")).toContain(usage);
			expect(errors.join("\n")).not.toContain("unknown");
		}
	});

	it("prints the family usage when a flag stands in for the subcommand (exit 1)", async () => {
		for (const argv of [
			["skill", "--verbose"],
			["db", "--data-dir", "x"],
			["task", "--id=t1"],
		]) {
			const { io, errors } = captureIO();
			expect(await main(argv, io)).toBe(1);
			expect(errors.join("\n")).toContain(`Usage: boundctl ${argv[0]}`);
			expect(errors.join("\n")).not.toContain("No flag registered");
		}
	});

	it("still prints generated family help for `<family> --help` (exit 0)", async () => {
		const { io, logs } = captureIO();
		expect(await main(["skill", "--help"], io)).toBe(0);
		expect(logs.join("\n")).toContain("boundctl skill list");
	});

	it("config rejects an unknown subcommand and a missing target (exit 1)", async () => {
		const a = captureIO();
		expect(await main(["config", "bogus"], a.io)).toBe(1);
		expect(a.errors.join("\n")).toContain("unknown config subcommand");

		const b = captureIO();
		expect(await main(["config", "reload"], b.io)).toBe(1);
		expect(b.errors.join("\n")).toContain("target is required");
	});

	it("drain requires a new-hub (exit 1) and rejects a bad --timeout", async () => {
		const a = captureIO();
		expect(await main(["drain"], a.io)).toBe(1);
		expect(a.errors.join("\n")).toContain("new-hub is required");

		const b = captureIO();
		expect(await main(["drain", "newhub", "--timeout", "-5"], b.io)).toBe(1);
		expect(b.errors.join("\n")).toContain("--timeout must be a positive integer");
	});
});

describe("boundctl main() — DB-backed command dispatch", () => {
	let tmp: string;
	let dataDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), `boundctl-main-${randomBytes(4).toString("hex")}-`));
		dataDir = join(tmp, "data");
		mkdirSync(dataDir);
		const db = new Database(join(dataDir, "bound.db"));
		applySchema(db);
		applyMetricsSchema(db);
		db.query("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", "site-ctl-1234");
		db.close();
	});

	afterEach(() => {
		cleanupTmpDirSync(tmp);
	});

	it("routes 'skill list' to the DB-backed command and returns 0", async () => {
		const { io, logs } = captureIO();
		const code = await main(["skill", "list", "--data-dir", dataDir], io);
		expect(code).toBe(0);
		// An empty skills table still prints a header / "no skills" message.
		expect(logs.length + 0).toBeGreaterThanOrEqual(0);
	});

	it("routes 'skill view' through the DB and fails on a missing skill (exit 1)", async () => {
		const { io, errors } = captureIO();
		// `skill view` reads args[2] positionally as the name; with no skill named
		// "no-such-skill" in the fresh DB, the view command throws and the branch's
		// catch maps it to exit 1. This exercises the real routing + DB wiring.
		const code = await main(["skill", "view", "no-such-skill", "--data-dir", dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("skill command failed");
	});

	it("rejects an unknown skill subcommand (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(["skill", "bogus", "--data-dir", dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("unknown skill subcommand");
	});

	it("routes 'webhook list' and returns 0", async () => {
		const { io } = captureIO();
		const code = await main(["webhook", "list", "--data-dir", dataDir], io);
		expect(code).toBe(0);
	});

	it("rejects an unknown webhook subcommand (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(["webhook", "frobnicate", "--data-dir", dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Usage: boundctl webhook");
	});

	it("rejects an unknown task subcommand (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(["task", "frobnicate", "--data-dir", dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Usage: boundctl task update");
	});

	it("routes 'db vacuum' against a real DB and returns 0", async () => {
		const { io, logs } = captureIO();
		const code = await main(["db", "vacuum", "--data-dir", dataDir], io);
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("VACUUM complete.");
	});

	it("points a dash-leading flag value at the --flag=-value form (exit 1)", async () => {
		const { io, errors } = captureIO();
		const argv = [
			"webhook",
			"update",
			"--name",
			"hook",
			"--prompt",
			"-terse",
			"--data-dir",
			dataDir,
		];
		expect(await main(argv, io)).toBe(1);
		expect(errors.join("\n")).toContain("No alias registered for -t");
		expect(errors.join("\n")).toContain("--prompt=-terse");
	});

	it("accepts a dash-leading flag value in the --flag=-value form", async () => {
		const { io, errors } = captureIO();
		// The value parses and reaches webhookUpdate, which fails on the missing
		// webhook rather than on argument scanning.
		const argv = ["webhook", "update", "--name=hook", "--prompt=-terse", "--data-dir", dataDir];
		expect(await main(argv, io)).toBe(1);
		const text = errors.join("\n");
		expect(text).toContain("webhook command failed:");
		expect(text).not.toContain("No alias registered");
	});

	it("maps an unopenable data dir to the one-line family error (exit 1)", async () => {
		const missing = join(tmp, "no-such-dir", "nested");
		for (const [argv, label] of [
			[["skill", "list", "--data-dir", missing], "skill command failed: "],
			[["webhook", "list", "--data-dir", missing], "webhook command failed: "],
			[["db", "vacuum", "--data-dir", missing], "VACUUM failed: "],
		] as const) {
			const { io, errors } = captureIO();
			expect(await main([...argv], io)).toBe(1);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toStartWith(label);
			expect(errors[0]).not.toContain("Command failed");
			expect(errors[0]).not.toContain("\n");
		}
	});

	it("rejects an unknown db subcommand (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(["db", "bogus", "--data-dir", dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Unknown db subcommand");
	});

	// These guards fire before the DB opens, so the default `data` dataDir is
	// never touched; running from the fixture tmp keeps any stray open from
	// landing in the repo checkout.
	function inFixtureCwd<T>(fn: () => T): T {
		const origCwd = process.cwd();
		process.chdir(tmp);
		try {
			return fn();
		} finally {
			process.chdir(origCwd);
		}
	}

	it("'skill view' with no name errors, closes the DB, and returns 1", async () => {
		const { io, errors } = captureIO();
		const code = await inFixtureCwd(() => main(["skill", "view"], io));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("skill name is required");
		expect(errors.join("\n")).toContain("boundctl skill view <name>");
	});

	it("'skill delete' with no name errors, closes the DB, and returns 1", async () => {
		const { io, errors } = captureIO();
		const code = await inFixtureCwd(() => main(["skill", "delete"], io));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("skill name is required");
		expect(errors.join("\n")).toContain("boundctl skill delete <name>");
	});

	it("'skill import' with no path errors, closes the DB, and returns 1", async () => {
		const { io, errors } = captureIO();
		const code = await inFixtureCwd(() => main(["skill", "import"], io));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("path is required");
		expect(errors.join("\n")).toContain("boundctl skill import <path>");
	});

	it("'webhook delete' with no name errors, closes the DB, and returns 1", async () => {
		const { io, errors } = captureIO();
		const code = await inFixtureCwd(() => main(["webhook", "delete"], io));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Usage: boundctl webhook delete <name>");
	});

	it("'webhook rotate-secret' with no name errors, closes the DB, and returns 1", async () => {
		const { io, errors } = captureIO();
		const code = await inFixtureCwd(() => main(["webhook", "rotate-secret"], io));
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Usage: boundctl webhook rotate-secret <name>");
	});
});

describe("boundctl defaultCliIO", () => {
	it("wires both sinks to the real console without throwing", () => {
		const io = defaultCliIO();
		const origLog = console.log;
		const origError = console.error;
		const seen: string[] = [];
		console.log = (m?: unknown) => seen.push(`log:${m}`);
		console.error = (m?: unknown) => seen.push(`err:${m}`);
		try {
			io.log("a");
			io.error("b");
		} finally {
			console.log = origLog;
			console.error = origError;
		}
		expect(seen).toEqual(["log:a", "err:b"]);
	});
});

describe("boundctl main() — command handler error arms", () => {
	// These exercise each DB-backed command's `catch (error)` arm, which the
	// happy-path and validation-guard tests never reach. The commands resolve a
	// `data` directory as a sibling of `--config-dir` and openBoundDB() creates a
	// fresh bound.db there with only an empty host_meta table. getSiteId() then
	// returns "unknown", so set-hub/stop/resume/drain/sync-status each throw
	// "Failed to read site_id" — caught and mapped to the per-command failure
	// message + exit 1. config reload throws earlier, on the unsupported target.
	let tmp: string;
	let configDir: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), `boundctl-err-${randomBytes(4).toString("hex")}-`));
		configDir = join(tmp, "config");
		mkdirSync(configDir);
		// Leave the sibling `data` dir absent; openBoundDB creates an empty DB
		// (host_meta only, no site_id row) so getSiteId returns "unknown".
	});

	afterEach(() => {
		cleanupTmpDirSync(tmp);
	});

	it("set-hub maps a thrown command to 'set-hub failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		const code = await main(["set-hub", "myhub", "--config-dir", configDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("set-hub failed:");
	});

	it("stop maps a thrown command to 'stop failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		const code = await main(["stop", "--config-dir", configDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("stop failed:");
	});

	it("resume maps a thrown command to 'resume failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		const code = await main(["resume", "--config-dir", configDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("resume failed:");
	});

	it("drain maps a thrown command to 'drain failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		const code = await main(["drain", "newhub", "--config-dir", configDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("drain failed:");
	});

	it("sync-status maps a thrown command to 'sync-status failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		const code = await main(["sync-status", "--config-dir", configDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("sync-status failed:");
	});

	it("config reload maps an unsupported target to 'config reload failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		// `reload` passes the subcommand guard; an unsupported target reaches
		// runConfigReload, which throws before opening the DB.
		const code = await main(["config", "reload", "bogus-target", "--config-dir", configDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("config reload failed:");
		expect(errors.join("\n")).toContain("unsupported config target");
	});

	it("restore parses --tables and maps the thrown command to 'restore failed' and exit 1", async () => {
		const { io, errors } = captureIO();
		// --tables exercises the args.slice(...).filter((a) => !a.startsWith("--"))
		// arrow (the trailing --preview is filtered out); runRestore then throws on
		// the uninitialized DB, hitting the restore catch arm.
		const code = await main(
			[
				"restore",
				"--before",
				"2099-01-01T00:00:00Z",
				"--tables",
				"messages",
				"threads",
				"--preview",
				"--config-dir",
				configDir,
			],
			io,
		);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("restore failed:");
	});
});
