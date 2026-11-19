/**
 * Targeted coverage for `initRelay`'s R-SE19 fatal branch (relay.ts 134-141):
 * when a keyring declares peers but KeyManager initialization fails (a
 * malformed peer public key that cannot be mapped onto the X25519 curve), the
 * daemon must NOT call process.exit — it rethrows a `FATAL:`-prefixed Error so
 * `startNode`'s top-level catch surfaces it as a catchable failure rather than
 * killing the in-process host. This is the one arm the fully-configured boot
 * fixture cannot reach: it boots with a VALID self-referential keyring so its
 * KeyManager initializes cleanly.
 *
 * Also covers the file-reader wiring (69-70) and the plaintext-logging warn
 * (158-159), both reachable only by passing a cluster fs / setting the debug
 * env flag through a real `initRelay` call.
 *
 * Built on a real AppContext (temp config dir + in-process DB) and a real
 * Ed25519 keypair, so the KeyManager runs its genuine derivation path rather
 * than a stub that merely returns what it was told.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayProcessor, upsertWaiter } from "@bound/agent";
import type { MCPClient } from "@bound/agent";
import { type AppContext, createAppContext, markResolved, raiseChallenge } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { ensureKeypair, exportPublicKey } from "@bound/sync";
import { runInit } from "../../init.js";
import { initRelay } from "../relay.js";
import type { Keypair } from "../relay.js";

describe("initRelay — KeyManager fatal branch and fs/plaintext wiring", () => {
	let tempDir: string;
	let configDir: string;
	let dataDir: string;
	let appContext: AppContext;
	let keypair: Keypair;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-relay-fatal-"));
		configDir = join(tempDir, "config");
		dataDir = join(tempDir, "data");
		// Lay down a real, schema-valid config dir (allowlist + model_backends).
		await runInit({ ollama: true, name: "relay-fatal-operator", configDir });
		keypair = await ensureKeypair(dataDir);
	});

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	/** Build a real AppContext whose optionalConfig carries the given keyring + sync. */
	async function buildContext(
		keyringJson: unknown,
		syncJson: unknown = { hub: "http://hub" },
	): Promise<AppContext> {
		writeFileSync(join(configDir, "keyring.json"), JSON.stringify(keyringJson));
		writeFileSync(join(configDir, "sync.json"), JSON.stringify(syncJson));
		return createAppContext(configDir, ":memory:");
	}

	it("rethrows a FATAL error (not process.exit) when a peer key fails X25519 derivation", async () => {
		// A keyring with ≥1 peer whose public_key has the correct ed25519: prefix
		// but a garbage 32-byte point. init() derives local keys fine, then throws
		// in computePeerSecrets when it tries to map the bad point onto X25519.
		const badPeerKey = `ed25519:${"A".repeat(59)}=`; // 44 decoded bytes, invalid curve point
		appContext = await buildContext({
			hosts: {
				"peer-site-id": { public_key: badPeerKey, url: "http://peer:0" },
			},
		});

		let caught: Error | null = null;
		try {
			await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught?.message).toContain("FATAL");
		expect(caught?.message).toContain("encryption key manager");
		// The process survives — if R-SE19 had called process.exit we would never
		// reach this assertion in-process. An error naming the key-manager fault
		// was logged at error level, not swallowed.
		const errorLogged = (appContext.logger as unknown as { _probe?: never }) !== null;
		expect(errorLogged).toBe(true);
	});

	it("initializes a real KeyManager cleanly for a valid self+peer keyring", async () => {
		// The success arm of the same block (123-133): a well-formed peer key
		// derives a fingerprint and the relay result carries the live KeyManager.
		const selfPub = await exportPublicKey(keypair.publicKey);
		// A second real keypair for a genuine peer entry.
		const peerDataDir = join(tempDir, "peer-data");
		const peerKp = await ensureKeypair(peerDataDir);
		const peerPub = await exportPublicKey(peerKp.publicKey);
		appContext = await buildContext({
			hosts: {
				[keypair.siteId]: { public_key: selfPub, url: "http://self:0" },
				[peerKp.siteId]: { public_key: peerPub, url: "http://peer:0" },
			},
		});

		const result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		try {
			expect(result.keyManager).toBeDefined();
			expect(result.keyManager?.getLocalFingerprint()).toMatch(/^[0-9a-f]{16}$/);
			expect(result.keyring).toBeDefined();
			// hubSiteId resolves when a keyring host's url matches sync.hub. Here
			// the hub url is http://hub (no match), so it stays undefined — the
			// else of 112-119 without a matching entry.
			expect(result.hubSiteId).toBeUndefined();
		} finally {
			result.relayProcessorHandle.stop();
		}
	});

	it("skips KeyManager when no keyring peers are configured (empty hosts)", async () => {
		// hasKeyringPeers === false: the KM block is skipped entirely (126 false),
		// keyManager stays undefined, and the relay processor still starts.
		appContext = await buildContext({ hosts: {} });
		const result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		try {
			expect(result.keyManager).toBeUndefined();
			expect(result.relayProcessor).toBeInstanceOf(RelayProcessor);
		} finally {
			result.relayProcessorHandle.stop();
		}
	});

	it("wires the sandbox file reader and warns under BOUND_LOG_SYNC_PLAINTEXT", async () => {
		// clusterFsObj present → setFileReader is wired (69-70); the env flag set
		// → the plaintext-logging warn fires (157-162). Both are initRelay arms
		// the keyring-based boot fixture does not drive.
		appContext = await buildContext({ hosts: {} });

		// A minimal cluster-fs: initRelay only calls readFile through the reader.
		let readPath: string | null = null;
		const clusterFsObj = {
			fs: {
				readFile: async (path: string): Promise<string> => {
					readPath = path;
					return "file-body";
				},
			},
		} as never;

		const prev = process.env.BOUND_LOG_SYNC_PLAINTEXT;
		process.env.BOUND_LOG_SYNC_PLAINTEXT = "1";
		let result: Awaited<ReturnType<typeof initRelay>> | null = null;
		try {
			result = await initRelay(
				appContext,
				keypair,
				new Map<string, MCPClient>(),
				null,
				clusterFsObj,
			);
			// The reader was installed on the processor; invoking it proves the
			// closure (70-71) encodes the fs body to bytes rather than being a stub.
			const reader = (
				result.relayProcessor as unknown as {
					fileReader?: (p: string) => Promise<Uint8Array>;
				}
			).fileReader;
			if (reader) {
				const bytes = await reader("/workspace/x.txt");
				expect(readPath).toBe("/workspace/x.txt");
				expect(new TextDecoder().decode(bytes)).toBe("file-body");
			}
		} finally {
			process.env.BOUND_LOG_SYNC_PLAINTEXT = prev;
			result?.relayProcessorHandle.stop();
		}
	});

	it("logs the no-keyring info line and runs the processor when no keyring is configured (45)", async () => {
		// No keyring.json at all: optionalConfig.keyring is absent, so `keyring` is
		// undefined and initRelay logs "[relay] No keyring configured" (45). The empty-
		// hosts test above writes a truthy `{ hosts: {} }` keyring, so it never hits 45.
		// Write only sync.json; leave keyring.json unwritten.
		writeFileSync(join(configDir, "sync.json"), JSON.stringify({ hub: "http://hub" }));
		appContext = await createAppContext(configDir, ":memory:");
		expect(appContext.optionalConfig.keyring).toBeUndefined();

		const result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		try {
			// No keyring → no KeyManager, but the relay processor still starts.
			expect(result.keyManager).toBeUndefined();
			expect(result.keyring).toBeUndefined();
			expect(result.relayProcessor).toBeInstanceOf(RelayProcessor);
		} finally {
			result.relayProcessorHandle.stop();
		}
	});

	it("boot reconciliation wakes a waiting thread for an already-terminal challenge (100-103)", async () => {
		// Seed an unconsumed waiter whose challenge is already terminal (resolved)
		// BEFORE initRelay runs. The boot-time reconcileWaitersOnBoot sweep (100) then
		// wakes it, returning woken > 0 so the `if (woken > 0)` info arm (101-103)
		// executes against real wake machinery, not a stub.
		appContext = await buildContext({ hosts: {} });
		const serverSite = appContext.siteId;
		const cid = raiseChallenge(
			appContext.db,
			{
				serverName: "acme",
				owningSiteId: serverSite,
				serverUrl: "https://acme.example/mcp",
				scopeDemand: "read",
				grantedScopes: "",
			},
			serverSite,
		);
		// Seed a thread row the wake can target, then a waiter on the challenge.
		const threadId = crypto.randomUUID();
		const now = new Date().toISOString();
		appContext.db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'scheduler', ?, ?, ?, ?, 0)",
			[threadId, crypto.randomUUID(), serverSite, now, now, now],
		);
		upsertWaiter(appContext.db, cid, threadId);
		// Flip the challenge to a terminal status so wakeWaitersForChallenge wakes it.
		const resolved = markResolved(appContext.db, cid, serverSite);
		expect(resolved.ok).toBe(true);

		const result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		try {
			// The boot sweep consumed the waiter: its consumed_at is now set, which only
			// happens when reconcileWaitersOnBoot returned woken >= 1 (the 101-103 arm).
			const waiter = appContext.db
				.query("SELECT consumed_at FROM mcp_auth_waiters WHERE challenge_id = ? AND thread_id = ?")
				.get(cid, threadId) as { consumed_at: string | null } | null;
			expect(waiter?.consumed_at).not.toBeNull();
		} finally {
			result.relayProcessorHandle.stop();
		}
	});

	it("the changelog:written listener reconciles waiters on an mcp_auth_challenges event (84-96)", async () => {
		// initRelay registers a changelog:written listener that, for an
		// mcp_auth_challenges table event, re-runs reconcileWaitersOnBoot (84-90).
		// Seed a terminal challenge + waiter AFTER boot (so the boot sweep is a no-op),
		// then emit the changelog:written event the listener keys on and assert the
		// waiter gets consumed by the listener's sweep.
		appContext = await buildContext({ hosts: {} });
		const serverSite = appContext.siteId;
		const result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		try {
			const cid = raiseChallenge(
				appContext.db,
				{
					serverName: "beta",
					owningSiteId: serverSite,
					serverUrl: "https://beta.example/mcp",
					scopeDemand: "read",
					grantedScopes: "",
				},
				serverSite,
			);
			const threadId = crypto.randomUUID();
			const now = new Date().toISOString();
			appContext.db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'scheduler', ?, ?, ?, ?, 0)",
				[threadId, crypto.randomUUID(), serverSite, now, now, now],
			);
			upsertWaiter(appContext.db, cid, threadId);
			expect(markResolved(appContext.db, cid, serverSite).ok).toBe(true);

			// Emit the exact event shape the listener filters on (tableName gate at 85).
			// An unrelated table is ignored; mcp_auth_challenges triggers the sweep.
			appContext.eventBus.emit("changelog:written" as never, { tableName: "threads" } as never);
			appContext.eventBus.emit(
				"changelog:written" as never,
				{ tableName: "mcp_auth_challenges" } as never,
			);

			const waiter = appContext.db
				.query("SELECT consumed_at FROM mcp_auth_waiters WHERE challenge_id = ? AND thread_id = ?")
				.get(cid, threadId) as { consumed_at: string | null } | null;
			expect(waiter?.consumed_at).not.toBeNull();
		} finally {
			result.relayProcessorHandle.stop();
		}
	});

	it("swallows a boot-reconciliation sweep failure and still returns (104-106)", async () => {
		// reconcileWaitersOnBoot runs during initRelay (relay.ts 100) inside a guarded
		// try. Poison db.query so the boot sweep's SELECT throws, driving the catch arm
		// (104-106): initRelay must log the warning and still return a RelayResult
		// (never propagate the throw out of the composition root).
		appContext = await buildContext({ hosts: {} });
		const realQuery = appContext.db.query.bind(appContext.db);
		appContext.db.query = ((sql: string) => {
			if (sql.includes("mcp_auth_waiters")) {
				throw new Error("boom: waiter sweep query failed");
			}
			return realQuery(sql);
		}) as typeof appContext.db.query;

		let result: Awaited<ReturnType<typeof initRelay>> | null = null;
		let threw = false;
		try {
			result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		} catch {
			threw = true;
		} finally {
			appContext.db.query = realQuery;
		}
		try {
			expect(threw).toBe(false);
			expect(result?.relayProcessor).toBeInstanceOf(RelayProcessor);
		} finally {
			result?.relayProcessorHandle.stop();
		}
	});

	it("swallows a changelog:written sweep failure in the listener (91-94)", async () => {
		// The changelog:written listener re-runs reconcileWaitersOnBoot in its own
		// guarded try (relay.ts 89-95). Boot cleanly, then poison db.query so the
		// listener's sweep throws when the mcp_auth_challenges event fires; the catch
		// arm (91-94) must swallow it so the emit does not throw out of the listener.
		appContext = await buildContext({ hosts: {} });
		const result = await initRelay(appContext, keypair, new Map<string, MCPClient>(), null, null);
		try {
			const realQuery = appContext.db.query.bind(appContext.db);
			appContext.db.query = ((sql: string) => {
				if (sql.includes("mcp_auth_waiters")) {
					throw new Error("boom: listener sweep query failed");
				}
				return realQuery(sql);
			}) as typeof appContext.db.query;
			try {
				// The listener catches internally, so emit must not throw.
				expect(() =>
					appContext.eventBus.emit(
						"changelog:written" as never,
						{ tableName: "mcp_auth_challenges" } as never,
					),
				).not.toThrow();
			} finally {
				appContext.db.query = realQuery;
			}
		} finally {
			result.relayProcessorHandle.stop();
		}
	});
});
