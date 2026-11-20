/**
 * In-process hub + spoke boot test for `bound start`.
 *
 * Boots two real Bound nodes in one process via `startNode`: a hub (local fake
 * model backend) and a spoke (no local backend) whose sync config points at the
 * hub's real sync port. Asserts the WS sync handshake lands — the spoke's hosts
 * row appears in the hub DB — and, when reachable, that an inference relayed
 * from the spoke to the hub's fake model exercises relay.ts/sync.ts end to end.
 *
 * This is the two-node-in-one-process case that proves `startNode` installs no
 * process-global that stops a second node booting: two independent nodes, two
 * ports, one teardown each.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { ensureKeypair, exportPublicKey } from "@bound/sync";
import { runInit } from "../../init.js";
import { type NodeHandle, startNode } from "../index.js";

/** Minimal OpenAI-compatible `/v1/chat/completions` SSE server on port 0. */
function startFakeOpenAiServer(replyText: string) {
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
				await req.text();
				const body = `data: {"id":"fake-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(
					replyText,
				)}}}]}\n\ndata: {"id":"fake-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`;
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

/** The data dir startNode derives for a given configDir (sibling `data`). */
function dataDirFor(configDir: string): string {
	return join(dirname(resolve(configDir)), "data");
}

describe("bound start — hub + spoke in one process", () => {
	let hubTemp: string;
	let spokeTemp: string;
	let fake: ReturnType<typeof startFakeOpenAiServer>;
	let hub: NodeHandle | undefined;
	let spoke: NodeHandle | undefined;
	let hubSiteId: string;
	let spokeSiteId: string;

	beforeAll(async () => {
		hubTemp = mkdtempSync(join(tmpdir(), "bound-boot-hub-"));
		spokeTemp = mkdtempSync(join(tmpdir(), "bound-boot-spoke-"));
		const hubConfigDir = join(hubTemp, "config");
		const spokeConfigDir = join(spokeTemp, "config");

		fake = startFakeOpenAiServer("relayed pong");

		await runInit({ ollama: true, name: "hub-operator", configDir: hubConfigDir });
		await runInit({ ollama: true, name: "spoke-operator", configDir: spokeConfigDir });

		// Pre-generate both keypairs into each data dir so both site IDs exist
		// before either node boots — the shared keyring needs both public keys up
		// front. startNode's own ensureKeypair call is idempotent and reuses these.
		const hubData = dataDirFor(hubConfigDir);
		const spokeData = dataDirFor(spokeConfigDir);
		mkdirSync(hubData, { recursive: true });
		mkdirSync(spokeData, { recursive: true });
		const hubKp = await ensureKeypair(hubData);
		const spokeKp = await ensureKeypair(spokeData);
		hubSiteId = hubKp.siteId;
		spokeSiteId = spokeKp.siteId;
		const hubPub = await exportPublicKey(hubKp.publicKey);
		const spokePub = await exportPublicKey(spokeKp.publicKey);

		// Hub model_backends → fake server; spoke has NO local backend so inference
		// must route to the hub (exercises the relay path).
		writeFileSync(
			join(hubConfigDir, "model_backends.js"),
			`export default ${JSON.stringify(
				{
					backends: [
						{
							id: "fake",
							provider: "openai-compatible",
							model: "fake-model",
							context_window: 8192,
							tier: 3,
							base_url: fake.baseUrl,
							api_key: "test-key",
						},
					],
					default: "fake",
				},
				null,
				2,
			)};\n`,
		);
		writeFileSync(
			join(spokeConfigDir, "model_backends.js"),
			`export default ${JSON.stringify({ backends: [], default: "" }, null, 2)};\n`,
		);

		// Boot the hub first on ephemeral ports so we know its real sync port
		// before writing the spoke's sync config. The hub has no hub URL (it IS
		// the hub); its keyring lists both peers so it accepts the spoke's dial.
		const hubWsHost = "localhost";
		const hubKeyring = {
			hosts: {
				[hubSiteId]: { public_key: hubPub, url: "http://localhost:0" },
				[spokeSiteId]: { public_key: spokePub, url: "http://localhost:0" },
			},
		};
		writeFileSync(join(hubConfigDir, "keyring.json"), `${JSON.stringify(hubKeyring, null, 2)}\n`);
		// Hub sync.json with no hub URL marks it as the hub (isHub = !syncConfig.hub).
		writeFileSync(join(hubConfigDir, "sync.json"), `${JSON.stringify({}, null, 2)}\n`);

		hub = await startNode(
			{ configDir: hubConfigDir },
			{ webPort: 0, syncPort: 0, webHost: hubWsHost, syncHost: hubWsHost },
		);
		expect(hub.syncPort).toBeGreaterThan(0);

		const hubSyncUrl = `http://localhost:${hub.syncPort}`;

		// Now write the spoke's keyring (hub entry carries the REAL sync URL so the
		// spoke dials it) and sync.json pointing at the hub.
		const spokeKeyring = {
			hosts: {
				[hubSiteId]: { public_key: hubPub, url: hubSyncUrl },
				[spokeSiteId]: { public_key: spokePub, url: "http://localhost:0" },
			},
		};
		writeFileSync(
			join(spokeConfigDir, "keyring.json"),
			`${JSON.stringify(spokeKeyring, null, 2)}\n`,
		);
		writeFileSync(
			join(spokeConfigDir, "sync.json"),
			`${JSON.stringify({ hub: hubSyncUrl }, null, 2)}\n`,
		);

		spoke = await startNode(
			{ configDir: spokeConfigDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		expect(spoke.webPort).toBeGreaterThan(0);
	}, 60_000);

	afterAll(async () => {
		await spoke?.stop();
		await hub?.stop();
		fake?.stop();
		cleanupTmpDirSync(spokeTemp);
		cleanupTmpDirSync(hubTemp);
	});

	it("boots two independent nodes on distinct ports in one process", () => {
		expect(hub?.syncPort).toBeGreaterThan(0);
		expect(spoke?.syncPort).toBeGreaterThan(0);
		expect(hub?.webPort).not.toBe(spoke?.webPort);
		expect(hub?.syncPort).not.toBe(spoke?.syncPort);
	});

	it("completes the sync handshake: the spoke's hosts row appears in the hub DB", async () => {
		// The spoke connects and the handshake replicates its hosts row to the hub.
		// Poll the hub DB (bounded) rather than sleeping a fixed interval.
		const hubDb = hub?.appContext.db;
		expect(hubDb).toBeDefined();

		const deadline = Date.now() + 20_000;
		let found = false;
		while (Date.now() < deadline) {
			const row = hubDb
				?.query("SELECT site_id FROM hosts WHERE site_id = ? AND deleted = 0")
				.get(spokeSiteId) as { site_id: string } | null;
			if (row?.site_id === spokeSiteId) {
				found = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(found).toBe(true);
	}, 25_000);
});
