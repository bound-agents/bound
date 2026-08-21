import { describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kill } from "node:process";
import { createBashTool } from "../tools/bash";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import { resolveShell } from "../tools/shell";
import type { ToolResult } from "../tools/types";

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

			const cwd = join(tmpdir(), `bound-lowbox-normal-${randomBytes(4).toString("hex")}`);
			mkdirSync(cwd, { recursive: true });
			const marker = join(cwd, "normal-ready.txt");
			const controlFd = 3;
			try {
				const normal = spawn(
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
					],
					{ stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true },
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
					normal.once("error", reject);
					normal.once("exit", (code) =>
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
						["inspect-cleanup", "--profile", profile, "--path", cwd],
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
				await new Promise<void>((resolve) => normal.once("close", () => resolve()));
				expect(cleanup).toEqual({ Journal: false, Profile: false, LowboxAces: 0 });
				expect(cleanupObservedAt).toBeGreaterThanOrEqual(childDeadAt);
			} finally {
				rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	});

	describe("post-materialization failure", () => {
		it("keeps authority until the suspended child is dead", async () => {
			const helper = process.env.BOUND_LOWBOX_HELPER;
			expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
			expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

			const cwd = join(tmpdir(), `bound-lowbox-failure-${randomBytes(4).toString("hex")}`);
			mkdirSync(cwd, { recursive: true });
			const controlFd = 3;
			try {
				const failed = spawn(
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
					],
					{
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						windowsHide: true,
						env: { ...process.env, BOUND_LOWBOX_TEST_FAIL_AFTER_WATCHER: "1" },
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
					failed.once("error", reject);
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
						["inspect-cleanup", "--profile", profile, "--path", cwd],
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
				if (failed.exitCode === null) {
					await new Promise<void>((resolve) => failed.once("close", () => resolve()));
				}
				expect(cleanup).toEqual({ Journal: false, Profile: false, LowboxAces: 0 });
				expect(cleanupObservedAt).toBeGreaterThanOrEqual(childDeadAt);
			} finally {
				rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	});

	describe("watcher startup failure", () => {
		it("times out an unarmed watcher and leaves Transferring authority fail-closed", async () => {
			const helper = process.env.BOUND_LOWBOX_HELPER;
			expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
			expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

			const cwd = join(tmpdir(), `bound-lowbox-watcher-timeout-${randomBytes(4).toString("hex")}`);
			mkdirSync(cwd, { recursive: true });
			const controlFd = 3;
			const startedAt = Date.now();
			let failed: ReturnType<typeof spawn> | undefined;
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
					],
					{
						stdio: ["ignore", "pipe", "pipe", "pipe"],
						windowsHide: true,
						env: { ...process.env, BOUND_LOWBOX_TEST_WATCHER_NEVER_ARMS: "1" },
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
				expect(failureLine).toContain('"code":"LOWBOX_WATCHER"');
				expect(Date.now() - startedAt).toBeLessThan(15_000);
				expect(failed.exitCode).toBeNull();
			} finally {
				if (failed?.pid) kill(failed.pid, "SIGKILL");
				rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	});

	it("uses the helper protocol, preserves streams, and recovers after helper death", async () => {
		const helper = process.env.BOUND_LOWBOX_HELPER;
		expect(helper, "CI must provide the freshly built lowbox helper").toBeTruthy();
		expect(existsSync(helper as string), "freshly built lowbox helper is missing").toBe(true);

		const cwd = join(tmpdir(), `bound-lowbox-oracle-${randomBytes(4).toString("hex")}`);
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

		try {
			const tool = createBashTool("windows-latest", resolveShell(undefined), sandbox, logger);
			const result: ToolResult = await tool(
				{
					command:
						'[Console]::Out.WriteLine("LOWBOX_STDOUT"); [Console]::Error.WriteLine("LOWBOX_STDERR")',
					timeout: 30_000,
				},
				new AbortController().signal,
				cwd,
			);

			const spawn = events.findLast((entry) => entry.event === "sandbox_spawn");
			const backend = spawn?.fields?.backend;
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
			const crash = spawn(
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
				crash.once("error", reject);
				crash.once("exit", (code) => reject(new Error(`helper exited before readiness (${code})`)));
			});
			const ready = JSON.parse(readyLine) as { ok?: boolean; pid?: number; profile?: string };
			expect(ready.ok, readyLine).toBe(true);
			expect(typeof ready.pid).toBe("number");
			expect(ready.profile).toMatch(/^Bound\.Lowbox\./);
			const childPid = ready.pid as number;
			expect(
				() => kill(childPid, 0),
				"lowbox child was not alive at helper readiness",
			).not.toThrow();
			crash.kill();
			await new Promise<void>((resolve) => crash.once("close", () => resolve()));

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
					["inspect-cleanup", "--profile", profile, "--path", cwd],
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
			rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
