import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashToolWithStreaming } from "../tools/bash";
import {
	type ProcessEntry,
	collectTree,
	createTreeKiller,
	parseProcessTable,
	readHostProcessTable,
} from "../tools/process-tree";
import {
	DISABLED_SANDBOX,
	type ResolvedSandboxConfig,
	checkSandboxAvailable,
} from "../tools/sandbox";
import { resolveShell } from "../tools/shell";

const SELF = 100;
// 100 (us, pgid 100) -> 200 wrapper (pgid 100) -> 300 sh (own session, pgid 300)
//   300 -> 301 bg child (pgid 300), 300 -> 302 bun (pgid 300) -> 303 worker (pgid 300)
// 999 is unrelated.
const TABLE: ProcessEntry[] = [
	{ pid: 1, ppid: 0, pgid: 1 },
	{ pid: SELF, ppid: 1, pgid: 100 },
	{ pid: 200, ppid: SELF, pgid: 100 },
	{ pid: 300, ppid: 200, pgid: 300 },
	{ pid: 301, ppid: 300, pgid: 300 },
	{ pid: 302, ppid: 300, pgid: 300 },
	{ pid: 303, ppid: 302, pgid: 300 },
	{ pid: 999, ppid: 1, pgid: 999 },
];

describe("parseProcessTable", () => {
	it("parses ps pid/ppid/pgid columns and skips malformed lines", () => {
		const parsed = parseProcessTable("  1     0     1\n 42    1   42\ngarbage\n\n 7 x 7\n");
		expect(parsed).toEqual([
			{ pid: 1, ppid: 0, pgid: 1 },
			{ pid: 42, ppid: 1, pgid: 42 },
		]);
	});
});

describe("collectTree", () => {
	it("collects every descendant and their groups, never the caller's own group", () => {
		const { pids, pgids } = collectTree(TABLE, 200, SELF);
		expect(pids.sort((a, b) => a - b)).toEqual([200, 300, 301, 302, 303]);
		expect(pgids).toEqual([300]);
	});

	it("never includes the caller even if it appears under the root", () => {
		const { pids } = collectTree(TABLE, 1, SELF);
		expect(pids).not.toContain(SELF);
	});
});

describe("createTreeKiller", () => {
	function harness(tables: Array<ProcessEntry[] | null>) {
		const sent: Array<[number, NodeJS.Signals | number]> = [];
		let call = 0;
		const kill = createTreeKiller(200, {
			readTable: () => tables[Math.min(call++, tables.length - 1)],
			kill: (pid, signal) => {
				sent.push([pid, signal]);
			},
			selfPid: SELF,
		});
		return { kill, sent };
	}

	it("signals the descendants' group and every descendant, not just the root", () => {
		const { kill, sent } = harness([TABLE]);
		kill("SIGTERM");
		const targets = sent.map(([p]) => p);
		expect(targets).toContain(-300);
		for (const p of [200, 300, 301, 302, 303]) expect(targets).toContain(p);
		expect(targets).not.toContain(-100);
		expect(targets).not.toContain(SELF);
		expect(targets).not.toContain(999);
		expect(sent.every(([, s]) => s === "SIGTERM")).toBe(true);
	});

	it("still reaches reparented survivors on the follow-up SIGKILL after the wrapper died", () => {
		// After SIGTERM the wrapper (200) and sh (300) are gone; 302/303 ignored it
		// and were reparented to init, keeping pgid 300.
		const after: ProcessEntry[] = [
			{ pid: 1, ppid: 0, pgid: 1 },
			{ pid: SELF, ppid: 1, pgid: 100 },
			{ pid: 302, ppid: 1, pgid: 300 },
			{ pid: 303, ppid: 302, pgid: 300 },
			{ pid: 999, ppid: 1, pgid: 999 },
		];
		const { kill, sent } = harness([TABLE, after]);
		kill("SIGTERM");
		sent.length = 0;
		kill("SIGKILL");
		const targets = sent.map(([p]) => p);
		expect(targets).toContain(-300);
		expect(targets).toContain(302);
		expect(targets).toContain(303);
		expect(targets).not.toContain(999);
	});

	it("does not signal a remembered pid that was recycled into another group", () => {
		const recycled: ProcessEntry[] = [
			{ pid: 1, ppid: 0, pgid: 1 },
			{ pid: SELF, ppid: 1, pgid: 100 },
			{ pid: 301, ppid: 1, pgid: 4242 }, // 301 now belongs to an unrelated process
		];
		const { kill, sent } = harness([TABLE, recycled]);
		kill("SIGTERM");
		sent.length = 0;
		kill("SIGKILL");
		const targets = sent.map(([p]) => p);
		expect(targets).not.toContain(301);
		expect(targets).not.toContain(-4242);
		expect(targets).not.toContain(-300); // no process left in group 300
	});

	it("falls back to the root alone when the process table is unreadable", () => {
		const { kill, sent } = harness([null]);
		kill("SIGKILL");
		expect(sent).toEqual([[200, "SIGKILL"]]);
	});

	it("swallows kill errors for processes that are already gone", () => {
		const k = createTreeKiller(200, {
			readTable: () => TABLE,
			kill: () => {
				throw Object.assign(new Error("gone"), { code: "ESRCH" });
			},
			selfPid: SELF,
		});
		expect(() => k("SIGKILL")).not.toThrow();
	});
});

// Live check: a timed-out command's background child that ignores SIGHUP and
// SIGTERM (the shape of a test that boots a node with a SIGHUP hot-reload
// handler) must not survive the tool call. Needs a host that can read the
// process table and signal its own children; inside the boundless sandbox
// neither is permitted, so it runs on CI and in a developer's shell.
const canManageProcesses = (() => {
	if (process.platform === "win32" || readHostProcessTable() === null) return false;
	const child = Bun.spawn(["sleep", "5"]);
	try {
		process.kill(child.pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
})();

// The sandboxed case runs only where a sandboxed command demonstrably runs
// and writes, and only on macOS: seatbelt shares the host pid space, while a
// Linux bubblewrap pid namespace would make the pid the child records name a
// different host process.
async function sandboxedCommandRuns(): Promise<boolean> {
	if (!canManageProcesses || process.platform !== "darwin") return false;
	if (!(await checkSandboxAvailable()).supported) return false;
	const dir = mkdtempSync(join(tmpdir(), "tree-kill-probe-"));
	try {
		const marker = join(dir, "ran");
		await bashToolWithStreaming(
			{ command: `echo ok > "${marker}"`, timeout: 10_000 },
			new AbortController().signal,
			dir,
			undefined,
			"test",
			resolveShell(undefined),
			{ enabled: true, writablePaths: [], network: "open", onUnavailable: "error" },
		);
		return existsSync(marker);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
const sandboxLive = await sandboxedCommandRuns();
const SANDBOXED: ResolvedSandboxConfig = {
	enabled: true,
	writablePaths: [],
	network: "open",
	onUnavailable: "error",
};

describe.skipIf(!canManageProcesses)("bash tool kills the whole tree on timeout", () => {
	async function survivorAfterTimeout(sandbox: ResolvedSandboxConfig): Promise<boolean> {
		const dir = mkdtempSync(join(tmpdir(), "tree-kill-"));
		const pidFile = join(dir, "child.pid");
		try {
			const command = `sh -c 'trap "" HUP TERM; echo $ > "${pidFile}"; exec sleep 60' & wait`;
			await bashToolWithStreaming(
				{ command, timeout: 1500 },
				new AbortController().signal,
				dir,
				undefined,
				"test",
				resolveShell(undefined),
				sandbox,
			);
			expect(existsSync(pidFile)).toBe(true);
			const childPid = Number(readFileSync(pidFile, "utf8").trim());
			for (let i = 0; i < 30; i++) {
				try {
					process.kill(childPid, 0);
					await Bun.sleep(100);
				} catch {
					return false;
				}
			}
			process.kill(childPid, "SIGKILL");
			return true;
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}

	it.skipIf(!sandboxLive)(
		"sandboxed: leaves no SIGHUP/SIGTERM-ignoring descendant running",
		async () => {
			expect(await survivorAfterTimeout(SANDBOXED)).toBe(false);
		},
		15_000,
	);

	it("unsandboxed: leaves no SIGHUP/SIGTERM-ignoring descendant running", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tree-kill-"));
		const pidFile = join(dir, "child.pid");
		try {
			const command = `sh -c 'trap "" HUP TERM; echo $$ > "${pidFile}"; exec sleep 60' & wait`;
			const result = await bashToolWithStreaming(
				{ command, timeout: 1000 },
				new AbortController().signal,
				dir,
				undefined,
				"test",
				resolveShell(undefined),
				DISABLED_SANDBOX,
			);
			expect(result.content.length).toBeGreaterThan(0);
			expect(existsSync(pidFile)).toBe(true);
			const childPid = Number(readFileSync(pidFile, "utf8").trim());
			let alive = true;
			for (let i = 0; i < 30 && alive; i++) {
				try {
					process.kill(childPid, 0);
					await Bun.sleep(100);
				} catch {
					alive = false;
				}
			}
			if (alive) process.kill(childPid, "SIGKILL");
			expect(alive).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}, 15_000);
});
