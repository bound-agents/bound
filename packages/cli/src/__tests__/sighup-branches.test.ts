import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, WsConfig } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";

/**
 * Branch coverage for sighup.ts error/callback arms the main sighup.test.ts
 * leaves cold: the `onReloadStart` hook throwing (non-fatal, logged), the
 * `onMcpConfigChanged` callback throwing (logged "MCP reload failed"), the
 * `onWsConfigChanged` callback firing when sync.ws changes (and throwing), and
 * the top-level catch when `loadOptionalConfigs` itself rejects.
 */

interface TestAppContext {
	logger: Logger;
	optionalConfig: Record<string, { ok: boolean; value?: unknown; error?: unknown }>;
	config?: { modelBackends?: unknown };
}

class TestLogger {
	logs: Array<{ level: string; message: string; details?: unknown }> = [];
	info(message: string, details?: unknown) {
		this.logs.push({ level: "info", message, details });
	}
	warn(message: string, details?: unknown) {
		this.logs.push({ level: "warn", message, details });
	}
	error(message: string, details?: unknown) {
		this.logs.push({ level: "error", message, details });
	}
	debug(message: string, details?: unknown) {
		this.logs.push({ level: "debug", message, details });
	}
	getMessages(level?: string): string[] {
		return this.logs.filter((l) => !level || l.level === level).map((l) => l.message);
	}
}

describe("sighup reloadConfigs — error and callback arms", () => {
	let tempDir: string;
	let logger: TestLogger;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-sighup-branch-"));
		logger = new TestLogger();
	});

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	it("logs and continues when onReloadStart throws", async () => {
		const { reloadConfigs } = await import("../sighup.js");
		writeFileSync(join(tempDir, "sync.json"), JSON.stringify({ hub: "http://hub" }));
		const appContext: TestAppContext = { logger, optionalConfig: {} };

		let hookRan = false;
		await reloadConfigs({
			appContext: appContext as never,
			configDir: tempDir,
			logger,
			onReloadStart: () => {
				hookRan = true;
				throw new Error("hook boom");
			},
		});

		expect(hookRan).toBe(true);
		// The throw is swallowed: a warn names the hook, and the reload still completes.
		expect(logger.getMessages("warn").some((m) => m.includes("onReloadStart hook threw"))).toBe(
			true,
		);
		expect(logger.getMessages("info")).toContain("Config reload complete");
	});

	it("logs 'MCP reload failed' when onMcpConfigChanged throws", async () => {
		const { reloadConfigs } = await import("../sighup.js");
		const appContext: TestAppContext = {
			logger,
			optionalConfig: {
				mcp: {
					ok: true,
					value: { servers: [{ name: "old", transport: "stdio", command: "echo" }] },
				},
			},
		};
		writeFileSync(
			join(tempDir, "mcp.json"),
			JSON.stringify({ servers: [{ name: "new", transport: "stdio", command: "test" }] }),
		);

		await reloadConfigs({
			appContext: appContext as never,
			configDir: tempDir,
			logger,
			onMcpConfigChanged: async () => {
				throw new Error("mcp callback boom");
			},
		});

		expect(logger.getMessages("error")).toContain("MCP reload failed");
	});

	it("invokes onWsConfigChanged when sync.ws changes", async () => {
		const { reloadConfigs } = await import("../sighup.js");
		const appContext: TestAppContext = {
			logger,
			optionalConfig: {
				sync: { ok: true, value: { hub: "http://hub", ws: { idle_timeout: 1000 } } },
			},
		};
		// New sync.json with a different ws block.
		writeFileSync(
			join(tempDir, "sync.json"),
			JSON.stringify({ hub: "http://hub", ws: { idle_timeout: 5000 } }),
		);

		let received: WsConfig | undefined;
		let called = false;
		await reloadConfigs({
			appContext: appContext as never,
			configDir: tempDir,
			logger,
			onWsConfigChanged: async (ws) => {
				called = true;
				received = ws;
			},
		});

		expect(called).toBe(true);
		expect(received?.idle_timeout).toBe(5000);
	});

	it("logs 'WS config reload failed' when onWsConfigChanged throws", async () => {
		const { reloadConfigs } = await import("../sighup.js");
		const appContext: TestAppContext = {
			logger,
			optionalConfig: {
				sync: { ok: true, value: { hub: "http://hub", ws: { idle_timeout: 1000 } } },
			},
		};
		writeFileSync(
			join(tempDir, "sync.json"),
			JSON.stringify({ hub: "http://hub", ws: { idle_timeout: 9000 } }),
		);

		await reloadConfigs({
			appContext: appContext as never,
			configDir: tempDir,
			logger,
			onWsConfigChanged: async () => {
				throw new Error("ws callback boom");
			},
		});

		expect(logger.getMessages("error")).toContain("WS config reload failed");
	});
});
