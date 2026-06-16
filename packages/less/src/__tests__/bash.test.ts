import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bashTool, createBashTool } from "../tools/bash";
import { DISABLED_SANDBOX } from "../tools/sandbox";
import { type ResolvedShell, resolveShell } from "../tools/shell";

// CI runners can be slow; ensure per-test timeout is respected
setDefaultTimeout(15000);

// Run against the host's real shell — POSIX `sh` off-Windows, PowerShell (then
// cmd) on Windows — the same resolution the live tool uses. `bashTool` is wired
// to this same `resolveShell(undefined)`, so the suite exercises the platform
// path rather than spawning `sh`, which does not exist on a stock Windows host.
// Commands and a few assertions are shell-aware: PowerShell emits CRLF line
// endings and backslash paths, so the newline- and path-sensitive checks below
// normalize before asserting. (`resolveShell` prefers PowerShell over cmd, and
// powershell.exe ships in System32 on every Windows install, so the non-POSIX
// branch is always the PowerShell one in practice.)
const shell = resolveShell(undefined);
const isPosix = shell.toolName === "boundless_bash";

/** Per-shell command variants for the behaviors each test exercises. */
const cmd = {
	echoHello: "echo hello",
	stdoutAndStderr: isPosix
		? 'echo "to stdout" && echo "to stderr" >&2'
		: 'Write-Output "to stdout"; [Console]::Error.WriteLine("to stderr")',
	exit42: "exit 42",
	sleep: isPosix ? "sleep 60" : "Start-Sleep -Seconds 60",
	// >50KB of newline-separated integers to trip the offload threshold.
	largeOutput: isPosix ? "seq 1 50000" : "1..50000",
	echoSmall: "echo small-output",
	echoTest: "echo test",
	printCwd: isPosix ? "pwd" : "Get-Location | ForEach-Object { $_.Path }",
	echoQuick: "echo quick",
	echoDone: "echo done",
	pipe: isPosix
		? "echo 'line1\nline2\nline3' | sort -r"
		: '"line1","line2","line3" | Sort-Object -Descending',
	echoGuarded: isPosix ? "echo guarded?" : 'echo "guarded?"',
	echoNolog: "echo nolog",
};

/** Collapse CRLF → LF so PowerShell output matches the POSIX assertions. */
const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

describe("boundless_bash", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `boundless-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			// maxRetries/retryDelay, not just force: an aborted command (AC5.10)
			// holds tempDir as its cwd and takes a few ms to release the handle
			// after kill, so the recursive rm races it and throws EBUSY on
			// Windows under load. force alone swallows ENOENT but does not retry
			// EBUSY/EPERM — only maxRetries > 0 does.
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("AC5.9: executes command in cwd and returns stdout/stderr with exit code", async () => {
		const result = await bashTool(
			{ command: cmd.echoHello },
			new AbortController().signal,
			tempDir,
		);

		expect(result.content).toHaveLength(2);
		expect(result.isError).toBeUndefined();
		const provenanceBlock = result.content[0];
		expect(provenanceBlock.type).toBe("text");
		expect(provenanceBlock.text).toContain("[boundless]");
		expect(provenanceBlock.text).toContain(`tool=${shell.toolName}`);

		const contentBlock = result.content[1];
		expect(contentBlock.type).toBe("text");
		expect(contentBlock.text).toContain("Exit code: 0");
		expect(contentBlock.text).toContain("hello");
	});

	it("AC5.9: captures stderr separately", async () => {
		const result = await bashTool(
			{ command: cmd.stdoutAndStderr },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("to stdout");
		expect(contentBlock.text).toContain("to stderr");
		expect(contentBlock.text).toContain("stdout:");
		expect(contentBlock.text).toContain("stderr:");
	});

	it("AC5.9: shows exit code for failed commands", async () => {
		const result = await bashTool({ command: cmd.exit42 }, new AbortController().signal, tempDir);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("Exit code: 42");
	});

	it(
		"AC5.10: aborts on AbortSignal with SIGTERM then SIGKILL",
		async () => {
			const controller = new AbortController();

			// Start the tool and abort after a short delay
			const promise = bashTool({ command: cmd.sleep, timeout: 30000 }, controller.signal, tempDir);

			// Trigger abort after 200ms (should kill the process quickly)
			setTimeout(() => controller.abort(), 200);

			const result = await promise;
			const contentBlock = result.content[1];

			// Process should be terminated, not timed out (exit code should reflect SIGTERM/SIGKILL)
			// On Unix, SIGTERM is signal 15, SIGKILL is signal 9
			// The exit code will be 128 + signal number (e.g., 143 for SIGTERM, 137 for SIGKILL)
			// Or it might be negative on some systems. Just verify it's not 0 and not 30000ms timeout.
			expect(contentBlock.text).toContain("Exit code:");
			expect(contentBlock.text).not.toContain("Exit code: 0");
		},
		{ timeout: 15000 },
	);

	it("AC5.11: offloads output >50KB to a local file and returns a pointer", async () => {
		// seq 1 50000 (or `1..50000` in PowerShell) emits ~280KB+, well over the
		// 50KB offload threshold.
		const result = await bashTool(
			{ command: cmd.largeOutput },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result.content[1];
		const text = contentBlock.text;

		// The in-context result is the short pointer, not the full output.
		expect(text).toContain("Tool result offloaded");
		expect(text).toContain("saved to:");
		expect(text.length).toBeLessThan(2000);

		// The pointer names a real file that holds the FULL output (nothing lost).
		const match = text.match(/saved to: (\S+)/);
		expect(match).not.toBeNull();
		const filePath = match?.[1] as string;
		// PowerShell writes CRLF; normalize so the newline-framed assertions hold
		// on both shells.
		const offloaded = normalizeEol(readFileSync(filePath, "utf-8"));
		expect(offloaded).toContain("Exit code: 0");
		expect(offloaded).toContain("\n1\n");
		expect(offloaded).toContain("\n50000\n");
		rmSync(filePath, { force: true });
	});

	it("does not offload sub-threshold output (returned inline)", async () => {
		const result = await bashTool(
			{ command: cmd.echoSmall },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("small-output");
		expect(contentBlock.text).not.toContain("Tool result offloaded");
	});

	it("AC5.12: always includes provenance block first", async () => {
		const result = await bashTool({ command: cmd.echoTest }, new AbortController().signal, tempDir);

		expect(result.content.length).toBeGreaterThanOrEqual(1);
		const firstBlock = result.content[0];
		expect(firstBlock.type).toBe("text");
		expect(firstBlock.text).toContain("[boundless]");
		expect(firstBlock.text).toContain(shell.toolName);
	});

	it("respects the cwd parameter for command execution", async () => {
		const subdir = join(tempDir, "subdir");
		mkdirSync(subdir);

		const result = await bashTool({ command: cmd.printCwd }, new AbortController().signal, subdir);

		// `sh -c "pwd"` emits forward-slash paths (e.g. `/d/tmp/.../subdir`) while
		// PowerShell's `Get-Location` emits OS-form backslash paths (`C:\...\subdir`).
		// Normalize separators and assert on the unique trailing portion of the
		// path, which is identical across platforms once slashes are unified.
		const contentBlock = result.content[1];
		const out = contentBlock.text.replace(/\\/g, "/");
		expect(out).toContain(`${basename(tempDir)}/subdir`);
	});

	it("handles timeout parameter when provided", async () => {
		const result = await bashTool(
			{ command: cmd.echoQuick, timeout: 1000 },
			new AbortController().signal,
			tempDir,
		);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("Exit code: 0");
		expect(contentBlock.text).toContain("quick");
	});

	it("uses 5 minute default timeout if not provided", async () => {
		// This test just verifies the command runs within default timeout
		const result = await bashTool({ command: cmd.echoDone }, new AbortController().signal, tempDir);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("Exit code: 0");
	});

	it("handles command with complex redirections and pipes", async () => {
		const result = await bashTool({ command: cmd.pipe }, new AbortController().signal, tempDir);

		const contentBlock = result.content[1];
		expect(contentBlock.text).toContain("Exit code: 0");
		expect(contentBlock.text).toContain("line");
	});

	describe("sandbox observability", () => {
		// The host's real shell, matching `bashTool`'s resolution — so the spawn
		// path runs through `sh` off-Windows and PowerShell on Windows rather than
		// a shell that may not exist on the runner.
		const testShell: ResolvedShell = shell;

		// A spy matching the BashEventLogger seam. We assert the spawn path emits
		// a structured event for the policy decision, so "was the write guard on
		// for this command" is answerable from the log rather than from a note
		// that scrolls off the agent's context.
		function makeSpyLogger() {
			const events: Array<{
				level: "info" | "warn";
				event: string;
				fields?: Record<string, unknown>;
			}> = [];
			return {
				events,
				info: (event: string, fields?: Record<string, unknown>) =>
					events.push({ level: "info", event, fields }),
				warn: (event: string, fields?: Record<string, unknown>) =>
					events.push({ level: "warn", event, fields }),
			};
		}

		it("emits sandbox_disabled when the sandbox is opted out (DISABLED_SANDBOX)", async () => {
			const spy = makeSpyLogger();
			// DISABLED_SANDBOX is the default; pass it explicitly with the logger.
			const tool = createBashTool("test-host", testShell, DISABLED_SANDBOX, spy);
			const result = await tool(
				{ command: cmd.echoGuarded },
				new AbortController().signal,
				tempDir,
			);

			expect(result.isError).toBeUndefined();
			const disabled = spy.events.find((e) => e.event === "sandbox_disabled");
			expect(disabled).toBeDefined();
			expect(disabled?.level).toBe("info");
			expect(disabled?.fields?.cwd).toBe(tempDir);
			// The happy/enforcement and passthrough events must NOT fire here.
			expect(spy.events.some((e) => e.event === "sandbox_spawn")).toBe(false);
			expect(spy.events.some((e) => e.event === "sandbox_passthrough")).toBe(false);
		});

		it("emits nothing when no logger is supplied (logging is opt-in)", async () => {
			// Smoke: the spawn path must not throw when logger is undefined.
			const tool = createBashTool("test-host", testShell, DISABLED_SANDBOX);
			const result = await tool({ command: cmd.echoNolog }, new AbortController().signal, tempDir);
			expect(result.isError).toBeUndefined();
			expect(result.content[1].text).toContain("Exit code: 0");
		});
	});
});
