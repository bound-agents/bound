import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow, updateRow } from "@bound/core";
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

interface EncryptedHost {
	db: Database;
	siteId: string;
	privateKey: CryptoKey;
	keyManager: KeyManager;
	server: ReturnType<typeof Bun.serve>;
	port: number;
}

const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

/**
 * Create a fully-wired encrypted host with real Ed25519 keypair,
 * KeyManager, encrypted Hono routes, and live Bun.serve on random port.
 */
async function createEncryptedHost(
	keypairDir: string,
	keyring: KeyringConfig,
): Promise<EncryptedHost> {
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
	const dir = join(tmpdir(), `bound-enc-e2e-${label}-${randomBytes(4).toString("hex")}`);
	tempDirs.push(dir);
	return dir;
}

function makeSyncClient(
	from: EncryptedHost,
	to: EncryptedHost,
	keyring: KeyringConfig,
): SyncClient {
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

describe("encrypted sync integration", () => {
	let hub: EncryptedHost;
	let spoke: EncryptedHost;
	let keyring: KeyringConfig;
	let clientSpokeToHub: SyncClient;
	let clientHubToSpoke: SyncClient;

	beforeEach(async () => {
		clearColumnCache();

		const hubDir = tempKeypairDir("hub");
		const spokeDir = tempKeypairDir("spoke");

		// Pre-generate keypairs
		const hubKp = await ensureKeypair(hubDir);
		const spokeKp = await ensureKeypair(spokeDir);

		const hubPub = await exportPublicKey(hubKp.publicKey);
		const spokePub = await exportPublicKey(spokeKp.publicKey);

		// Build keyring with placeholder URLs
		keyring = {
			hosts: {
				[hubKp.siteId]: { public_key: hubPub, url: "http://localhost:0" },
				[spokeKp.siteId]: { public_key: spokePub, url: "http://localhost:0" },
			},
		};

		hub = await createEncryptedHost(hubDir, keyring);
		spoke = await createEncryptedHost(spokeDir, keyring);

		// Patch keyring with real ports
		const hosts = keyring.hosts as Record<string, { public_key: string; url: string }>;
		hosts[hub.siteId].url = `http://localhost:${hub.port}`;
		hosts[spoke.siteId].url = `http://localhost:${spoke.port}`;

		clientSpokeToHub = makeSyncClient(spoke, hub, keyring);
		clientHubToSpoke = makeSyncClient(hub, spoke, keyring);
	});

	// -----------------------------------------------------------------------
	// 1. Full sync cycle: spoke creates data, hub syncs, hub creates data, spoke syncs
	// -----------------------------------------------------------------------

	it("1. full encrypted sync cycle: spoke pushes to hub, hub pulls from spoke", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const msgId = randomUUID();

		// Spoke creates thread + message
		insertRow(
			spoke.db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				interface: "web",
				host_origin: spoke.siteId,
				color: 0,
				title: "Encrypted thread",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			spoke.siteId,
		);

		insertRow(
			spoke.db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "user",
				content: "Encrypted message",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: spoke.siteId,
				deleted: 0,
			},
			spoke.siteId,
		);

		// Hub syncs from spoke (push -> pull -> ack)
		const result = await clientHubToSpoke.syncCycle();
		expect(result.ok).toBe(true);

		// Verify hub received thread and message
		const threadOnHub = hub.db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Record<
			string,
			unknown
		> | null;
		expect(threadOnHub).not.toBeNull();
		expect(threadOnHub?.title).toBe("Encrypted thread");

		const msgOnHub = hub.db.query("SELECT * FROM messages WHERE id = ?").get(msgId) as Record<
			string,
			unknown
		> | null;
		expect(msgOnHub).not.toBeNull();
		expect(msgOnHub?.content).toBe("Encrypted message");
	});

	// -----------------------------------------------------------------------
	// 2. Data round-trip: unicode, special chars, large JSON
	// -----------------------------------------------------------------------

	it("2. data round-trip with unicode and special characters", async () => {
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const msgId = randomUUID();

		const unicodeContent = "Hello 世界 🌍 Привет مرحبا שלום";
		const complexJson = JSON.stringify({
			nested: { deeply: { value: [1, 2, 3] } },
			special: "!@#$%^&*()",
		});

		// Spoke creates thread with complex content
		insertRow(
			spoke.db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				interface: "web",
				host_origin: spoke.siteId,
				color: 0,
				title: unicodeContent,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			spoke.siteId,
		);

		insertRow(
			spoke.db,
			"messages",
			{
				id: msgId,
				thread_id: threadId,
				role: "user",
				content: complexJson,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: spoke.siteId,
				deleted: 0,
			},
			spoke.siteId,
		);

		// Sync to hub
		const result = await clientHubToSpoke.syncCycle();
		expect(result.ok).toBe(true);

		// Verify byte-exact match
		const threadOnHub = hub.db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Record<
			string,
			unknown
		> | null;
		expect(threadOnHub?.title).toBe(unicodeContent);

		const msgOnHub = hub.db.query("SELECT * FROM messages WHERE id = ?").get(msgId) as Record<
			string,
			unknown
		> | null;
		expect(msgOnHub?.content).toBe(complexJson);
	});

	// -----------------------------------------------------------------------
	// 3. Bidirectional sync
	// -----------------------------------------------------------------------

	it("3. bidirectional sync: both hosts create data, sync both ways", async () => {
		const now = new Date().toISOString();
		const threadHub = randomUUID();
		const threadSpoke = randomUUID();

		// Hub creates thread
		insertRow(
			hub.db,
			"threads",
			{
				id: threadHub,
				user_id: "u-hub",
				interface: "web",
				host_origin: hub.siteId,
				color: 0,
				title: "From Hub",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			hub.siteId,
		);

		// Spoke creates thread
		insertRow(
			spoke.db,
			"threads",
			{
				id: threadSpoke,
				user_id: "u-spoke",
				interface: "web",
				host_origin: spoke.siteId,
				color: 1,
				title: "From Spoke",
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			spoke.siteId,
		);

		// Spoke syncs (pull from hub)
		const r1 = await clientSpokeToHub.syncCycle();
		expect(r1.ok).toBe(true);

		// Verify spoke received hub's thread
		const threadOnSpoke = spoke.db
			.query("SELECT * FROM threads WHERE id = ?")
			.get(threadHub) as Record<string, unknown> | null;
		expect(threadOnSpoke).not.toBeNull();

		// Hub syncs (pull from spoke)
		const r2 = await clientHubToSpoke.syncCycle();
		expect(r2.ok).toBe(true);

		// Verify hub received spoke's thread
		const threadOnHubFromSpoke = hub.db
			.query("SELECT * FROM threads WHERE id = ?")
			.get(threadSpoke) as Record<string, unknown> | null;
		expect(threadOnHubFromSpoke).not.toBeNull();
	});

	// -----------------------------------------------------------------------
	// 4. Multiple sync cycles with new data each time
	// -----------------------------------------------------------------------

	it("4. multiple sync cycles accumulate data correctly", async () => {
		const now = new Date().toISOString();

		// Create 5 threads on spoke, one per cycle
		for (let i = 0; i < 5; i++) {
			const threadId = randomUUID();

			insertRow(
				spoke.db,
				"threads",
				{
					id: threadId,
					user_id: "user-1",
					interface: "web",
					host_origin: spoke.siteId,
					color: 0,
					title: `Thread ${i}`,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				spoke.siteId,
			);

			// Sync each time
			const result = await clientHubToSpoke.syncCycle();
			expect(result.ok).toBe(true);
		}

		// Final verification: hub should have all 5 threads
		const finalCount = hub.db.query("SELECT COUNT(*) as cnt FROM threads").get() as {
			cnt: number;
		};
		expect(finalCount.cnt).toBeGreaterThanOrEqual(5);
	});

	// -----------------------------------------------------------------------
	// 5. LWW: create on spoke, sync, update on hub, sync back
	// -----------------------------------------------------------------------

	it("5. LWW semantics: update syncs back correctly", async () => {
		const now = new Date().toISOString();
		const userId = randomUUID();

		// Spoke creates user
		insertRow(
			spoke.db,
			"users",
			{
				id: userId,
				display_name: "Alice",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			spoke.siteId,
		);

		// Hub pulls from spoke
		let result = await clientHubToSpoke.syncCycle();
		expect(result.ok).toBe(true);

		const userOnHub = hub.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		> | null;
		expect(userOnHub).not.toBeNull();
		expect(userOnHub?.display_name).toBe("Alice");

		// Hub updates user
		updateRow(hub.db, "users", userId, { display_name: "Alice Hub" }, hub.siteId);

		// Spoke pulls from hub
		result = await clientSpokeToHub.syncCycle();
		expect(result.ok).toBe(true);

		const userOnSpoke = spoke.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		> | null;
		expect(userOnSpoke).not.toBeNull();
		expect(userOnSpoke?.display_name).toBe("Alice Hub");
	});
});
