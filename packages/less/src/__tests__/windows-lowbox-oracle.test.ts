import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { kill } from "node:process";
import { createBashTool } from "../tools/bash";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import { resolveShell } from "../tools/shell";

async function waitForClose(child: ChildProcess | undefined, timeoutMs = 10_000): Promise<void> {
	if (!child) return;
	if (child.exitCode === null && child.signalCode === null) {
		await Promise.race([
			new Promise<void>((resolve) => child.once("close", () => resolve())),
			Bun.sleep(timeoutMs).then(() => {
				throw new Error(`process ${child.pid ?? "unknown"} did not close within ${timeoutMs}ms`);
			}),
		]);
	}
	for (const stream of child.stdio) stream?.destroy();
}

async function stopAndClose(child: ChildProcess | undefined): Promise<void> {
	if (!child) return;
	for (const stream of child.stdio) stream?.destroy();
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	try {
		await waitForClose(child);
	} finally {
		for (const stream of child.stdio) stream?.destroy();
		child.removeAllListeners();
	}
}

async function removeFixtureAfterHandlesClose(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(50);
		}
	}
	throw lastError;
}

type CleanupState = { Journal: boolean; Profile: boolean; LowboxAces: number };

function collectControlLines(control: NodeJS.ReadableStream): {
	lines: string[];
	waitForFirstLine: (timeoutMs?: number) => Promise<string>;
} {
	const lines: string[] = [];
	let pending = "";
	control.setEncoding("utf8");
	control.on("data", (chunk: string) => {
		pending += chunk;
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			lines.push(pending.slice(0, newline));
			pending = pending.slice(newline + 1);
		}
	});
	control.on("end", () => {
		if (pending) lines.push(pending);
		pending = "";
	});
	return {
		lines,
		waitForFirstLine: async (timeoutMs = 10_000) => {
			const deadline = Date.now() + timeoutMs;
			while (lines.length === 0 && Date.now() < deadline) await Bun.sleep(10);
			if (lines.length === 0) throw new Error("helper readiness timed out");
			return lines[0] as string;
		},
	};
}

function watcherDiagnostics(lines: string[]): string {
	return lines.slice(1).join("\n");
}

function inspectCleanup(
	helper: string,
	profile: string,
	path: string,
	namespace: string,
): CleanupState {
	const probe = spawnSync(
		helper,
		["inspect-cleanup", "--profile", profile, "--path", path, "--test-namespace", namespace],
		{ encoding: "utf8", windowsHide: true },
	);
	expect(
		probe.status,
		`inspect-cleanup status=${probe.status}\nstdout=${probe.stdout}\nstderr=${probe.stderr}`,
	).toBe(0);
	return JSON.parse(probe.stdout) as CleanupState;
}

async function waitForCleanup(
	helper: string,
	profile: string,
	path: string,
	namespace: string,
	timeoutMs = 10_000,
): Promise<CleanupState> {
	const deadline = Date.now() + timeoutMs;
	let cleanup = inspectCleanup(helper, profile, path, namespace);
	while (cleanup.Journal || cleanup.Profile || cleanup.LowboxAces !== 0) {
		if (Date.now() >= deadline) return cleanup;
		await Bun.sleep(50);
		cleanup = inspectCleanup(helper, profile, path, namespace);
	}
	return cleanup;
}

function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function psTryWrite(id: string, path: string, value: string): string {
	return `try { Set-Content -LiteralPath ${psLiteral(path)} -Value ${psLiteral(value)} -ErrorAction Stop; ${psLiteral(`${id}=OK`)} } catch { ${psLiteral(`${id}=DENIED`)} }`;
}

/**
 * Wait up to `timeoutMs` for `pid` to stop running, returning the observed
 * terminal state plus a diagnostic string for assertion messages.
 *
 * Two earlier instruments both flaked here. `kill(pid, 0)` alone is wrong on
 * Windows: a process OBJECT outlives termination while any handle to it stays
 * open, so a reaped descendant still resolves. Polling `tasklist.exe` instead
 * was worse — a 20ms poll against a 10s deadline spawns up to 500 processes on
 * a 2-core runner, manufacturing the very contention it measures, and its
 * `probe.status !== 0 => still alive` fail-closed branch turned each of its own
 * spawn failures into a false "survived" verdict (CI #1138, #1140, #1143).
 *
 * So: ONE child process, and let the OS do the waiting on a real handle.
 * `Get-Process` fails for an already-reaped pid (GONE); otherwise
 * `WaitForExit(ms)` blocks on the process handle and reports whether it exited
 * within the budget. A pid that has been recycled onto a different process is
 * reported as RECYCLED rather than counted as a survivor, since the descendant
 * we care about is identified by start time as well as pid.
 */
function waitForProcessExit(
	pid: number,
	timeoutMs: number,
	startedBeforeMs?: number,
): { running: boolean; state: string; detail: string } {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"try {",
		`  $p = Get-Process -Id ${pid} -ErrorAction Stop`,
		"  $started = try { $p.StartTime.ToUniversalTime().ToString('o') } catch { 'unknown' }",
		`  if ($p.WaitForExit(${timeoutMs})) { "EXITED|$started" } else { "ALIVE|$started|$($p.ProcessName)" }`,
		"} catch [Microsoft.PowerShell.Commands.ProcessCommandException] { 'GONE|' }",
		'catch { "PROBE_ERROR|$($_.Exception.Message)" }',
	].join("\n");
	const probe = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
		encoding: "utf8",
		windowsHide: true,
		// Give the child room beyond its own WaitForExit budget so a slow
		// PowerShell start-up isn't misread as an unfinished wait.
		timeout: timeoutMs + 20_000,
	});
	const raw = `${probe.stdout ?? ""}`.trim();
	const [state = "", started = "", name = ""] = raw.split("|");
	const detail = `pid=${pid} probe=${JSON.stringify(raw)} status=${probe.status} stderr=${JSON.stringify(`${probe.stderr ?? ""}`.trim().slice(0, 400))}`;

	// GONE / EXITED are the two ways the descendant is legitimately dead.
	if (state === "GONE" || state === "EXITED") return { running: false, state, detail };
	if (state === "ALIVE") {
		// A pid reused by a process that started AFTER our descendant was launched
		// is not our descendant surviving.
		const startedMs = Date.parse(started);
		if (
			startedBeforeMs !== undefined &&
			Number.isFinite(startedMs) &&
			startedMs > startedBeforeMs
		) {
			return { running: false, state: `RECYCLED(${name})`, detail };
		}
		return { running: true, state, detail };
	}
	// An unreadable probe must not be reported as death — that would let a real
	// escape through the gate — but it is reported as its own state so a failure
	// message distinguishes "descendant alive" from "could not tell".
	return { running: true, state: state || "NO_OUTPUT", detail };
}

/**
 * Mandatory windows-latest oracle for the production Windows sandbox path.
 *
 * This suite deliberately has no availability probe, skip, or passthrough mode:
 * before the bound-owned lowbox backend exists, the Windows lane must stay red.
 */
describe.skipIf(process.platform !== "win32")("Windows AppContainer lowbox oracle", () => {
	it("round-trips and rejects malformed Recoverable authority journals", () => {
		const helper = process.env.BOUND_LOWBOX_HELPER;
		expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
		expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

		const probe = spawnSync(helper as string, ["self-test-authority-journal"], {
			encoding: "utf8",
			windowsHide: true,
		});
		expect(probe.status, probe.stderr || probe.stdout).toBe(0);
		expect(JSON.parse(probe.stdout)).toEqual({ ok: true });
	});

	describe("normal completion", () => {
		it("observes child death before authority cleanup", async () => {
			const helper = process.env.BOUND_LOWBOX_HELPER;
			expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
			expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

			const runId = randomBytes(8).toString("hex");
			const cwd = join(tmpdir(), `bound-lowbox-normal-${runId}`);
			mkdirSync(cwd, { recursive: true });
			const marker = join(cwd, "normal-ready.txt");
			const controlFd = 3;
			let normal: ChildProcess | undefined;
			try {
				normal = spawn(
					helper as string,
					[
						"spawn",
						"--control-handle",
						String(controlFd),
						"--cwd",
						cwd,
						"--shell",
						resolveShell(undefined).command,
						"--shell-flag",
						resolveShell(undefined).execFlag,
						"--command",
						`Set-Content -Path '${marker}' -Value ready; Start-Sleep -Milliseconds 500`,
						"--network",
						"blocked",
						"--writable",
						cwd,
						"--test-namespace",
						runId,
					],
					{
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				const control = normal.stdio[controlFd];
				expect(control, "helper control pipe is unavailable").toBeTruthy();
				const controlReports = collectControlLines(control as NodeJS.ReadableStream);
				const readyLine = await controlReports.waitForFirstLine();
				const ready = JSON.parse(readyLine) as { ok?: boolean; pid?: number; profile?: string };
				expect(ready.ok, readyLine).toBe(true);
				const childPid = ready.pid as number;
				const profile = ready.profile as string;
				let childDeadAt = 0;
				let cleanupObservedAt = 0;
				let cleanup: { Journal: boolean; Profile: boolean; LowboxAces: number } | undefined;
				const observationDeadline = Date.now() + 10_000;
				do {
					let childAlive = true;
					try {
						kill(childPid, 0);
					} catch {
						childAlive = false;
						if (childDeadAt === 0) childDeadAt = Date.now();
					}
					const cleanupProbe = spawnSync(
						helper as string,
						["inspect-cleanup", "--profile", profile, "--path", cwd, "--test-namespace", runId],
						{ encoding: "utf8", windowsHide: true },
					);
					expect(
						cleanupProbe.status,
						`inspect-cleanup status=${cleanupProbe.status}\nstdout=${cleanupProbe.stdout}\nstderr=${cleanupProbe.stderr}`,
					).toBe(0);
					cleanup = JSON.parse(cleanupProbe.stdout);
					if (!cleanup.Journal && !cleanup.Profile && cleanup.LowboxAces === 0) {
						cleanupObservedAt = Date.now();
						expect(childAlive, "normal cleanup completed while the lowbox child was alive").toBe(
							false,
						);
						break;
					}
					await Bun.sleep(50);
				} while (Date.now() < observationDeadline);
				await waitForClose(normal);
				expect(cleanup, watcherDiagnostics(controlReports.lines)).toEqual({
					Journal: false,
					Profile: false,
					LowboxAces: 0,
				});
				expect(cleanupObservedAt, watcherDiagnostics(controlReports.lines)).toBeGreaterThanOrEqual(
					childDeadAt,
				);
			} finally {
				await stopAndClose(normal);
				await removeFixtureAfterHandlesClose(cwd);
			}
		});
	});

	describe("post-materialization failure", () => {
		it("keeps authority until the suspended child is dead", async () => {
			const helper = process.env.BOUND_LOWBOX_HELPER;
			expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
			expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

			const runId = randomBytes(8).toString("hex");
			const cwd = join(tmpdir(), `bound-lowbox-failure-${runId}`);
			mkdirSync(cwd, { recursive: true });
			const controlFd = 3;
			let failed: ChildProcess | undefined;
			try {
				failed = spawn(
					helper as string,
					[
						"spawn",
						"--control-handle",
						String(controlFd),
						"--cwd",
						cwd,
						"--shell",
						resolveShell(undefined).command,
						"--shell-flag",
						resolveShell(undefined).execFlag,
						"--command",
						"Start-Sleep -Seconds 30",
						"--network",
						"blocked",
						"--writable",
						cwd,
						"--test-namespace",
						runId,
					],
					{
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						windowsHide: true,
						env: {
							...process.env,
							BOUND_LOWBOX_TEST_FAIL_AFTER_WATCHER: "1",
						},
					},
				);
				const control = failed.stdio[controlFd];
				expect(control, "helper control pipe is unavailable").toBeTruthy();
				const controlReports = collectControlLines(control as NodeJS.ReadableStream);
				const readyLine = await controlReports.waitForFirstLine();
				const ready = JSON.parse(readyLine) as { ok?: boolean; pid?: number; profile?: string };
				expect(ready.ok, readyLine).toBe(true);
				const childPid = ready.pid as number;
				const profile = ready.profile as string;
				let childDeadAt = 0;
				let cleanupObservedAt = 0;
				let cleanup: { Journal: boolean; Profile: boolean; LowboxAces: number } | undefined;
				const observationDeadline = Date.now() + 10_000;
				do {
					let childAlive = true;
					try {
						kill(childPid, 0);
					} catch {
						childAlive = false;
						if (childDeadAt === 0) childDeadAt = Date.now();
					}
					const cleanupProbe = spawnSync(
						helper as string,
						["inspect-cleanup", "--profile", profile, "--path", cwd, "--test-namespace", runId],
						{ encoding: "utf8", windowsHide: true },
					);
					expect(
						cleanupProbe.status,
						`inspect-cleanup status=${cleanupProbe.status}\nstdout=${cleanupProbe.stdout}\nstderr=${cleanupProbe.stderr}`,
					).toBe(0);
					cleanup = JSON.parse(cleanupProbe.stdout);
					if (!cleanup.Journal && !cleanup.Profile && cleanup.LowboxAces === 0) {
						cleanupObservedAt = Date.now();
						expect(childAlive, "failure cleanup completed while the lowbox child was alive").toBe(
							false,
						);
						break;
					}
					await Bun.sleep(50);
				} while (Date.now() < observationDeadline);
				await waitForClose(failed);
				expect(cleanup, watcherDiagnostics(controlReports.lines)).toEqual({
					Journal: false,
					Profile: false,
					LowboxAces: 0,
				});
				expect(cleanupObservedAt, watcherDiagnostics(controlReports.lines)).toBeGreaterThanOrEqual(
					childDeadAt,
				);
			} finally {
				await stopAndClose(failed);
				await removeFixtureAfterHandlesClose(cwd);
			}
		});
	});

	describe("watcher startup failure", () => {
		it("times out an unarmed watcher and leaves Transferring authority fail-closed", async () => {
			const helper = process.env.BOUND_LOWBOX_HELPER;
			expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
			expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

			const runId = randomBytes(8).toString("hex");
			const cwd = join(tmpdir(), `bound-lowbox-watcher-timeout-${runId}`);
			mkdirSync(cwd, { recursive: true });
			const controlFd = 3;
			const startedAt = Date.now();
			let failed: ChildProcess | undefined;
			try {
				failed = spawn(
					helper as string,
					[
						"spawn",
						"--control-handle",
						String(controlFd),
						"--cwd",
						cwd,
						"--shell",
						resolveShell(undefined).command,
						"--shell-flag",
						resolveShell(undefined).execFlag,
						"--command",
						"Start-Sleep -Seconds 30",
						"--network",
						"blocked",
						"--writable",
						cwd,
						"--test-namespace",
						runId,
					],
					{
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						windowsHide: true,
						env: {
							...process.env,
							BOUND_LOWBOX_TEST_WATCHER_NEVER_ARMS: "1",
						},
					},
				);
				const control = failed.stdio[controlFd];
				expect(control, "helper control pipe is unavailable").toBeTruthy();
				const failureLine = await new Promise<string>((resolve, reject) => {
					let pending = "";
					// The helper reports its unarmed-watcher timeout only after the watcher
					// deadline elapses, so this is a contention-sensitive wait, not a fast
					// assertion. The oracle step has been observed at 17s and at 41s on the
					// same runner image; a 15s ceiling failed on the slow end (CI #1156).
					const timeout = setTimeout(
						() => reject(new Error("watcher timeout was not reported")),
						30_000,
					);
					control?.setEncoding("utf8");
					control?.on("data", (chunk: string) => {
						pending += chunk;
						const newline = pending.indexOf("\n");
						if (newline < 0) return;
						clearTimeout(timeout);
						resolve(pending.slice(0, newline));
					});
					failed?.once("error", reject);
				});
				expect(failureLine).toContain('"code":"LOWBOX_WATCHER_INDETERMINATE"');
				expect(Date.now() - startedAt).toBeLessThan(15_000);
				await waitForClose(failed);
				expect(failed.exitCode).toBe(125);
				const journal = spawnSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-Command",
						`$journal = Get-ChildItem -Path $env:TEMP -Filter 'bound-lowbox-${runId}-Bound.Lowbox.*.authority' | Select-Object -First 1; if (-not $journal) { exit 2 }; $lines = @(Get-Content -LiteralPath $journal.FullName); if ($lines.Count -lt 2) { exit 3 }; Write-Output $lines[0].Trim(); Write-Output $lines[1].Trim()`,
					],
					{ encoding: "utf8", windowsHide: true },
				);
				expect(journal.status, journal.stderr).toBe(0);
				expect(journal.stdout.trim().split(/\r?\n/)).toEqual([
					"bound-lowbox-authority-v1",
					"transferring",
				]);
			} finally {
				await stopAndClose(failed);
				await removeFixtureAfterHandlesClose(cwd);
			}
		});
	});

	it("uses the helper protocol, preserves streams, and recovers after helper death", async () => {
		const helper = process.env.BOUND_LOWBOX_HELPER;
		expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
		expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

		const runId = randomBytes(8).toString("hex");
		const cwd = join(tmpdir(), `bound-lowbox-oracle-${runId}`);
		mkdirSync(cwd, { recursive: true });
		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [],
			network: "open",
			onUnavailable: "error",
		};
		const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
		const logger = {
			info: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
			warn: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
		};
		let crash: ChildProcess | undefined;
		let crashProfile: string | undefined;
		try {
			const tool = createBashTool(
				"windows-latest",
				resolveShell(undefined),
				sandbox,
				logger,
				runId,
			);
			const result = await tool(
				{
					command:
						'[Console]::Out.WriteLine("LOWBOX_STDOUT"); [Console]::Error.WriteLine("LOWBOX_STDERR")',
					timeout: 30_000,
				},
				new AbortController().signal,
				cwd,
			);

			const spawnEvent = events.findLast((entry) => entry.event === "sandbox_spawn");
			const backend = spawnEvent?.fields?.backend;
			expect(backend, "appcontainer_lowbox was not selected").toBe("appcontainer_lowbox");
			expect(result.isError, "appcontainer_lowbox execution failed").toBeUndefined();

			const output = result.content[1]?.text ?? "";
			const stdout = output.match(/stdout:\n([\s\S]*?)(?:\n\nstderr:|$)/)?.[1] ?? "";
			const stderr = output.match(/stderr:\n([\s\S]*)$/)?.[1] ?? "";
			expect(stdout).toContain("LOWBOX_STDOUT");
			expect(stdout).not.toContain("LOWBOX_STDERR");
			expect(stderr).toContain("LOWBOX_STDERR");
			expect(stderr).not.toContain("LOWBOX_STDOUT");

			const marker = join(cwd, "helper-ready.txt");
			const controlFd = 3;
			crash = spawn(
				helper as string,
				[
					"spawn",
					"--control-handle",
					String(controlFd),
					"--cwd",
					cwd,
					"--shell",
					resolveShell(undefined).command,
					"--shell-flag",
					resolveShell(undefined).execFlag,
					"--command",
					`Set-Content -Path '${marker}' -Value ready; Start-Sleep -Seconds 30`,
					"--network",
					"blocked",
					"--writable",
					cwd,
					"--test-namespace",
					runId,
				],
				{ stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true },
			);
			const control = crash.stdio[controlFd];
			expect(control, "helper control pipe is unavailable").toBeTruthy();
			const readyLine = await new Promise<string>((resolve, reject) => {
				let pending = "";
				const timeout = setTimeout(() => reject(new Error("helper readiness timed out")), 10_000);
				control?.setEncoding("utf8");
				control?.on("data", (chunk: string) => {
					pending += chunk;
					const newline = pending.indexOf("\n");
					if (newline < 0) return;
					clearTimeout(timeout);
					resolve(pending.slice(0, newline));
				});
				crash?.once("error", reject);
				crash?.once("exit", (code) =>
					reject(new Error(`helper exited before readiness (${code})`)),
				);
			});
			const ready = JSON.parse(readyLine) as { ok?: boolean; pid?: number; profile?: string };
			crashProfile = ready.profile;
			expect(ready.ok, readyLine).toBe(true);
			expect(typeof ready.pid).toBe("number");
			expect(ready.profile).toMatch(/^Bound\.Lowbox\./);
			const childPid = ready.pid as number;
			expect(
				() => kill(childPid, 0),
				"lowbox child was not alive at helper readiness",
			).not.toThrow();
			crash.kill();
			await waitForClose(crash);

			const profile = ready.profile as string;
			const observationDeadline = Date.now() + 10_000;
			let childAlive = true;
			let childDeadAt = 0;
			let cleanupObservedAt = 0;
			let cleanup: { Journal: boolean; Profile: boolean; LowboxAces: number } | undefined;
			do {
				try {
					kill(childPid, 0);
				} catch {
					childAlive = false;
					if (childDeadAt === 0) childDeadAt = Date.now();
				}

				const cleanupProbe = spawnSync(
					helper as string,
					["inspect-cleanup", "--profile", profile, "--path", cwd, "--test-namespace", runId],
					{ encoding: "utf8", windowsHide: true },
				);
				expect(
					cleanupProbe.status,
					`inspect-cleanup status=${cleanupProbe.status}\nstdout=${cleanupProbe.stdout}\nstderr=${cleanupProbe.stderr}`,
				).toBe(0);
				cleanup = JSON.parse(cleanupProbe.stdout);
				if (!cleanup.Journal && !cleanup.Profile && cleanup.LowboxAces === 0) {
					cleanupObservedAt = Date.now();
					expect(childAlive, "authority cleanup completed while the lowbox child was alive").toBe(
						false,
					);
					break;
				}
				await Bun.sleep(100);
			} while (Date.now() < observationDeadline);
			expect(childAlive, "lowbox child survived helper death and job closure").toBe(false);
			expect(cleanup).toEqual({ Journal: false, Profile: false, LowboxAces: 0 });
			expect(cleanupObservedAt).toBeGreaterThanOrEqual(childDeadAt);
		} finally {
			await stopAndClose(crash);
			if (crashProfile) {
				const cleanup = await waitForCleanup(helper as string, crashProfile, cwd, runId);
				expect(cleanup).toEqual({ Journal: false, Profile: false, LowboxAces: 0 });
			}
			await removeFixtureAfterHandlesClose(cwd);
		}
	});

	it("confines writes to explicit roots and preserves protected git control surfaces", async () => {
		const helper = process.env.BOUND_LOWBOX_HELPER;
		expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
		expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

		const runId = randomBytes(8).toString("hex");
		const fixture = join(tmpdir(), `bound-lowbox-confinement-${runId}`);
		const cwd = join(fixture, "repo");
		const configuredTemp = join(fixture, "configured-temp");
		const extraWritable = join(fixture, "extra-writable");
		const sibling = join(fixture, "sibling-denied");
		const absoluteHome = join(process.env.USERPROFILE as string, `bound-lowbox-home-${runId}.txt`);
		const junction = join(cwd, "escape-junction");
		const git = join(cwd, ".git");
		const gitConfig = join(git, "config");
		const preCommit = join(git, "hooks", "pre-commit");
		const commitMsg = join(git, "hooks", "commit-msg");
		const nestedHooks = join(git, "hooks", "nested");
		const nestedHook = join(nestedHooks, "pre-push");
		const newHook = join(git, "hooks", "post-commit");
		const mutableGitTargets = [
			join(git, "index"),
			join(git, "index.lock"),
			join(git, "packed-refs"),
			join(git, "packed-refs.lock"),
			join(git, "refs", "heads", "s3"),
			join(git, "refs", "heads", "s3.lock"),
			join(git, "logs", "HEAD"),
			join(git, "logs", "HEAD.lock"),
			join(git, "objects", "aa", "object"),
			join(git, "objects", "aa", "object.lock"),
		];
		const configBytes = Buffer.from("[core]\n\trepositoryformatversion = 0\n", "utf8");
		const hookBytes = Buffer.from("#!/bin/sh\nexit 0\n", "utf8");
		const secondHookBytes = Buffer.from("#!/bin/sh\necho commit-msg\n", "utf8");
		const nestedHookBytes = Buffer.from("#!/bin/sh\necho pre-push\n", "utf8");
		for (const path of [
			cwd,
			configuredTemp,
			extraWritable,
			sibling,
			join(git, "hooks"),
			nestedHooks,
			join(git, "refs", "heads"),
			join(git, "logs"),
			join(git, "objects", "aa"),
		]) {
			mkdirSync(path, { recursive: true });
		}
		writeFileSync(gitConfig, configBytes);
		writeFileSync(preCommit, hookBytes);
		writeFileSync(commitMsg, secondHookBytes);
		writeFileSync(nestedHook, nestedHookBytes);
		const junctionProbe = spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", junction, sibling], {
			encoding: "utf8",
			windowsHide: true,
		});
		expect(junctionProbe.status, junctionProbe.stderr || junctionProbe.stdout).toBe(0);

		const allowed = [
			["cwd", join(cwd, "cwd.txt")],
			["temp", join(configuredTemp, "temp.txt")],
			["extra", join(extraWritable, "extra.txt")],
		] as const;
		const denied = [
			["home", absoluteHome],
			["sibling", join(sibling, "absolute.txt")],
			["traversal", resolve(cwd, "..", "sibling-denied", "traversal.txt")],
			["junction", join(junction, "junction.txt")],
		] as const;
		const mutableGit = mutableGitTargets.map((path, index) => [`git-${index}`, path] as const);
		const protectedGitOperations = [
			["config-modify", psTryWrite("config-modify", gitConfig, "tampered")],
			["pre-commit-modify", psTryWrite("pre-commit-modify", preCommit, "tampered")],
			["commit-msg-modify", psTryWrite("commit-msg-modify", commitMsg, "tampered")],
			["nested-hook-modify", psTryWrite("nested-hook-modify", nestedHook, "tampered")],
			[
				"nested-hook-append",
				`try { Add-Content -LiteralPath ${psLiteral(nestedHook)} -Value 'tampered' -ErrorAction Stop; 'nested-hook-append=OK' } catch { 'nested-hook-append=DENIED' }`,
			],
			[
				"nested-hook-delete",
				`try { Remove-Item -LiteralPath ${psLiteral(nestedHook)} -Force -ErrorAction Stop; 'nested-hook-delete=OK' } catch { 'nested-hook-delete=DENIED' }`,
			],
			["hook-create", psTryWrite("hook-create", newHook, "tampered")],
		] as const;
		const assertions = [
			...allowed.map(([id, path]) => psTryWrite(id, path, "allowed")),
			...denied.map(([id, path]) => psTryWrite(id, path, "denied")),
			...mutableGit.map(([id, path]) => psTryWrite(id, path, "mutable")),
			`try { if ((Get-Content -LiteralPath ${psLiteral(gitConfig)} -Raw) -eq ${psLiteral(configBytes.toString())}) { 'config-read=OK' } else { 'config-read=WRONG' } } catch { 'config-read=DENIED' }`,
			`try { if ((Get-Content -LiteralPath ${psLiteral(preCommit)} -Raw) -eq ${psLiteral(hookBytes.toString())}) { 'pre-commit-read=OK' } else { 'pre-commit-read=WRONG' } } catch { 'pre-commit-read=DENIED' }`,
			`try { if ((Get-Content -LiteralPath ${psLiteral(commitMsg)} -Raw) -eq ${psLiteral(secondHookBytes.toString())}) { 'commit-msg-read=OK' } else { 'commit-msg-read=WRONG' } } catch { 'commit-msg-read=DENIED' }`,
			`try { if ((Get-Content -LiteralPath ${psLiteral(nestedHook)} -Raw) -eq ${psLiteral(nestedHookBytes.toString())}) { 'nested-hook-read=OK' } else { 'nested-hook-read=WRONG' } } catch { 'nested-hook-read=DENIED' }`,
			...protectedGitOperations.map(([, operation]) => operation),
		].join("; ");
		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [extraWritable],
			network: "blocked",
			onUnavailable: "error",
		};
		// Capture the spawn path's structured events. `trySandboxedViaLowbox`
		// swallows the real setup failure into a `null` return, so the refusal the
		// tool surfaces says only "AppContainer lowbox unavailable" — useless when
		// this fails intermittently on a runner. Folding `lowbox_unavailable`'s
		// reason into the assertion message is the difference between a
		// diagnosable flake and a red board with no cause (CI #1136).
		const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
		const logger = {
			info: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
			warn: (event: string, fields?: Record<string, unknown>) => events.push({ event, fields }),
		};
		const diagnose = () =>
			events
				.filter((entry) => entry.event !== "sandbox_spawn")
				.map((entry) => `${entry.event}: ${JSON.stringify(entry.fields)}`)
				.join("\n") || "(no lowbox diagnostics emitted)";
		try {
			const priorTemp = process.env.TEMP;
			process.env.TEMP = configuredTemp;
			try {
				const tool = createBashTool(
					"windows-latest",
					resolveShell(undefined),
					sandbox,
					logger,
					runId,
				);
				const result = await tool(
					{ command: assertions, timeout: 30_000 },
					new AbortController().signal,
					cwd,
				);
				const spawnEvent = events.findLast((entry) => entry.event === "sandbox_spawn");
				expect(
					spawnEvent?.fields?.backend,
					`appcontainer_lowbox was not selected\n${diagnose()}`,
				).toBe("appcontainer_lowbox");
				expect(result.isError, `${result.content[1]?.text}\n${diagnose()}`).toBeUndefined();
				const outcomes = new Set(
					(result.content[1]?.text ?? "").split(/\r?\n/).map((line) => line.trim()),
				);
				for (const [id] of allowed) expect(outcomes.has(`${id}=OK`), id).toBe(true);
				for (const [id] of denied) expect(outcomes.has(`${id}=DENIED`), id).toBe(true);
				for (const [id] of mutableGit) expect(outcomes.has(`${id}=OK`), id).toBe(true);
				for (const id of ["config-read", "pre-commit-read", "commit-msg-read", "nested-hook-read"])
					expect(outcomes.has(`${id}=OK`), id).toBe(true);
				for (const [id] of protectedGitOperations) {
					expect(
						outcomes.has(`${id}=DENIED`),
						`${id}: expected DENIED; outcomes=${[...outcomes].join(", ")}`,
					).toBe(true);
				}
			} finally {
				if (priorTemp === undefined) process.env.TEMP = undefined;
				else process.env.TEMP = priorTemp;
			}
			for (const [, path] of allowed) expect(existsSync(path), path).toBe(true);
			for (const path of mutableGitTargets) expect(existsSync(path), path).toBe(true);
			for (const [, path] of denied) expect(existsSync(path), path).toBe(false);
			expect(existsSync(newHook), newHook).toBe(false);
			expect(readFileSync(gitConfig)).toEqual(configBytes);
			expect(readFileSync(preCommit)).toEqual(hookBytes);
			expect(readFileSync(commitMsg)).toEqual(secondHookBytes);
			expect(readFileSync(nestedHook)).toEqual(nestedHookBytes);
		} finally {
			rmSync(absoluteHome, { force: true });
			await removeFixtureAfterHandlesClose(fixture);
		}
	});

	it("rejects a hooks-root junction before traversing its target", async () => {
		const helper = process.env.BOUND_LOWBOX_HELPER;
		expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
		expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

		const runId = randomBytes(8).toString("hex");
		const fixture = join(tmpdir(), `bound-lowbox-hooks-junction-${runId}`);
		const cwd = join(fixture, "repo");
		const git = join(cwd, ".git");
		const junctionTarget = join(fixture, "hooks-target");
		const sentinel = join(junctionTarget, "sentinel");
		mkdirSync(git, { recursive: true });
		mkdirSync(sentinel, { recursive: true });
		writeFileSync(join(sentinel, "pre-commit"), "target must not be traversed");
		const junctionProbe = spawnSync(
			"cmd.exe",
			["/d", "/c", "mklink", "/J", join(git, "hooks"), junctionTarget],
			{ encoding: "utf8", windowsHide: true },
		);
		expect(junctionProbe.status, junctionProbe.stderr || junctionProbe.stdout).toBe(0);

		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [],
			network: "blocked",
			onUnavailable: "error",
		};
		try {
			const tool = createBashTool(
				"windows-latest",
				resolveShell(undefined),
				sandbox,
				undefined,
				runId,
			);
			const result = await tool(
				{ command: "Write-Output should-not-run", timeout: 30_000 },
				new AbortController().signal,
				cwd,
			);
			expect(result.isError).toBe(true);
			const output = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			expect(output).not.toContain("should-not-run");
			expect(readFileSync(join(sentinel, "pre-commit"), "utf8")).toBe(
				"target must not be traversed",
			);
		} finally {
			await removeFixtureAfterHandlesClose(fixture);
		}
	});

	it("cancellation kills the complete job tree before delayed descendant output", async () => {
		const helper = process.env.BOUND_LOWBOX_HELPER;
		expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
		expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);
		const runId = randomBytes(8).toString("hex");
		const cwd = join(tmpdir(), `bound-lowbox-cancel-tree-${runId}`);
		mkdirSync(cwd, { recursive: true });
		const pidFile = join(cwd, "descendant.pid");
		const sentinel = join(cwd, "descendant-sentinel.txt");
		const controller = new AbortController();
		const sandbox: ResolvedSandboxConfig = {
			enabled: true,
			writablePaths: [],
			network: "blocked",
			onUnavailable: "error",
		};
		try {
			const tool = createBashTool(
				"windows-latest",
				resolveShell(undefined),
				sandbox,
				undefined,
				runId,
			);
			// The descendant must PROVE it is executing, not merely own a pid.
			//
			// Every earlier shape of this test trusted `$child.Id` from
			// `Start-Process -PassThru`, which is published by the PARENT the instant
			// CreateProcess returns and says nothing about whether the child ever ran
			// its script. A Windows process object also outlives termination while any
			// handle stays open, so `kill(pid, 0)` kept reporting a dead descendant as
			// alive and the precondition passed vacuously for weeks. When the probe was
			// tightened to a real handle wait it reported EXITED ~1s after launch
			// against a 25s sleep (CI #1155) — the descendant had never been running.
			//
			// The descendant must PROVE it is executing, not merely own a pid.
			// Use a tiny native mode in the freshly-built helper rather than nesting
			// PowerShell inside PowerShell. CI #1157/#1158 proved Start-Process rejects
			// that quoting-sensitive launch with ERROR_INVALID_NAME before a child
			// exists; the native child takes only ordinary path + integer arguments,
			// writes its started marker itself, waits, then writes the sentinel unless
			// the enclosing job kills it.
			const startedMarker = join(cwd, "descendant-started.txt");
			const spawnDiag = join(cwd, "descendant-spawn.txt");
			const sentinelDelayMs = 25_000;
			const helperPath = helper as string;
			const command = [
				"$ErrorActionPreference = 'Stop'",
				"try {",
				`  $child = Start-Process -FilePath ${psLiteral(helperPath)} -PassThru -NoNewWindow -ArgumentList @('test-descendant','--started',${psLiteral(startedMarker)},'--sentinel',${psLiteral(sentinel)},'--delay-ms','${sentinelDelayMs}')`,
				`  Set-Content -LiteralPath ${psLiteral(pidFile)} -Value $child.Id`,
				"  Start-Sleep -Milliseconds 750",
				"  $child.Refresh()",
				"  $exit = if ($child.HasExited) { $child.ExitCode } else { '<running>' }",
				`  Set-Content -LiteralPath ${psLiteral(spawnDiag)} -Value "spawned pid=$($child.Id) hasExited=$($child.HasExited) exitCode=$exit"`,
				"} catch {",
				`  Set-Content -LiteralPath ${psLiteral(spawnDiag)} -Value "Start-Process threw: $($_.Exception.GetType().FullName): $($_.Exception.Message)"`,
				"}",
				"Start-Sleep -Seconds 60",
			].join("\n");
			const running = tool({ command, timeout: 45_000 }, controller.signal, cwd);
			const deadline = Date.now() + 20_000;
			while ((!existsSync(pidFile) || !existsSync(startedMarker)) && Date.now() < deadline) {
				await Bun.sleep(20);
			}
			const readIfPresent = (path: string): string =>
				existsSync(path) ? readFileSync(path, "utf8").trim().slice(0, 600) : "<absent>";
			const spawnEvidence = () => `spawn=${JSON.stringify(readIfPresent(spawnDiag))}`;
			expect(existsSync(pidFile), `descendant pid was not published (${spawnEvidence()})`).toBe(
				true,
			);
			expect(
				existsSync(startedMarker),
				`native descendant never executed inside the lowbox (${spawnEvidence()})`,
			).toBe(true);
			const publishedPid = readFileSync(pidFile, "utf8").trim();
			const descendantPid = Number(publishedPid);
			// `Start-Process -PassThru` yields $null if the child never launched, and
			// `Set-Content -Value $null` writes an empty line, which Number() turns
			// into 0. PID 0 is the System Idle Process: `Get-Process -Id 0` SUCCEEDS,
			// so the liveness probe reported PROBE_ERROR ("Access is denied" from
			// WaitForExit on Idle) rather than "no such process" — and PROBE_ERROR is
			// fail-closed to running:true, which let a broken fixture certify itself.
			// 0 and 4 are System/Idle and can never be our child.
			expect(
				Number.isInteger(descendantPid) && descendantPid > 4,
				`descendant was never launched (pid file contained ${JSON.stringify(publishedPid)})`,
			).toBe(true);
			const launchedAtMs = Date.now();
			// Require a DEFINITE alive reading. Accepting the fail-closed running:true
			// from an unreadable probe is what allowed the vacuous fixture through.
			const before = waitForProcessExit(descendantPid, 0);
			expect(before.state, `descendant was not alive before cancellation (${before.detail})`).toBe(
				"ALIVE",
			);
			controller.abort();
			const result = await running;
			expect(result.isError).toBeUndefined();
			const output = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const exitCodeMatch = output.match(/Exit code:\s*(-?\d+)/);
			expect(exitCodeMatch, `missing numeric exit code in output: ${output}`).not.toBeNull();
			expect(Number(exitCodeMatch?.[1]), `cancellation returned success: ${output}`).not.toBe(0);
			// Wait for the descendant to die on ONE process handle, then assert both
			// signals together. Ordering matters: the sentinel is only meaningful once
			// the descendant's own delay has elapsed relative to ITS launch, so the
			// wait below is computed from launchedAtMs rather than being a fixed sleep
			// tuned to a hardcoded delay that has since changed.
			const exit = waitForProcessExit(descendantPid, 20_000, launchedAtMs);
			// Sleep until a SURVIVOR would already have written, so an absent sentinel
			// means containment rather than "we looked too early".
			const sentinelDue = launchedAtMs + sentinelDelayMs + 1_500;
			const remaining = sentinelDue - Date.now();
			if (remaining > 0) await Bun.sleep(remaining);
			// The security property: the descendant did no work after cancellation.
			expect(
				existsSync(sentinel),
				`delayed descendant output escaped cancellation (${exit.state}; ${exit.detail})`,
			).toBe(false);
			// And it is actually gone, not merely idle.
			expect(
				exit.running,
				`descendant survived job cancellation (state=${exit.state}; ${exit.detail})`,
			).toBe(false);
		} finally {
			// The watcher deletes its journal AFTER it has proven the job tree dead,
			// so this is an assertion about a detached process's async cleanup, not
			// about state the test body controls. It previously borrowed its slack
			// from the 20ms poll loop above; replacing that with a handle wait
			// removed the incidental delay, and running the suite under --parallel
			// starves the watcher further, so it needs a bounded wait of its own.
			const countJournals = (): { count: number; status: number | null; stderr: string } => {
				const probe = spawnSync(
					"powershell.exe",
					[
						"-NoProfile",
						"-Command",
						`@(Get-ChildItem -Path $env:TEMP -Filter 'bound-lowbox-${runId}-Bound.Lowbox.*.authority').Count`,
					],
					{ encoding: "utf8", windowsHide: true },
				);
				return {
					count: Number(`${probe.stdout ?? ""}`.trim()),
					status: probe.status,
					stderr: `${probe.stderr ?? ""}`.trim(),
				};
			};
			let journals = countJournals();
			const journalDeadline = Date.now() + 15_000;
			while (journals.status === 0 && journals.count !== 0 && Date.now() < journalDeadline) {
				await Bun.sleep(250);
				journals = countJournals();
			}
			expect(journals.status, journals.stderr).toBe(0);
			expect(journals.count, "cancellation left an authority journal").toBe(0);
			await removeFixtureAfterHandlesClose(cwd);
		}
	});
});
