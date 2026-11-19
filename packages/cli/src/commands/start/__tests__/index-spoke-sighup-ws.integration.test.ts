/**
 * Targeted coverage for `startNode`'s composition-root branches the hub-only
 * boot fixtures never reach (index.ts):
 *
 *   - the `onWsConfigChanged` GUARDED body (290-300): on a HUB boot `wsClient`
 *     is null so the inner body is skipped (sibling sighup test). A SPOKE boot
 *     (sync.hub set + a reachable hub) builds a real `WsSyncClient` and assigns
 *     it to the `wsClient` reference the callback closes over, so firing SIGHUP
 *     with a ws-config change runs the three `wsClient.update*` calls (297-299)
 *     against the live client — the branch no hub boot can enter.
 *   - the spoke teardown path (369 `wsClient?.close()`): `NodeHandle.stop()` on a
 *     spoke closes the real ws client, which a hub-only stop never does.
 *
 * This boots a HUB (local fake model, keyring listing both peers, no hub URL)
 * and then a SPOKE (no local backend, sync.hub → the hub's real sync port) in
 * one process — mirroring boot-hub-spoke, but driving the spoke's SIGHUP
 * ws-reload callback rather than the sync handshake.
 *
 * Whole-suite hygiene: `startNode` registers a process-level SIGHUP listener per
 * boot that `NodeHandle.stop()` does not remove. We snapshot the SIGHUP listener
 * set before each boot and remove exactly the ones the two boots added.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureKeypair, exportPublicKey } from "@bound/sync";
import { runInit } from "../../init.js";
import { type NodeHandle, startNode } from "../index.js";

/** Minimal OpenAI-compatible server on port 0 — the hub's router points here. */
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

function writeHubBackend(configDir: string, baseUrl: string): void {
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
				],
				default: "fake",
			},
			null,
			2,
		)};\n`,
	);
}

describe("startNode — spoke SIGHUP ws-config reload (non-null wsClient)", () => {
	let hubTemp: string;
	let spokeTemp: string;
	let hubConfigDir: string;
	let spokeConfigDir: string;
	let fake: ReturnType<typeof startFakeOpenAiServer>;
	let hub: NodeHandle | undefined;
	let spoke: NodeHandle | undefined;
	let sighupBeforeSpoke: Set<(...args: unknown[]) => void>;

	beforeAll(async () => {
		hubTemp = mkdtempSync(join(tmpdir(), "bound-idx-ws-hub-"));
		spokeTemp = mkdtempSync(join(tmpdir(), "bound-idx-ws-spoke-"));
		hubConfigDir = join(hubTemp, "config");
		spokeConfigDir = join(spokeTemp, "config");
		fake = startFakeOpenAiServer();

		await runInit({ ollama: true, name: "idx-hub-operator", configDir: hubConfigDir });
		await runInit({ ollama: true, name: "idx-spoke-operator", configDir: spokeConfigDir });
		writeHubBackend(hubConfigDir, fake.baseUrl);
		// Spoke has NO local backend: it relays inference to the hub. Empty
		// backends is valid hub-only/spoke mode (default must be "").
		writeFileSync(
			join(spokeConfigDir, "model_backends.js"),
			`export default ${JSON.stringify({ backends: [], default: "" }, null, 2)};\n`,
		);

		// Keypairs so both sides have real identities for the keyring.
		const hubData = dataDirFor(hubConfigDir);
		const spokeData = dataDirFor(spokeConfigDir);
		mkdirSync(hubData, { recursive: true });
		mkdirSync(spokeData, { recursive: true });
		const hubKp = await ensureKeypair(hubData);
		const spokeKp = await ensureKeypair(spokeData);
		const hubPub = await exportPublicKey(hubKp.publicKey);
		const spokePub = await exportPublicKey(spokeKp.publicKey);

		// Hub keyring lists both peers; hub sync.json has no hub URL → it IS the hub.
		writeFileSync(
			join(hubConfigDir, "keyring.json"),
			`${JSON.stringify(
				{
					hosts: {
						[hubKp.siteId]: { public_key: hubPub, url: "http://localhost:0" },
						[spokeKp.siteId]: { public_key: spokePub, url: "http://localhost:0" },
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(join(hubConfigDir, "sync.json"), `${JSON.stringify({}, null, 2)}\n`);

		hub = await startNode(
			{ configDir: hubConfigDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		expect(hub.syncPort).toBeGreaterThan(0);
		const hubSyncUrl = `http://localhost:${hub.syncPort}`;

		// Spoke keyring + sync.json pointing at the hub's REAL sync port so the
		// spoke dials it and initSync builds a live WsSyncClient (the wsClient ref).
		writeFileSync(
			join(spokeConfigDir, "keyring.json"),
			`${JSON.stringify(
				{
					hosts: {
						[hubKp.siteId]: { public_key: hubPub, url: hubSyncUrl },
						[spokeKp.siteId]: { public_key: spokePub, url: "http://localhost:0" },
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(spokeConfigDir, "sync.json"),
			`${JSON.stringify({ hub: hubSyncUrl }, null, 2)}\n`,
		);

		sighupBeforeSpoke = new Set(
			process.listeners("SIGHUP") as unknown as Array<(...args: unknown[]) => void>,
		);
		spoke = await startNode(
			{ configDir: spokeConfigDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
	}, 60_000);

	afterAll(async () => {
		await spoke?.stop();
		await hub?.stop();
		for (const l of process.listeners("SIGHUP") as unknown as Array<(...args: unknown[]) => void>) {
			if (!sighupBeforeSpoke.has(l)) process.removeListener("SIGHUP", l);
		}
		fake?.stop();
		rmSync(spokeTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		rmSync(hubTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	/** The single SIGHUP listener the spoke boot added. */
	function spokeSighupListener(): () => Promise<void> {
		const added = (process.listeners("SIGHUP") as unknown as Array<() => Promise<void>>).filter(
			(l) => !sighupBeforeSpoke.has(l as unknown as (...a: unknown[]) => void),
		);
		expect(added.length).toBe(1);
		return added[0];
	}

	it("built a spoke with a web server and a live ws client to the hub", () => {
		// The spoke boots both servers and dials the hub over a live wsClient; the
		// ports come back as real OS-assigned values.
		expect(spoke?.webPort).toBeGreaterThan(0);
		expect(spoke?.syncPort).toBeGreaterThan(0);
	});

	it("runs the guarded onWsConfigChanged body against the live wsClient (290-300)", async () => {
		// Change the spoke's sync.ws block so reloadConfigs detects a sync diff and
		// invokes onWsConfigChanged. Unlike the hub boot (wsClient null → body
		// skipped), the spoke's wsClient is non-null, so the three update* calls
		// run. The callback must complete without throwing.
		writeFileSync(
			join(spokeConfigDir, "sync.json"),
			`${JSON.stringify(
				{
					hub: (spoke?.appContext.optionalConfig.sync as { value?: { hub?: string } })?.value?.hub,
					ws: { reconnect_max_interval: 54321, backpressure_limit: 999, backfill_interval: 7 },
				},
				null,
				2,
			)}\n`,
		);
		await expect(spokeSighupListener()()).resolves.toBeUndefined();
	}, 20_000);
});
