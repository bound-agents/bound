import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	expect(probe.status, probe.stderr).toBe(0);
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
/**
 * Mandatory windows-latest oracle for the production Windows sandbox path.
 *
 * This suite deliberately has no availability probe, skip, or passthrough mode:
 * before the bound-owned lowbox backend exists, the Windows lane must stay red.
 */
describe.skipIf(process.platform !== "win32")("Windows AppContainer lowbox oracle", () => {
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
					normal?.once("error", reject);
					normal?.once("exit", (code) =>
						reject(new Error(`helper exited before readiness (${code})`)),
					);
				});
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
					expect(cleanupProbe.status, cleanupProbe.stderr).toBe(0);
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
				expect(cleanup).toEqual({ Journal: false, Profile: false, LowboxAces: 0 });
				expect(cleanupObservedAt).toBeGreaterThanOrEqual(childDeadAt);
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
					failed?.once("error", reject);
				});
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
					expect(cleanupProbe.status, cleanupProbe.stderr).toBe(0);
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
				expect(cleanup).toEqual({ Journal: false, Profile: false, LowboxAces: 0 });
				expect(cleanupObservedAt).toBeGreaterThanOrEqual(childDeadAt);
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
					const timeout = setTimeout(
						() => reject(new Error("watcher timeout was not reported")),
						15_000,
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
						`$journal = Get-ChildItem -Path $env:TEMP -Filter 'bound-lowbox-${runId}-Bound.Lowbox.*.authority' | Select-Object -First 1; if (-not $journal) { exit 2 }; (Get-Content -LiteralPath $journal.FullName -TotalCount 1).Trim()`,
					],
					{ encoding: "utf8", windowsHide: true },
				);
				expect(journal.status, journal.stderr).toBe(0);
				expect(journal.stdout.trim()).toBe("transferring");
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
				expect(cleanupProbe.status, cleanupProbe.stderr).toBe(0);
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
});
