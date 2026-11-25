import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLowboxArgs,
	materializeLowboxHelper,
	parseLowboxFailure,
	resolveLowboxHelperPath,
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
	writablePaths: ["C:\\extra root"],
	network: "open" as const,
	onUnavailable: "error" as const,
};

it("captures helper close before awaiting readiness", async () => {
	const { PassThrough } = await import("node:stream");
	const { EventEmitter } = await import("node:events");
	const child = new EventEmitter() as EventEmitter & {
		stdio: Array<PassThrough | null>;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: () => boolean;
	};
	const control = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdio = [null, child.stdout, child.stderr, control];
	child.kill = () => true;
	const spawn = () => {
		queueMicrotask(() => {
			child.emit("spawn");
			control.write('{"ok":true,"pid":4242}\n');
			child.emit("exit", 0);
			child.emit("close", 0);
		});
		return child;
	};
	const originalHelper = process.env.BOUND_LOWBOX_HELPER;
	process.env.BOUND_LOWBOX_HELPER = process.execPath;
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32" });
	try {
		const result = await spawnLowbox(
			"echo ok",
			process.cwd(),
			process.cwd(),
			shell,
			sandbox,
			"close-before-return-test",
			{ spawn },
		);
		expect(result.pid).toBe(4242);
		expect(await Promise.race([result.exited, Bun.sleep(100).then(() => "timeout")])).toBe(0);
	} finally {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		process.env.BOUND_LOWBOX_HELPER = originalHelper;
	}
});

it("builds the full native-helper flag protocol in order", () => {
	expect(
		buildLowboxArgs("Write-Output hi", "C:\\work", "C:\\repo", shell, sandbox, "C:\\tmp", "1234"),
	).toEqual([
		"spawn",
		"--control-handle",
		"1234",
		"--cwd",
		"C:\\work",
		"--shell",
		shell.command,
		"--shell-flag",
		"-Command",
		"--command",
		"Write-Output hi",
		"--network",
		"open",
		"--writable",
		"C:\\repo",
		"--writable",
		"C:\\work",
		"--writable",
		"C:\\tmp",
		"--writable",
		"C:\\extra root",
	]);
});

it("grants linked-worktree git directories as writable roots before git-protected paths", () => {
	const linked = {
		...sandbox,
		gitWorktreeMetadata: {
			gitdir: "C:\\main\\.git\\worktrees\\feature",
			commondir: "C:\\main\\.git",
			protectedPaths: ["C:\\main\\.git\\config", "C:\\main\\.git\\hooks"],
		},
	};
	const args = buildLowboxArgs(
		"git commit -m x",
		"C:\\feature",
		"C:\\feature",
		shell,
		linked,
		"C:\\tmp",
		"1234",
	);
	expect(args.slice(args.indexOf("--writable"))).toEqual([
		"--writable",
		"C:\\feature",
		"--writable",
		"C:\\feature",
		"--writable",
		"C:\\tmp",
		"--writable",
		"C:\\main\\.git\\worktrees\\feature",
		"--writable",
		"C:\\main\\.git",
		"--writable",
		"C:\\extra root",
		"--git-protected",
		"C:\\main\\.git\\config",
		"--git-protected",
		"C:\\main\\.git\\hooks",
	]);
});

it("parses escaped structured native failures", () => {
	expect(
		parseLowboxFailure(
			'{"ok":false,"code":"LOWBOX_CREATE_PROCESS","operation":"CreateProcessW","win32":5,"message":"Access is denied.\\r\\n"}',
		),
	).toEqual({
		ok: false,
		code: "LOWBOX_CREATE_PROCESS",
		operation: "CreateProcessW",
		win32: 5,
		message: "Access is denied.\r\n",
	});
});

it("refuses an absent helper with a structured availability error", () => {
	expect(() =>
		resolveLowboxHelperPath({
			platform: "win32",
			executablePath: "Z:\\missing.exe",
			helperPath: undefined,
			allowEmbedded: false,
		}),
	).toThrow(/LOWBOX_HELPER_UNAVAILABLE/);
});

it("refuses unsupported platforms", () => {
	expect(() => resolveLowboxHelperPath({ platform: "darwin" })).toThrow(
		/LOWBOX_HELPER_UNAVAILABLE/,
	);
});

it("materializes the embedded helper under a content-hash dir and reuses it", () => {
	const dir = mkdtempSync(join(tmpdir(), "lowbox-embedded-"));
	// Materialize under a tmpdir base rather than the real home directory —
	// the default base writes to ~/.bound, which is unwritable under the
	// boundless sandbox and pollutes the developer's home dir on every run.
	const base = join(dir, "lowbox-runtime");
	const hash = "embedtest-hash";
	const staged = join(dir, "staged.exe");
	writeFileSync(staged, "MZ-fake-helper-bytes");

	const materialized = materializeLowboxHelper(hash, staged, base);
	expect(materialized).toContain(join("lowbox-runtime", hash));
	expect(existsSync(materialized)).toBe(true);
	expect(readFileSync(materialized, "utf8")).toBe("MZ-fake-helper-bytes");

	// Second call is a no-op even if the staged bytes changed (content-hash
	// directory names separate versions).
	writeFileSync(staged, "MZ-different");
	expect(readFileSync(materializeLowboxHelper(hash, staged, base), "utf8")).toBe(
		"MZ-fake-helper-bytes",
	);

	rmSync(dir, { recursive: true, force: true });
});
