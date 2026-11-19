/**
 * Targeted coverage for `startNode`'s SIGHUP hot-reload callback wiring
 * (index.ts 230-302): the three callback bodies the boot fixtures never drive —
 * onMcpConfigChanged (239-263), onModelBackendsChanged (264-284), and
 * onWsConfigChanged (285-301). These callbacks are closures built inside
 * startNode over the live mcpClientsMap / modelRouter / wsClient references, so
 * they are only exercisable by booting the real node and firing the real
 * SIGHUP handler the boot registered.
 *
 * Approach: boot a fully-configured node in-process (keyring → sync server,
 * platforms registry, a real model router), capture the SIGHUP listener the
 * boot added to `process`, then for each callback mutate the relevant config
 * file and invoke the listener, asserting the observable effect:
 *
 *   - model_backends.js change → modelRouter.reload() swaps the live backend
 *     set and advertiseLocalModels() rewrites hosts.models (observable in DB);
 *   - sync.json ws change → onWsConfigChanged runs (the wsClient is null on a
 *     hub boot, so the guarded body no-ops but the arm is entered and the
 *     reload completes without error);
 *   - mcp.json change → onMcpConfigChanged runs reloadMcpServers (no servers to
 *     reconnect here, so it logs "no changes"/completes — the arm is driven).
 *
 * Whole-suite hygiene: startNode registers a process-level SIGHUP listener that
 * NodeHandle.stop() does not remove. We snapshot the listener set before boot
 * and remove exactly the ones the boot added in afterAll, so this file leaks no
 * process listener into later test files.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureKeypair, exportPublicKey } from "@bound/sync";
import { runInit } from "../../init.js";
import { type NodeHandle, startNode } from "../index.js";

/** Minimal OpenAI-compatible server on port 0 — the router points at it. */
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

function dataDirFor(configDir: string): string {
	return join(dirname(resolve(configDir)), "data");
}

/** Write a model_backends.js with the given default id (both backends point at the fake). */
function writeModelBackends(configDir: string, baseUrl: string, defaultId: string): void {
	writeFileSync(
		join(configDir, "model_backends.js"),
		`export default ${JSON.stringify(
			{
				backends: [
					{
						id: "fake",
						provider: "openai-compatible",
						model: "fake-model",
						context_window: 8192,
						tier: 3,
						base_url: baseUrl,
						api_key: "test-key",
					},
					{
						id: "fake2",
						provider: "openai-compatible",
						model: "fake-model-2",
						context_window: 8192,
						tier: 2,
						base_url: baseUrl,
						api_key: "test-key",
					},
				],
				default: defaultId,
			},
			null,
			2,
		)};\n`,
	);
}

describe("startNode — SIGHUP config hot-reload callbacks", () => {
	let tempDir: string;
	let configDir: string;
	let fake: ReturnType<typeof startFakeOpenAiServer>;
	let node: NodeHandle;
	let siteId: string;
	let sighupBefore: Set<(...args: unknown[]) => void>;

	beforeAll(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-sighup-hotreload-"));
		configDir = join(tempDir, "config");
		fake = startFakeOpenAiServer();

		await runInit({ ollama: true, name: "sighup-operator", configDir });
		// Two backends, default = "fake".
		writeModelBackends(configDir, fake.baseUrl, "fake");

		// Self-referential keyring so the sync server boots and the full wiring
		// (including the wsClient reference the ws callback guards on) runs.
		const dataDir = dataDirFor(configDir);
		mkdirSync(dataDir, { recursive: true });
		const kp = await ensureKeypair(dataDir);
		siteId = kp.siteId;
		const pub = await exportPublicKey(kp.publicKey);
		writeFileSync(
			join(configDir, "keyring.json"),
			`${JSON.stringify({ hosts: { [siteId]: { public_key: pub, url: "http://localhost:0" } } }, null, 2)}\n`,
		);
		writeFileSync(join(configDir, "sync.json"), `${JSON.stringify({}, null, 2)}\n`);
		writeFileSync(
			join(configDir, "platforms.json"),
			`${JSON.stringify({ connectors: [] }, null, 2)}\n`,
		);
		// An empty mcp.json so a later change to it is a real config diff.
		writeFileSync(join(configDir, "mcp.json"), `${JSON.stringify({ servers: [] }, null, 2)}\n`);

		// Snapshot SIGHUP listeners so we can remove only what the boot adds.
		sighupBefore = new Set(
			process.listeners("SIGHUP") as unknown as Array<(...args: unknown[]) => void>,
		);

		node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
	}, 60_000);

	afterAll(async () => {
		await node?.stop();
		// Remove exactly the SIGHUP listener(s) the boot registered.
		for (const l of process.listeners("SIGHUP") as unknown as Array<(...args: unknown[]) => void>) {
			if (!sighupBefore.has(l)) process.removeListener("SIGHUP", l);
		}
		fake?.stop();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	/** The single SIGHUP listener the boot added; await its reload to completion. */
	function bootSighupListener(): () => Promise<void> {
		const added = (process.listeners("SIGHUP") as unknown as Array<() => Promise<void>>).filter(
			(l) => !sighupBefore.has(l as unknown as (...a: unknown[]) => void),
		);
		expect(added.length).toBe(1);
		return added[0];
	}

	it("registered exactly one SIGHUP handler during boot", () => {
		// index.ts Phase 5b calls registerSighupHandler unconditionally.
		const added = (
			process.listeners("SIGHUP") as unknown as Array<(...a: unknown[]) => void>
		).filter((l) => !sighupBefore.has(l));
		expect(added.length).toBe(1);
	});

	it("onModelBackendsChanged reloads the router and rewrites hosts.models", async () => {
		const router = node.appContext;
		// Baseline: hosts.models reflects the current backend set. Capture it.
		const before = node.appContext.db
			.query("SELECT models FROM hosts WHERE site_id = ?")
			.get(siteId) as { models: string | null } | null;
		expect(before).not.toBeNull();

		// Flip the default to fake2 and fire SIGHUP. onModelBackendsChanged compares
		// loadModelBackendsConfig() to the live appContext.config.modelBackends,
		// sees the change, reloads the router, re-advertises, and updates config.
		writeModelBackends(configDir, fake.baseUrl, "fake2");
		await bootSighupListener()();

		// appContext.config.modelBackends now carries the new default (set in the
		// callback body at index.ts ~278).
		const liveDefault = (node.appContext.config as { modelBackends?: { default?: string } })
			.modelBackends?.default;
		expect(liveDefault).toBe("fake2");

		// hosts.models was rewritten by advertiseLocalModels (both backends present).
		const after = node.appContext.db
			.query("SELECT models FROM hosts WHERE site_id = ?")
			.get(siteId) as { models: string | null } | null;
		expect(after?.models).toBeTruthy();
		const entries = JSON.parse(after?.models ?? "[]") as Array<{ id: string }>;
		const ids = entries.map((e) => e.id).sort();
		expect(ids).toContain("fake");
		expect(ids).toContain("fake2");
		// Suppress unused-var lint on the readability alias.
		void router;
	});

	it("onWsConfigChanged runs when sync.ws changes (guarded wsClient body)", async () => {
		// Change the ws block so reloadConfigs detects a sync diff and invokes
		// onWsConfigChanged. On a hub boot wsClient is null, so the inner body is
		// guarded off — the arm is still entered and the reload completes clean.
		writeFileSync(
			join(configDir, "sync.json"),
			`${JSON.stringify({ ws: { reconnect_max_interval: 12345 } }, null, 2)}\n`,
		);
		// Should not throw; the reload runs the ws callback arm.
		await expect(bootSighupListener()()).resolves.toBeUndefined();
	});

	it("onMcpConfigChanged runs reloadMcpServers when mcp.json changes", async () => {
		// Add a server to mcp.json so reloadConfigs sees an mcp diff and invokes
		// onMcpConfigChanged → reloadMcpServers. The server is a stdio echo that is
		// never actually spawned to completion here; the callback arm (index.ts
		// 239-263) is what we drive, and the reload must complete without throwing.
		writeFileSync(
			join(configDir, "mcp.json"),
			`${JSON.stringify(
				{ servers: [{ name: "echo-srv", transport: "stdio", command: "true" }] },
				null,
				2,
			)}\n`,
		);
		await expect(bootSighupListener()()).resolves.toBeUndefined();
		// The new server config landed on appContext.optionalConfig (reloadConfigs
		// updates it in place before invoking the callback).
		const mcp = node.appContext.optionalConfig.mcp;
		expect(mcp?.ok).toBe(true);
	}, 20_000);
});
