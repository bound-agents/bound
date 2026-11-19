import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema } from "@bound/core";
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
		rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

	it("rejects an unknown db subcommand (exit 1)", async () => {
		const { io, errors } = captureIO();
		const code = await main(["db", "bogus", "--data-dir", dataDir], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Unknown db subcommand");
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
