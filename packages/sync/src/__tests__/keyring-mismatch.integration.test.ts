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
import { ensureKeypair, exportPublicKey, generateKeypair } from "../crypto.js";
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

interface MismatchHost {
	db: Database;
	siteId: string;
	privateKey: CryptoKey;
	keyManager: KeyManager;
	server: ReturnType<typeof Bun.serve>;
	port: number;
	publicKey: CryptoKey;
}

const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

async function createMismatchHost(
	keypairDir: string,
	keyring: KeyringConfig,
): Promise<MismatchHost> {
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
		publicKey: keypair.publicKey,
		keyManager,
		server,
		port: server.port,
	};
}

function tempKeypairDir(label: string): string {
	const dir = join(tmpdir(), `bound-mismatch-${label}-${randomBytes(4).toString("hex")}`);
	tempDirs.push(dir);
	return dir;
}

async function makeClient(
	from: MismatchHost,
	toPort: number,
	keyring: KeyringConfig,
): Promise<SyncClient> {
	const transport = new SyncTransport(
		from.keyManager,
		from.privateKey,
		from.siteId,
		createMockLogger(),
	);
	return new SyncClient(
		from.db,
		from.siteId,
		from.privateKey,
		`http://localhost:${toPort}`,
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

describe("keyring mismatch diagnostic", () => {
	let hub: MismatchHost;
	let spokeA: MismatchHost;
	let keyring: KeyringConfig;

	beforeEach(async () => {
		clearColumnCache();

		const hubDir = tempKeypairDir("hub");
		const spokeADir = tempKeypairDir("spoke-a");

		// Pre-generate keypairs
		const hubKp = await ensureKeypair(hubDir);
		const spokeAKp = await ensureKeypair(spokeADir);

		const hubPub = await exportPublicKey(hubKp.publicKey);
		const spokeAPub = await exportPublicKey(spokeAKp.publicKey);

		// Build keyring
		keyring = {
			hosts: {
				[hubKp.siteId]: { public_key: hubPub, url: "http://localhost:0" },
				[spokeAKp.siteId]: { public_key: spokeAPub, url: "http://localhost:0" },
			},
		};

		hub = await createMismatchHost(hubDir, keyring);
		spokeA = await createMismatchHost(spokeADir, keyring);

		// Patch keyring with real ports
		const hosts = keyring.hosts as Record<string, { public_key: string; url: string }>;
		hosts[hub.siteId].url = `http://localhost:${hub.port}`;
		hosts[spokeA.siteId].url = `http://localhost:${spokeA.port}`;
	});

	// -----------------------------------------------------------------------
	// 1. Fingerprint mismatch: spokeB (different keypair) claims to be spokeA
	// -----------------------------------------------------------------------

	it("1. fingerprint rejection: wrong keypair with claimed siteId", async () => {
		// Create spokeB with a different keypair but fake it as spokeA
		const spokeBDir = tempKeypairDir("spoke-b");
		const spokeBKp = await ensureKeypair(spokeBDir);

		// Keyring that hub knows (only spokeA's real key)
		const hubKeyring = keyring;

		// Create a "spokeB pretending to be spokeA" scenario:
		// SpokeB has its own keypair but tries to connect with spokeA's siteId in the keyring
		// This will cause a fingerprint mismatch

		// Create spokeB database
		const spokeBDb = new Database(":memory:");
		spokeBDb.run("PRAGMA journal_mode = WAL");
		spokeBDb.run("PRAGMA foreign_keys = ON");
		applySchema(spokeBDb);

		// SpokeB's keyManager knows about spokeA's real key (from keyring)
		// but will send with its own privateKey (spokeBKp.privateKey)
		// This creates a fingerprint mismatch
		const spokeBKeyManager = new KeyManager(spokeBKp, spokeA.siteId); // Use spokeA's siteId!
		await spokeBKeyManager.init(hubKeyring);

		const transport = new SyncTransport(
			spokeBKeyManager,
			spokeBKp.privateKey,
			spokeA.siteId, // Claim to be spokeA
			createMockLogger(),
		);

		const client = new SyncClient(
			spokeBDb,
			spokeA.siteId,
			spokeBKp.privateKey,
			`http://localhost:${hub.port}`,
			createMockLogger(),
			new TypedEventEmitter(),
			hubKeyring,
			transport,
		);

		// Attempt sync — should fail with fingerprint mismatch
		const result = await client.syncCycle();
		expect(result.ok).toBe(false);
		// Error should be a 400 (bad request due to fingerprint mismatch)
		expect(result.error?.status).toBe(400);
	});

	// -----------------------------------------------------------------------
	// 2. Unknown site rejection: a host not in keyring sends request
	// -----------------------------------------------------------------------

	it("2. unknown site rejection: host not in keyring", async () => {
		// Create a completely unknown host
		const unknownDir = tempKeypairDir("unknown");
		const unknownKp = await ensureKeypair(unknownDir);

		// Hub's keyring does NOT include this unknown host
		// So when it sends a request, it should fail with "unknown_site"

		const unknownDb = new Database(":memory:");
		unknownDb.run("PRAGMA journal_mode = WAL");
		unknownDb.run("PRAGMA foreign_keys = ON");
		applySchema(unknownDb);

		// Unknown host tries to use hub's keyring (but it's not in there)
		const unknownKeyManager = new KeyManager(unknownKp, unknownKp.siteId);
		await unknownKeyManager.init(keyring); // Will fail to find its own key for shared secret

		const transport = new SyncTransport(
			unknownKeyManager,
			unknownKp.privateKey,
			unknownKp.siteId,
			createMockLogger(),
		);

		const client = new SyncClient(
			unknownDb,
			unknownKp.siteId,
			unknownKp.privateKey,
			`http://localhost:${hub.port}`,
			createMockLogger(),
			new TypedEventEmitter(),
			keyring,
			transport,
		);

		const result = await client.syncCycle();
		// Unknown host not in keyring should fail
		expect(result.ok).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 3. Diagnostic clarity: error response contains fingerprint info
	// -----------------------------------------------------------------------

	it("3. diagnostic contains expected and received fingerprints", async () => {
		const spokeBDir = tempKeypairDir("spoke-b-diag");
		const spokeBKp = await ensureKeypair(spokeBDir);

		// Create spokeB with mismatched key
		const spokeBDb = new Database(":memory:");
		spokeBDb.run("PRAGMA journal_mode = WAL");
		spokeBDb.run("PRAGMA foreign_keys = ON");
		applySchema(spokeBDb);

		const spokeBKeyManager = new KeyManager(spokeBKp, spokeA.siteId);
		await spokeBKeyManager.init(keyring);

		const transport = new SyncTransport(
			spokeBKeyManager,
			spokeBKp.privateKey,
			spokeA.siteId,
			createMockLogger(),
		);

		const client = new SyncClient(
			spokeBDb,
			spokeA.siteId,
			spokeBKp.privateKey,
			`http://localhost:${hub.port}`,
			createMockLogger(),
			new TypedEventEmitter(),
			keyring,
			transport,
		);

		const result = await client.syncCycle();
		expect(result.ok).toBe(false);

		// Error should indicate failure during pull (where fingerprint is checked)
		expect(result.error?.phase).toBe("pull");
		// Status should be 400 (bad request)
		expect(result.error?.status).toBe(400);
	});

	// -----------------------------------------------------------------------
	// 4. Modified key in keyring: reload triggers rejection
	// -----------------------------------------------------------------------

	it("4. modified key in keyring is detected after reload", async () => {
		// Start with correct keyring
		const client = await makeClient(spokeA, hub.port, keyring);
		const result1 = await client.syncCycle();
		expect(result1.ok).toBe(true);

		// Now modify hub's keyring: replace spokeA's key with a different one
		const newKeypair = await generateKeypair();
		const newPub = await exportPublicKey(newKeypair.publicKey);

		const modifiedKeyring: KeyringConfig = {
			hosts: {
				...keyring.hosts,
				[spokeA.siteId]: {
					...(keyring.hosts as Record<string, { public_key: string; url: string }>)[spokeA.siteId],
					public_key: newPub,
				},
			},
		};

		// Reload hub's key manager with modified keyring
		hub.keyManager.reloadKeyring(modifiedKeyring);

		// SpokeA still has its old keypair, so sync should now fail
		const client2 = await makeClient(spokeA, hub.port, modifiedKeyring);
		const result2 = await client2.syncCycle();
		expect(result2.ok).toBe(false);
	});
});
