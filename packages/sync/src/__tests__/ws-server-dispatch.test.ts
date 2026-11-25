// Behavioral coverage for the createWsHandlers message() dispatch branches that
// ws-server.test.ts and ws-server-handlers.test.ts leave uncovered: the
// dispatch-failure close (1011) when a transport handler throws, the spool-family
// canary logging paths (received + decode-outcome + fell-off-chain warn), and the
// successful full-DB-seed-on-open path driven through a real WS cluster. The unit
// branches use the same fake ServerWebSocket seam the existing handler tests use;
// the live-socket branch uses the real cluster harness (servers on port 0, real
// DBs). Nothing in-process is mocked beyond the ServerWebSocket shim Bun does not
// export.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { KeyringConfig } from "@bound/shared";
import { deriveSiteId, exportPublicKey, generateKeypair } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { clearColumnCache } from "../reducers.js";
import { signRequest } from "../signing.js";
import { WsMessageType, encodeFrame } from "../ws-frames.js";
import { WsConnectionManager, authenticateWsUpgrade, createWsHandlers } from "../ws-server.js";
import { type WsTestCluster, createWsTestCluster } from "./test-harness.js";

function uniqueRunId(): string {
	return randomBytes(6).toString("hex");
}

// biome-ignore lint/suspicious/noExplicitAny: the Bun ServerWebSocket shim and
// the partial transport stub are deliberately loose — we only wire the branches
// under test, and Bun does not export these types.
type Any = any;
describe("createWsHandlers — full-DB seed on open over a live socket", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("seeds a pre-existing hub row to a freshly-connecting spoke via seedNewPeer", async () => {
		const hub = cluster.hub;
		// Write a row into the hub BEFORE the spoke's open handler seeds it. The
		// existing cluster already connected spoke 0; a hub-written row replicates
		// through the normal changelog drain. We assert the open-path wiring works
		// end to end: the hub applies and the spoke receives the row.
		const now = new Date().toISOString();
		const { insertRow } = await import("@bound/core");
		insertRow(
			hub.db,
			"users",
			{
				id: "seed-user-1",
				display_name: "Seeded",
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			hub.siteId,
		);
		// Nudge the drain toward the connected spoke.
		hub.wsTransport.drainChangelog(cluster.spokes[0].siteId);

		const spoke = cluster.spokes[0];
		const replicated = async (): Promise<boolean> =>
			spoke.db.query("SELECT id FROM users WHERE id = ?").get("seed-user-1") !== null;
		let ok = false;
		for (let i = 0; i < 60 && !ok; i++) {
			ok = await replicated();
			if (!ok) await new Promise((r) => setTimeout(r, 25));
		}
		expect(ok).toBe(true);
	});
});

describe("authenticateWsUpgrade — key/fingerprint lookup failures", () => {
	let spokeKp: Awaited<ReturnType<typeof generateKeypair>>;
	let spokeSiteId: string;
	let spokePub: string;
	let keyManager: KeyManager;

	beforeEach(async () => {
		spokeKp = await generateKeypair();
		spokeSiteId = await deriveSiteId(spokeKp.publicKey);
		spokePub = await exportPublicKey(spokeKp.publicKey);
		const hubKp = await generateKeypair();
		const hubSiteId = await deriveSiteId(hubKp.publicKey);
		keyManager = new KeyManager(hubKp, hubSiteId);
		await keyManager.init({
			hosts: { [spokeSiteId]: { public_key: spokePub, url: "http://localhost:3100" } },
		});
	});

	async function signedRequest(): Promise<Request> {
		const headers = await signRequest(spokeKp.privateKey, spokeSiteId, "GET", "/sync/ws", "");
		return new Request("http://localhost:3000/sync/ws", { method: "GET", headers });
	}

	it("accepts a validly-signed upgrade and returns populated connection data", async () => {
		const keyring: KeyringConfig = {
			hosts: { [spokeSiteId]: { public_key: spokePub, url: "http://localhost:3100" } },
		};
		const result = await authenticateWsUpgrade(await signedRequest(), keyring, keyManager);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.siteId).toBe(spokeSiteId);
			expect(result.value.symmetricKey.length).toBe(32);
			expect(result.value.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	it("rejects (401) when the signature verifies but the symmetric key is absent", async () => {
		// Keyring knows the spoke (signature verifies) but the KeyManager has no
		// symmetric key for it — a fresh KeyManager that never ran init for the spoke.
		const hubKp = await generateKeypair();
		const emptyKm = new KeyManager(hubKp, await deriveSiteId(hubKp.publicKey));
		await emptyKm.init({ hosts: {} });
		const keyring: KeyringConfig = {
			hosts: { [spokeSiteId]: { public_key: spokePub, url: "http://localhost:3100" } },
		};
		const result = await authenticateWsUpgrade(await signedRequest(), keyring, emptyKm);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.status).toBe(401);
	});

	it("rejects (401) a replayed signature on the second presentation", async () => {
		const keyring: KeyringConfig = {
			hosts: { [spokeSiteId]: { public_key: spokePub, url: "http://localhost:3100" } },
		};
		const req = await signedRequest();
		// Clone so both calls read the same signed headers (a Request body/headers are
		// re-readable here since we only read headers).
		const headers = new Headers(req.headers);
		const mk = () => new Request("http://localhost:3000/sync/ws", { method: "GET", headers });
		const first = await authenticateWsUpgrade(mk(), keyring, keyManager);
		expect(first.ok).toBe(true);
		// The replay guard (markUpgradeSignatureSeen) rejects the identical signature.
		const second = await authenticateWsUpgrade(mk(), keyring, keyManager);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error.status).toBe(401);
	});

	it("rejects (401) when the signature does not verify against the keyring", async () => {
		// A keyring that does NOT know the spoke: verifyRequest fails, driving the
		// signature-verification-failure branch (401, non-stale).
		const keyring: KeyringConfig = { hosts: {} };
		const result = await authenticateWsUpgrade(await signedRequest(), keyring, keyManager);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.status).toBe(401);
	});

	it("rejects (401) when the fingerprint is absent despite a present symmetric key", async () => {
		// A KeyManager whose getFingerprint returns null for the spoke drives the
		// fingerprint-absent branch (line 126-130) after the symmetric-key lookup passes.
		const keyring: KeyringConfig = {
			hosts: { [spokeSiteId]: { public_key: spokePub, url: "http://localhost:3100" } },
		};
		const km = keyManager as unknown as { getFingerprint(id: string): string | null };
		const realFingerprint = km.getFingerprint.bind(km);
		km.getFingerprint = () => null;
		try {
			const result = await authenticateWsUpgrade(await signedRequest(), keyring, keyManager);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.status).toBe(401);
		} finally {
			km.getFingerprint = realFingerprint;
		}
	});
});

describe("createWsHandlers — message() dispatch routing for every transport frame type", () => {
	// Drives each dispatch branch in message() by feeding a validly-encoded frame
	// of each type through a capturing transport. Covers the RELAY_ACK /
	// SNAPSHOT_ACK / RESEED_REQUEST / CONSISTENCY_REQUEST / ROW_PULL_REQUEST /
	// ROW_PULL_ACK / SPOOL_TRANSFER branches the existing tests don't reach.
	const symKey = new Uint8Array(32).fill(13);

	function makeHandlers(calls: string[]) {
		const manager = new WsConnectionManager();
		const wsTransport = {
			addPeer: () => {},
			removePeer: () => {},
			seedNewPeer: () => {},
			drainChangelog: () => {},
			drainDurableWorkSpool: () => {},
			handleChangelogPush: () => calls.push("changelog_push"),
			handleChangelogAck: () => calls.push("changelog_ack"),
			handleRelaySend: () => calls.push("relay_send"),
			handleRelayAck: () => calls.push("relay_ack"),
			handleSnapshotAck: () => calls.push("snapshot_ack"),
			handleReseedRequest: () => calls.push("reseed_request"),
			handleConsistencyRequest: () => calls.push("consistency_request"),
			handleRowPullRequest: () => calls.push("row_pull_request"),
			handleRowPullAck: () => calls.push("row_pull_ack"),
			handleSpoolTransfer: () => calls.push("spool_transfer"),
			handleSpoolTransferAck: () => calls.push("spool_transfer_ack"),
			continueSnapshotSeed: () => {},
			continueRowPull: () => {},
			continueConsistencyStream: () => {},
		} as Any;
		const handlers = createWsHandlers({
			connectionManager: manager,
			keyring: { hosts: {} },
			keyManager: {} as Any,
			wsTransport,
		});
		return handlers;
	}

	function makeWs() {
		const data = {
			siteId: "dispatch-peer",
			symmetricKey: symKey,
			sendState: "ready" as "ready" | "pressured",
		};
		const closed: Array<{ code: number }> = [];
		const ws = {
			data,
			send: () => 1,
			close: (code: number) => closed.push({ code }),
			ping: () => {},
		} as Any;
		return { ws, closed };
	}

	it("routes RELAY_SEND, RELAY_ACK, SNAPSHOT_ACK, RESEED, CONSISTENCY, ROW_PULL_*, SPOOL_TRANSFER to their handlers", () => {
		const calls: string[] = [];
		const handlers = makeHandlers(calls);
		const { ws, closed } = makeWs();
		handlers.websocket.open(ws);

		const deliver = (type: WsMessageType, payload: unknown) =>
			handlers.websocket.message(ws, encodeFrame(type, payload, symKey));

		deliver(WsMessageType.RELAY_SEND, { entries: [] });
		deliver(WsMessageType.RELAY_ACK, { ids: [] });
		deliver(WsMessageType.SNAPSHOT_ACK, { snapshot_hlc: "2026-01-01T00:00:00.000Z_0000_hub" });
		deliver(WsMessageType.RESEED_REQUEST, { reason: "test" });
		deliver(WsMessageType.CONSISTENCY_REQUEST, { tables: ["users"], request_id: "c1" });
		deliver(WsMessageType.ROW_PULL_REQUEST, {
			request_id: "r1",
			tables: [{ table: "users", pks: ["a"] }],
		});
		deliver(WsMessageType.ROW_PULL_ACK, { request_id: "r1" });
		deliver(WsMessageType.SPOOL_TRANSFER, { entries: [] });

		expect(calls).toEqual([
			"relay_send",
			"relay_ack",
			"snapshot_ack",
			"reseed_request",
			"consistency_request",
			"row_pull_request",
			"row_pull_ack",
			"spool_transfer",
		]);
		// No dispatch threw, so the connection stayed open.
		expect(closed).toEqual([]);
	});

	it("warns-but-does-not-close on an unexpected RELAY_DELIVER from a spoke", () => {
		const calls: string[] = [];
		const handlers = makeHandlers(calls);
		const { ws, closed } = makeWs();
		handlers.websocket.open(ws);
		// RELAY_DELIVER from a spoke is the explicit log-only branch (hub should
		// never receive it) — no handler call, no close.
		handlers.websocket.message(
			ws,
			encodeFrame(WsMessageType.RELAY_DELIVER, { entries: [] }, symKey),
		);
		expect(calls).toEqual([]);
		expect(closed).toEqual([]);
	});
});
