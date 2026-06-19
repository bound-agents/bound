import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __isoSessionTestSeam, execInSession, getOrProvisionSession } from "../tools/iso-session";
import type { ResolvedSandboxConfig } from "../tools/sandbox-policy";
import type { ResolvedShell } from "../tools/shell";

// Mirrors the module-private alias in iso-session.ts. The fake below implements
// only the handful of methods the manager calls, so it's cast through `unknown`
// to the full SDK surface at the seam boundary.
type MxcSdk = typeof import("@microsoft/mxc-sdk");

/**
 * Regression coverage for the per-process session memo in iso-session.ts.
 *
 * The memo used to cache the first provision outcome for the whole process
 * lifetime with no validity check: a rejected first provision (broker not yet
 * up in the post-boot race) poisoned every later command, and a session that
 * went stale under a restarted broker never re-provisioned. Both stranded a
 * long-lived ACP host in passthrough until the process was killed — a client
 * restart didn't help because the editor kept the same subprocess alive.
 */

const CFG: ResolvedSandboxConfig = {
	enabled: true,
	writablePaths: [],
	network: "open",
	onUnavailable: "passthrough",
};

const SHELL = { command: "bash", execFlag: "-c" } as unknown as ResolvedShell;

function makePty() {
	return {
		onData(_cb: (d: string) => void) {},
		onExit(cb: (e: { exitCode: number }) => void) {
			queueMicrotask(() => cb({ exitCode: 0 }));
		},
		pid: 4321,
		kill() {},
	};
}

function makeSdk(overrides: Record<string, unknown>): MxcSdk {
	return {
		provisionSandbox: async () => ({
			sandboxId: "sbx-default",
			metadata: { agentUserName: "W3-default" },
		}),
		startSandbox: async () => {},
		execInSandbox: async () => makePty(),
		stopSandbox: async () => {},
		deprovisionSandbox: async () => {},
		...overrides,
	} as unknown as MxcSdk;
}

describe("iso-session memo recovery", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "iso-test-"));
		__isoSessionTestSeam.setStatePath(join(tmp, "iso-sessions.json"));
		__isoSessionTestSeam.resetMemo();
	});

	afterEach(() => {
		__isoSessionTestSeam.setSdk(undefined);
		__isoSessionTestSeam.setStatePath(undefined);
		__isoSessionTestSeam.resetMemo();
		rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("retries provisioning after a failed first attempt rather than caching the rejection", async () => {
		let attempts = 0;
		__isoSessionTestSeam.setSdk(
			makeSdk({
				provisionSandbox: async () => {
					attempts += 1;
					if (attempts === 1) throw new Error("broker not ready");
					return { sandboxId: "sbx-ok", metadata: { agentUserName: "W3-test" } };
				},
			}),
		);

		await expect(getOrProvisionSession(tmp, CFG)).rejects.toThrow("broker not ready");

		const session = await getOrProvisionSession(tmp, CFG);
		expect(session.sandboxId).toBe("sbx-ok");
		expect(attempts).toBe(2);
	});

	it("re-provisions and retries once when exec fails against a stale session", async () => {
		let provisions = 0;
		let execs = 0;
		__isoSessionTestSeam.setSdk(
			makeSdk({
				provisionSandbox: async () => {
					provisions += 1;
					return { sandboxId: `sbx-${provisions}`, metadata: { agentUserName: "W3-test" } };
				},
				execInSandbox: async () => {
					execs += 1;
					if (execs === 1) throw new Error("ISOLATION_SESSION_NOT_FOUND");
					return makePty();
				},
			}),
		);

		const res = await execInSession("echo hi", tmp, CFG, SHELL);
		expect(res.pid).toBe(4321);
		expect(provisions).toBe(2);
		expect(execs).toBe(2);
	});

	it("surfaces the failure when the re-provisioned session also cannot exec", async () => {
		__isoSessionTestSeam.setSdk(
			makeSdk({
				execInSandbox: async () => {
					throw new Error("E_NOTIMPL");
				},
			}),
		);

		await expect(execInSession("echo hi", tmp, CFG, SHELL)).rejects.toThrow();
	});
});
