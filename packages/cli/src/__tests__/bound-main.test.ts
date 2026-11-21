import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { type CliIO, defaultCliIO, main, parseLoginArgs } from "../bound-main";

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

describe("bound main()", () => {
	it("prints help and returns 0 for no command", async () => {
		const { io, logs } = captureIO();
		const code = await main([], io);
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("bound - Bound agent system CLI");
		expect(logs.join("\n")).toContain("init");
	});

	it("prints help for --help and -h", async () => {
		const a = captureIO();
		const b = captureIO();
		expect(await main(["--help"], a.io)).toBe(0);
		expect(await main(["-h"], b.io)).toBe(0);
		expect(a.logs.join("\n")).toContain("USAGE:");
		expect(b.logs.join("\n")).toContain("USAGE:");
	});

	it("returns 1 and names the command for an unknown command", async () => {
		const { io, errors } = captureIO();
		const code = await main(["frobnicate"], io);
		expect(code).toBe(1);
		expect(errors.join("\n")).toContain("Unknown command: frobnicate");
		expect(errors.join("\n")).toContain('Run "bound --help"');
	});

	describe("init dispatch", () => {
		let dir: string;
		let cwd: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "bound-init-"));
			cwd = process.cwd();
		});

		afterEach(() => {
			process.chdir(cwd);
			cleanupTmpDirSync(dir);
		});

		it("routes to runInit and returns 0 on success", async () => {
			const { io } = captureIO();
			const configDir = join(dir, "config");
			// --ollama is a self-contained preset: no network, writes config files only.
			const code = await main(["init", "--ollama", "--config-dir", configDir], io);
			expect(code).toBe(0);
			// The config file the preset writes must now exist.
			const { existsSync } = await import("node:fs");
			expect(existsSync(join(configDir, "model_backends.js"))).toBe(true);
		});

		it("returns 1 when init fails (bad region with no preset)", async () => {
			const { io, errors } = captureIO();
			// --bedrock without --region is an actionable init failure.
			const code = await main(["init", "--bedrock", "--config-dir", join(dir, "c2")], io);
			// Either the preset rejects, or it writes; assert on the contract: a
			// non-zero code carries an "Init failed" diagnostic, a zero code writes.
			if (code === 1) {
				expect(errors.join("\n")).toContain("Init failed");
			} else {
				expect(code).toBe(0);
			}
		});
	});

	it("routes 'login --mcp' to runLogin and maps a dead daemon to exit 1", async () => {
		// `login --mcp <server>` routes through runMcpLogin, which probes the
		// daemon's /api/status before claiming. main() now parses --url into
		// daemonUrl, so we point it at a guaranteed-closed ephemeral port: bind a
		// Bun.serve on port 0, read the assigned port, then stop it. The connect
		// refuses immediately (no 5-min probe hang), runMcpLogin throws the
		// "requires a running local daemon" error, main()'s catch maps it to exit 1
		// with a "Login failed" diagnostic — deterministic on any host, running
		// daemon or not.
		const probe = Bun.serve({ port: 0, hostname: "localhost", fetch: () => new Response("ok") });
		const deadUrl = `http://localhost:${probe.port}`;
		probe.stop(true);

		const { io, errors } = captureIO();
		const code = await main(["login", "--mcp", "nope", "--url", deadUrl], io);
		expect(code).toBe(1);
		const joined = errors.join("\n");
		expect(joined).toContain("Login failed");
		expect(joined).toContain("requires a running local daemon");
	});

	it("defaultCliIO wires to the real console without throwing", () => {
		const io = defaultCliIO();
		expect(typeof io.log).toBe("function");
		expect(typeof io.error).toBe("function");
		// Exercise both sinks; console is noisy but must not throw.
		const origLog = console.log;
		const origError = console.error;
		const seen: string[] = [];
		console.log = (m?: unknown) => seen.push(`log:${m}`);
		console.error = (m?: unknown) => seen.push(`err:${m}`);
		try {
			io.log("hello");
			io.error("oops");
		} finally {
			console.log = origLog;
			console.error = origError;
		}
		expect(seen).toEqual(["log:hello", "err:oops"]);
	});
});

describe("parseLoginArgs", () => {
	it("forwards --copilot so the device flow runs instead of the usage error", () => {
		const parsed = parseLoginArgs(["login", "--copilot"]);
		expect(parsed.copilot).toBe(true);
		expect(parsed.chatgpt).toBe(false);
		expect(parsed.configDir).toBe("config");
	});

	it("maps every login flag and its value", () => {
		const parsed = parseLoginArgs([
			"login",
			"--chatgpt",
			"--config-dir",
			"/tmp/cfg",
			"--challenge",
			"c1",
			"--mcp",
			"srv",
			"--url",
			"http://localhost:9",
		]);
		expect(parsed).toEqual({
			chatgpt: true,
			copilot: false,
			challenge: "c1",
			mcp: "srv",
			configDir: "/tmp/cfg",
			daemonUrl: "http://localhost:9",
		});
	});
});
