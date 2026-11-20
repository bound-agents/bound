import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	buildLowboxArgs,
	materializeLowboxHelper,
	parseLowboxFailure,
	spawnLowbox,
} from "../tools/lowbox-runtime";

const shell = {
	command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	execFlag: "-Command",
	toolName: "boundless_pwsh",
	label: "PowerShell",
};

const sandbox = {
	enabled: true,
	writablePaths: ["C:\\extra"],
	network: "open" as const,
	onUnavailable: "error" as const,
};

/** A stub child process that mimics the lowbox helper's control protocol:
 * stdout/stderr/control (fd 3) PassThroughs plus the EventEmitter lifecycle. */
function makeStubChild() {
	const emitter = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		stdio: [null, PassThrough, PassThrough, PassThrough];
		kill: () => boolean;
		killed: boolean;
	};
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const control = new PassThrough();
	emitter.stdout = stdout;
	emitter.stderr = stderr;
	emitter.stdio = [null, stdout, stderr, control];
	emitter.killed = false;
	emitter.kill = () => {
		emitter.killed = true;
		return true;
	};
	return { emitter, stdout, stderr, control };
}

describe("parseLowboxFailure — valid and invalid protocol lines", () => {
	it("parses a well-formed structured failure", () => {
		const line = JSON.stringify({
			ok: false,
			code: "E_PROFILE",
			operation: "create_profile",
			win32: 1314,
			message: "A required privilege is not held by the client.",
		});
		const f = parseLowboxFailure(line);
		expect(f).not.toBeNull();
		expect(f?.code).toBe("E_PROFILE");
		expect(f?.operation).toBe("create_profile");
		expect(f?.win32).toBe(1314);
	});

	it("returns null when the JSON lacks required fields", () => {
		expect(parseLowboxFailure(JSON.stringify({ ok: false, code: "X" }))).toBeNull();
		// ok:true is not a failure record.
		expect(parseLowboxFailure(JSON.stringify({ ok: true, pid: 5 }))).toBeNull();
	});

	it("returns null for non-JSON diagnostic text", () => {
		expect(parseLowboxFailure("ordinary stderr line, not JSON")).toBeNull();
	});
});

describe("buildLowboxArgs — argument vector shape", () => {
	it("includes the control handle, cwd, shell, command, network, and writable roots", () => {
		const args = buildLowboxArgs(
			"echo hi",
			"C:\\work",
			"C:\\work",
			shell,
			sandbox,
			"C:\\temp",
			"3",
			"ns-1",
		);
		expect(args[0]).toBe("spawn");
		expect(args).toContain("--control-handle");
		expect(args[args.indexOf("--control-handle") + 1]).toBe("3");
		expect(args[args.indexOf("--command") + 1]).toBe("echo hi");
		expect(args[args.indexOf("--network") + 1]).toBe("open");
		expect(args).toContain("--test-namespace");
		expect(args[args.indexOf("--test-namespace") + 1]).toBe("ns-1");
		// Writable roots: policyCwd, cwd, tempRoot, and each config extra.
		const writables = args.filter((_, i) => args[i - 1] === "--writable");
		expect(writables).toContain("C:\\temp");
		expect(writables).toContain("C:\\extra");
	});

	it("omits the test-namespace flag when none is supplied", () => {
		const args = buildLowboxArgs("x", "C:\\w", "C:\\w", shell, sandbox, "C:\\t", "3");
		expect(args).not.toContain("--test-namespace");
	});
});

describe("materializeLowboxHelper — write, chmod, and reuse", () => {
	it("writes the embedded bytes to a per-hash path and reuses on the second call", () => {
		const base = mkdtempSync(join(tmpdir(), "lowbox-mat-"));
		try {
			const src = join(base, "embedded-helper.bin");
			const payload = Buffer.from("MZ\x90\x00stub-helper-bytes");
			writeFileSync(src, payload);
			const dest1 = materializeLowboxHelper("hashABC", src, base);
			expect(existsSync(dest1)).toBe(true);
			expect(dest1).toContain("hashABC");
			expect(readFileSync(dest1)).toEqual(payload);
			// Second call finds the existing dest and returns it without rewriting.
			const before = readFileSync(dest1);
			// Mutate the source to prove the second call does NOT recopy.
			writeFileSync(src, Buffer.from("DIFFERENT"));
			const dest2 = materializeLowboxHelper("hashABC", src, base);
			expect(dest2).toBe(dest1);
			expect(readFileSync(dest2)).toEqual(before);
		} finally {
			rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});

describe("spawnLowbox — control protocol via injected spawn", () => {
	// resolveLowboxHelperPath throws on non-Windows, so these tests only run the
	// control-protocol path by stubbing BOTH the helper resolution (env) and
	// spawn. We point BOUND_LOWBOX_HELPER at a real file so resolution succeeds
	// regardless of platform.
	function withHelperEnv<T>(fn: (helperPath: string) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "lowbox-helper-"));
		const helper = join(dir, "bound-lowbox.exe");
		writeFileSync(helper, "stub");
		const prev = process.env.BOUND_LOWBOX_HELPER;
		process.env.BOUND_LOWBOX_HELPER = helper;
		try {
			return fn(helper);
		} finally {
			if (prev === undefined) process.env.BOUND_LOWBOX_HELPER = "";
			else process.env.BOUND_LOWBOX_HELPER = prev;
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}

	it("resolves to a process handle when the control pipe reports readiness", async () => {
		if (process.platform !== "win32") {
			// resolveLowboxHelperPath refuses non-Windows platforms before spawn, so
			// the full happy path can only be driven on Windows. Elsewhere, assert
			// the refusal and skip the spawn protocol.
			await expect(
				spawnLowbox("echo", "C:\\w", "C:\\w", shell, sandbox, undefined, {}),
			).rejects.toThrow(/unsupported platform|LOWBOX_HELPER_UNAVAILABLE/);
			return;
		}
		await withHelperEnv(async () => {
			const { emitter, control } = makeStubChild();
			const fakeSpawn = (() => {
				queueMicrotask(() => {
					emitter.emit("spawn");
					control.write(`${JSON.stringify({ ok: true, pid: 4242 })}\n`);
				});
				return emitter;
			}) as unknown as typeof import("node:child_process").spawn;
			const result = await spawnLowbox("echo", "C:\\w", "C:\\w", shell, sandbox, undefined, {
				spawn: fakeSpawn,
			});
			expect(result.pid).toBe(4242);
			result.kill("SIGTERM");
			expect(emitter.killed).toBe(true);
		});
	});

	it("rejects with a structured error when readiness reports a failure", async () => {
		if (process.platform !== "win32") return; // resolution refuses off-Windows
		await withHelperEnv(async () => {
			const { emitter, control } = makeStubChild();
			const fakeSpawn = (() => {
				queueMicrotask(() => {
					emitter.emit("spawn");
					control.write(
						`${JSON.stringify({ ok: false, code: "E_PROFILE", operation: "create", message: "denied" })}\n`,
					);
				});
				return emitter;
			}) as unknown as typeof import("node:child_process").spawn;
			await expect(
				spawnLowbox("echo", "C:\\w", "C:\\w", shell, sandbox, undefined, { spawn: fakeSpawn }),
			).rejects.toThrow(/E_PROFILE/);
		});
	});
});
