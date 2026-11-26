/**
 * `startNode` registers each phase's teardown on an AsyncDisposableStack as it
 * initializes. These tests pin the two halves of that contract:
 *
 *  - `stop()` unwinds in reverse boot order: MCP clients and every other DB
 *    consumer stop before telemetry flushes, telemetry flushes before the DB
 *    closes, and the PID lockfile goes last — even when an earlier disposer
 *    throws. A second `stop()` is a no-op.
 *  - A throw in the last boot phase unwinds every phase that already came up,
 *    so the DB handle is closed and the PID lockfile removed, and the original
 *    startup error is what the caller sees.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@bound/core";
import * as shared from "@bound/shared";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { runInit } from "../../init.js";
import { startNode } from "../index.js";

function startFakeOpenAiServer() {
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		fetch() {
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

function findPidFile(root: string): string | null {
	for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name === "bound.pid") return join(entry.parentPath, entry.name);
	}
	return null;
}

function findDbFile(root: string): string | null {
	for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name === "bound.db") return join(entry.parentPath, entry.name);
	}
	return null;
}

describe("startNode lifecycle teardown", () => {
	let tempDir: string;
	let configDir: string;
	let fakeLlm: ReturnType<typeof startFakeOpenAiServer>;
	const restorers: Array<() => void> = [];

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-lifecycle-"));
		configDir = join(tempDir, "config");
		fakeLlm = startFakeOpenAiServer();
		await runInit({ ollama: true, name: "lifecycle-operator", configDir });
		// A live router is what makes initServer bind the web + sync servers.
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default ${JSON.stringify({
				backends: [
					{
						id: "fake",
						provider: "openai-compatible",
						model: "fake-model",
						context_window: 8192,
						base_url: fakeLlm.baseUrl,
						api_key: "test-key",
					},
				],
				default: "fake",
			})};\n`,
		);
	});

	afterEach(() => {
		for (const restore of restorers.splice(0)) restore();
		fakeLlm?.stop();
		cleanupTmpDirSync(tempDir);
	});

	it("stop() tears down in reverse boot order and is idempotent", async () => {
		const node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		const pidFile = findPidFile(tempDir);
		expect(pidFile).not.toBeNull();

		const order: string[] = [];
		node.__test?.mcpClients.set("probe", {
			disconnect: async () => {
				order.push("mcp");
			},
		});
		const telemetrySpy = spyOn(shared, "shutdownTelemetry").mockImplementation(async () => {
			order.push("telemetry");
			// A failing disposer must not skip the DB close or PID removal.
			throw new Error("telemetry flush failed");
		});
		restorers.push(() => telemetrySpy.mockRestore());
		const db = node.appContext.db;
		const realClose = db.close.bind(db);
		const closeSpy = spyOn(db, "close").mockImplementation((throwOnError?: boolean) => {
			order.push(`db(pid=${pidFile !== null && existsSync(pidFile)})`);
			realClose(throwOnError);
		});
		restorers.push(() => closeSpy.mockRestore());

		await expect(node.stop()).rejects.toThrow("telemetry flush failed");

		expect(order).toEqual(["mcp", "telemetry", "db(pid=true)"]);
		expect(pidFile !== null && existsSync(pidFile)).toBe(false);

		// Second stop is a no-op: nothing runs again and nothing throws.
		await node.stop();
		expect(order).toEqual(["mcp", "telemetry", "db(pid=true)"]);
		expect(closeSpy).toHaveBeenCalledTimes(1);
	}, 60_000);

	it("a late-phase startup failure unwinds every initialized phase and rethrows", async () => {
		// initServer swallows its own bind failures (the node keeps running without
		// a web UI), so the throw is injected at Phase 9 instead: the last phase,
		// reached with both servers listening and every earlier subsystem up.
		const heartbeatSpy = spyOn(core, "startHostHeartbeat").mockImplementation(() => {
			throw new Error("heartbeat failed to start");
		});
		restorers.push(() => heartbeatSpy.mockRestore());
		const unwound: string[] = [];
		const telemetrySpy = spyOn(shared, "shutdownTelemetry").mockImplementation(async () => {
			unwound.push("telemetry");
		});
		restorers.push(() => telemetrySpy.mockRestore());

		let startupError: unknown;
		try {
			await startNode(
				{ configDir },
				{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
			);
		} catch (error) {
			startupError = error;
		}
		expect(heartbeatSpy).toHaveBeenCalledTimes(1);
		expect((startupError as Error).message).toBe("heartbeat failed to start");
		expect(unwound).toEqual(["telemetry"]);
		heartbeatSpy.mockRestore();
		telemetrySpy.mockRestore();

		// PID lockfile removed.
		expect(findPidFile(tempDir)).toBeNull();

		// DB handle released: an exclusive write lock is obtainable from a fresh
		// connection, which a leaked handle in WAL mode would still contend with.
		const dbFile = findDbFile(tempDir);
		expect(dbFile).not.toBeNull();
		const probe = new Database(dbFile as string);
		try {
			probe.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
		} finally {
			probe.close();
		}

		// The same config dir boots again: no stale lock survived the failure.
		const node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		await node.stop();
	}, 60_000);
});
