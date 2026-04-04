import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import type { KeyringConfig, Logger } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { clearColumnCache } from "../reducers.js";
import { createSyncRoutes } from "../routes.js";
import { SyncClient } from "../sync-loop.js";
import { SyncTransport } from "../transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

interface SighupHost {
	db: Database;
	siteId: string;
	privateKey: CryptoKey;
	keyManager: KeyManager;
	server: ReturnType<typeof Bun.serve>;
	port: number;
}

const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

async function createSighupHost(keypairDir: string, keyring: KeyringConfig): Promise<SighupHost> {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	applySchema(db);
	clearColumnCache();

	const keypair = await ensureKeypair(keypairDir);
	const siteId = keypair.siteId;

	const keyManager = new KeyManager(keypair, siteId);
	await keyManager.init(keyring);

	const eventBus = new TypedEventEmitter();
	const logger = createMockLogger();

	const honoApp = new Hono();
	const syncRoutes = createSyncRoutes(
		db,
		siteId,
		keyring,
		eventBus,
		logger,
		undefined,
		undefined,
		undefined,
		undefined,
		keyManager,
	);
	honoApp.route("/", syncRoutes);

	const server = Bun.serve({ port: 0, fetch: honoApp.fetch });
	servers.push(server);

	return {
		db,
		siteId,
		privateKey: keypair.privateKey,
		keyManager,
		server,
		port: server.port,
	};
}

function tempKeypairDir(label: string): string {
	const dir = join(tmpdir(), `bound-sighup-${label}-${randomBytes(4).toString("hex")}`);
	tempDirs.push(dir);
	return dir;
}

function makeSyncClient(from: SighupHost, to: SighupHost, keyring: KeyringConfig): SyncClient {
	const transport = new SyncTransport(from.keyManager, from.privateKey, from.siteId);
	return new SyncClient(
		from.db,
		from.siteId,
		from.privateKey,
		`http://localhost:${to.port}`,
		createMockLogger(),
		new TypedEventEmitter(),
		keyring,
		transport,
	);
}

afterAll(async () => {
	for (const s of servers) {
		s.stop(true);
	}
	for (const d of tempDirs) {
		await rm(d, { recursive: true, force: true }).catch(() => {});
	}
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SIGHUP keyring reload", () => {
	let hub: SighupHost;
	let spokeA: SighupHost;
	let spokeB: SighupHost;
	let initialKeyring: KeyringConfig;

	beforeEach(async () => {
		clearColumnCache();

		const hubDir = tempKeypairDir("hub");
		const spokeADir = tempKeypairDir("spoke-a");
		const spokeBDir = tempKeypairDir("spoke-b");

		// Pre-generate keypairs
		const hubKp = await ensureKeypair(hubDir);
		const spokeAKp = await ensureKeypair(spokeADir);
		const spokeBKp = await ensureKeypair(spokeBDir);

		const hubPub = await exportPublicKey(hubKp.publicKey);
		const spokeAPub = await exportPublicKey(spokeAKp.publicKey);
		const spokeBPub = await exportPublicKey(spokeBKp.publicKey);

		// Build initial keyring with hub + spokeA only
		initialKeyring = {
			hosts: {
				[hubKp.siteId]: { public_key: hubPub, url: "http://localhost:0" },
				[spokeAKp.siteId]: { public_key: spokeAPub, url: "http://localhost:0" },
				[spokeBKp.siteId]: { public_key: spokeBPub, url: "http://localhost:0" },
			},
		};

		hub = await createSighupHost(hubDir, initialKeyring);
		spokeA = await createSighupHost(spokeADir, initialKeyring);
		spokeB = await createSighupHost(spokeBDir, initialKeyring);

		// Patch keyring with real ports
		const hosts = initialKeyring.hosts as Record<string, { public_key: string; url: string }>;
		hosts[hub.siteId].url = `http://localhost:${hub.port}`;
		hosts[spokeA.siteId].url = `http://localhost:${spokeA.port}`;
		hosts[spokeB.siteId].url = `http://localhost:${spokeB.port}`;
	});

	// -----------------------------------------------------------------------
	// 1. Add peer via reload
	// -----------------------------------------------------------------------

	it("1. add peer via keyring reload", async () => {
		// Create a new spoke C
		const spokeCDir = tempKeypairDir("spoke-c");
		const spokeCKp = await ensureKeypair(spokeCDir);
		const spokeCPub = await exportPublicKey(spokeCKp.publicKey);

		// Hub initially has no shared secret with C
		let symmetricKey = hub.keyManager.getSymmetricKey(spokeCKp.siteId);
		expect(symmetricKey).toBeNull();

		// Create new keyring with C added
		const newKeyring: KeyringConfig = {
			hosts: {
				...initialKeyring.hosts,
				[spokeCKp.siteId]: { public_key: spokeCPub, url: "http://localhost:0" },
			},
		};

		// Reload hub's keyring
		hub.keyManager.reloadKeyring(newKeyring);

		// Now hub should have symmetric key for C
		symmetricKey = hub.keyManager.getSymmetricKey(spokeCKp.siteId);
		expect(symmetricKey).not.toBeNull();
		expect(symmetricKey).toBeInstanceOf(Uint8Array);
		expect(symmetricKey?.length).toBe(32);
	});

	// -----------------------------------------------------------------------
	// 2. Remove peer via reload
	// -----------------------------------------------------------------------

	it("2. remove peer via keyring reload", async () => {
		// Hub initially has key for spokeA
		let symmetricKey = hub.keyManager.getSymmetricKey(spokeA.siteId);
		expect(symmetricKey).not.toBeNull();

		// Create new keyring without spokeA
		const newKeyring: KeyringConfig = {
			hosts: {
				[hub.siteId]: (initialKeyring.hosts as Record<string, { public_key: string; url: string }>)[
					hub.siteId
				],
				[spokeB.siteId]: (
					initialKeyring.hosts as Record<string, { public_key: string; url: string }>
				)[spokeB.siteId],
			},
		};

		// Reload hub's keyring
		hub.keyManager.reloadKeyring(newKeyring);

		// Now hub should NOT have symmetric key for spokeA
		symmetricKey = hub.keyManager.getSymmetricKey(spokeA.siteId);
		expect(symmetricKey).toBeNull();

		// But should still have key for spokeB
		symmetricKey = hub.keyManager.getSymmetricKey(spokeB.siteId);
		expect(symmetricKey).not.toBeNull();
	});

	// -----------------------------------------------------------------------
	// 3. Hub migration: spoke switches hub without restart (AC14.4)
	// -----------------------------------------------------------------------

	it("3. hub migration: spoke switches to new hub using pre-cached key", async () => {
		// AC14.4 test: Hub migration with key caching
		// Scenario: spoke is syncing with hub1, then switches to hub2.
		// Verify the pre-cached key from hub1 doesn't interfere with hub2 connection.

		// Create a second hub (hub2)
		const hub2Dir = tempKeypairDir("hub2");
		const hub2Kp = await ensureKeypair(hub2Dir);
		const hub2Pub = await exportPublicKey(hub2Kp.publicKey);

		// Build keyring with both hubs (hub1 and hub2) and spokeA
		// Both hubs will use the SAME shared secret for spokeA (both know spokeA's public key)
		const keyringWithBothHubs: KeyringConfig = {
			hosts: {
				[hub.siteId]: (initialKeyring.hosts as Record<string, { public_key: string; url: string }>)[
					hub.siteId
				],
				[hub2Kp.siteId]: { public_key: hub2Pub, url: "http://localhost:0" },
				[spokeA.siteId]: (
					initialKeyring.hosts as Record<string, { public_key: string; url: string }>
				)[spokeA.siteId],
			},
		};

		// Create hub2 with both-hubs keyring
		const hub2 = await createSighupHost(hub2Dir, keyringWithBothHubs);

		// Patch URL for hub2
		const hosts = keyringWithBothHubs.hosts as Record<string, { public_key: string; url: string }>;
		hosts[hub2Kp.siteId].url = `http://localhost:${hub2.port}`;

		// STEP 1: SpokeA syncs with hub1 and caches the symmetric key
		const clientWithHub1 = makeSyncClient(spokeA, hub, initialKeyring);
		await clientWithHub1.syncCycle(); // May fail but that's OK, we just want to cache the key
		const cachedKeyHub1 = spokeA.keyManager.getSymmetricKey(hub.siteId);
		expect(cachedKeyHub1).not.toBeNull();

		// STEP 2: SpokeA's keyring is updated to include hub2
		spokeA.keyManager.reloadKeyring(keyringWithBothHubs);

		// STEP 3: SpokeA gets the symmetric key for hub2 (should be same as hub1 since both know spokeA)
		const keyHub2 = spokeA.keyManager.getSymmetricKey(hub2.siteId);
		expect(keyHub2).not.toBeNull();

		// STEP 4: SpokeA syncs with hub2 (should succeed with hub2's shared secret)
		const clientWithHub2 = makeSyncClient(spokeA, hub2, keyringWithBothHubs);
		const resultHub2 = await clientWithHub2.syncCycle();

		// Should succeed: hub2 has the same shared secret from keyring
		expect(resultHub2.ok).toBe(true);

		// STEP 5: Verify the pre-cached hub1 key didn't interfere
		const cachedKeyHub1After = spokeA.keyManager.getSymmetricKey(hub.siteId);
		expect(cachedKeyHub1After).not.toBeNull();
		expect(cachedKeyHub1After).toEqual(cachedKeyHub1); // Hub1 key unchanged

		hub2.server.stop(true);
	});

	// -----------------------------------------------------------------------
	// 4. Unchanged peer stability after reload
	// -----------------------------------------------------------------------

	it("4. unchanged peer stability after keyring reload", async () => {
		// Get hub's symmetric key for spokeA before reload
		const keyBefore = hub.keyManager.getSymmetricKey(spokeA.siteId);
		expect(keyBefore).not.toBeNull();

		// Reload with same keyring (no changes)
		hub.keyManager.reloadKeyring(initialKeyring);

		// Get hub's symmetric key for spokeA after reload
		const keyAfter = hub.keyManager.getSymmetricKey(spokeA.siteId);
		expect(keyAfter).not.toBeNull();

		// Keys should be identical (same fingerprint = same shared secret)
		expect(keyBefore).toEqual(keyAfter);
	});

	// -----------------------------------------------------------------------
	// 5. Fingerprints remain valid after reload
	// -----------------------------------------------------------------------

	it("5. fingerprints remain valid after keyring reload", async () => {
		// Get hub's fingerprint for spokeA before reload
		const fingerprintBefore = hub.keyManager.getFingerprint(spokeA.siteId);
		expect(fingerprintBefore).not.toBeNull();

		// Reload with same keyring
		hub.keyManager.reloadKeyring(initialKeyring);

		// Get hub's fingerprint for spokeA after reload
		const fingerprintAfter = hub.keyManager.getFingerprint(spokeA.siteId);
		expect(fingerprintAfter).not.toBeNull();

		// Fingerprints should be identical
		expect(fingerprintBefore).toEqual(fingerprintAfter);
	});
});
