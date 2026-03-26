import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringConfig, Logger, RelayInboxEntry } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createSyncRoutes } from "../routes.js";
import { signRequest } from "../signing.js";

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

const createMockEventBus = (): TypedEventEmitter => {
	return new TypedEventEmitter();
};

describe("routes", () => {
	let db: Database;
	let hubSiteId: string;
	let hubPrivateKey: CryptoKey;
	let hubPublicKey: string;
	let spokeSiteId: string;
	let spokePrivateKey: CryptoKey;
	let spokePublicKey: string;
	let keyring: KeyringConfig;

	beforeEach(async () => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");

		// Create schema
		db.run(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				model_id TEXT,
				tool_name TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT,
				host_origin TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0
			)
		`);

		db.run(`
			CREATE TABLE change_log (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				site_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				row_data TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE sync_state (
				peer_site_id TEXT PRIMARY KEY,
				last_received INTEGER NOT NULL DEFAULT 0,
				last_sent INTEGER NOT NULL DEFAULT 0,
				last_sync_at TEXT,
				sync_errors INTEGER NOT NULL DEFAULT 0
			)
		`);

		db.run(`
			CREATE TABLE relay_inbox (
				id TEXT PRIMARY KEY,
				source_site_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				ref_id TEXT,
				idempotency_key TEXT,
			stream_id TEXT,
				payload TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				received_at TEXT NOT NULL,
				processed INTEGER NOT NULL DEFAULT 0
			)
		`);

		// Generate keypairs for hub and spoke with random paths
		const hubDir = join(tmpdir(), `bound-test-hub-routes-${randomBytes(4).toString("hex")}`);
		const spokeDir = join(tmpdir(), `bound-test-spoke-routes-${randomBytes(4).toString("hex")}`);

		const hubKeypair = await ensureKeypair(hubDir);
		hubSiteId = hubKeypair.siteId;
		hubPrivateKey = hubKeypair.privateKey;
		hubPublicKey = await exportPublicKey(hubKeypair.publicKey);

		const spokeKeypair = await ensureKeypair(spokeDir);
		spokeSiteId = spokeKeypair.siteId;
		spokePrivateKey = spokeKeypair.privateKey;
		spokePublicKey = await exportPublicKey(spokeKeypair.publicKey);

		keyring = {
			hosts: {
				[spokeSiteId]: {
					public_key: spokePublicKey,
					url: "http://localhost:3200",
				},
				[hubSiteId]: {
					public_key: hubPublicKey,
					url: "http://localhost:3100",
				},
			},
		};
	});

	afterEach(() => {
		db.close();
	});

	describe("POST /sync/push", () => {
		it("receives events and applies them", async () => {
			const app = createSyncRoutes(
				db,
				hubSiteId,
				keyring,
				createMockEventBus(),
				createMockLogger(),
			);

			// Create a changeset
			const changeset = {
				events: [
					{
						seq: 1,
						table_name: "semantic_memory",
						row_id: "mem-1",
						site_id: spokeSiteId,
						timestamp: "2026-03-22T10:00:00Z",
						row_data: JSON.stringify({
							id: "mem-1",
							key: "test_key",
							value: "test_value",
							source: "spoke",
							created_at: "2026-03-22T10:00:00Z",
							modified_at: "2026-03-22T10:00:00Z",
							last_accessed_at: "2026-03-22T10:00:00Z",
							deleted: 0,
						}),
					},
				],
				source_site_id: spokeSiteId,
				source_seq_start: 1,
				source_seq_end: 1,
			};

			const body = JSON.stringify(changeset);
			const headers = await signRequest(spokePrivateKey, spokeSiteId, "POST", "/sync/push", body);

			const response = await app.request("/sync/push", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			expect(response.status).toBe(200);

			const result = await response.json();
			expect(result.ok).toBe(true);
			expect(result.received).toBeGreaterThan(0);

			// Verify the event was applied to the database
			const row = db.query("SELECT * FROM semantic_memory WHERE id = ?").get("mem-1") as
				| Record<string, unknown>
				| undefined;
			expect(row).toBeDefined();
			expect(row?.value).toBe("test_value");
		});
	});

	describe("POST /sync/pull", () => {
		it("returns events excluding requester's own events", async () => {
			const app = createSyncRoutes(
				db,
				hubSiteId,
				keyring,
				createMockEventBus(),
				createMockLogger(),
			);

			// Insert some events in the change log
			db.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			).run("semantic_memory", "mem-1", spokeSiteId, "2026-03-22T10:00:00Z", "{}");

			db.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			).run("semantic_memory", "mem-2", "other-site", "2026-03-22T10:01:00Z", "{}");

			const body = JSON.stringify({ since_seq: 0 });
			const headers = await signRequest(spokePrivateKey, spokeSiteId, "POST", "/sync/pull", body);

			const response = await app.request("/sync/pull", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			expect(response.status).toBe(200);

			const result = await response.json();
			expect(Array.isArray(result.events)).toBe(true);
			// Should have only the event from other-site (echo suppression excludes spokeSiteId)
			const otherSiteEvents = result.events.filter(
				(e: Record<string, string>) => e.site_id !== spokeSiteId,
			);
			expect(otherSiteEvents.length).toBeGreaterThan(0);
		});
	});

	describe("POST /sync/ack", () => {
		it("updates peer cursor after acknowledgment", async () => {
			const app = createSyncRoutes(
				db,
				hubSiteId,
				keyring,
				createMockEventBus(),
				createMockLogger(),
			);

			const body = JSON.stringify({ last_received: 10 });
			const headers = await signRequest(spokePrivateKey, spokeSiteId, "POST", "/sync/ack", body);

			const response = await app.request("/sync/ack", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			expect(response.status).toBe(200);

			const result = await response.json();
			expect(result.ok).toBe(true);

			// Verify sync_state was updated
			const state = db.query("SELECT * FROM sync_state WHERE peer_site_id = ?").get(spokeSiteId) as
				| Record<string, unknown>
				| undefined;
			expect(state).toBeDefined();
			expect(state?.last_sent).toBe(10);
		});
	});

	describe("POST /api/relay-deliver", () => {
		it("accepts relay messages from hub and inserts them into relay_inbox", async () => {
			// Setup: hub is the spoke pushing relay messages
			const app = createSyncRoutes(
				db,
				spokeSiteId,
				keyring,
				createMockEventBus(),
				createMockLogger(),
				undefined,
				hubSiteId, // hubSiteId passed as parameter
			);

			const entry: RelayInboxEntry = {
				id: "relay-1",
				source_site_id: "some-origin",
				kind: "tool_result",
				ref_id: "ref-1",
				idempotency_key: "idem-1",
				stream_id: null,
				payload: '{"data": "test"}',
				expires_at: "2026-03-26T12:00:00Z",
				received_at: "2026-03-26T11:00:00Z",
				processed: 0,
			};

			const body = JSON.stringify({ entries: [entry] });
			const headers = await signRequest(
				hubPrivateKey,
				hubSiteId,
				"POST",
				"/api/relay-deliver",
				body,
			);

			const response = await app.request("/api/relay-deliver", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			expect(response.status).toBe(200);

			const result = await response.json();
			expect(result.ok).toBe(true);
			expect(result.received).toBe(1);

			// Verify entry was inserted into relay_inbox
			const inserted = db
				.query("SELECT * FROM relay_inbox WHERE id = ?")
				.get("relay-1") as RelayInboxEntry | null;
			expect(inserted).toBeDefined();
			expect(inserted?.source_site_id).toBe("some-origin");
			expect(inserted?.payload).toBe('{"data": "test"}');
		});

		it("rejects relay messages from non-hub siteId with 403", async () => {
			// Generate another keypair for a third party
			const thirdPartyDir = join(
				tmpdir(),
				`bound-test-third-party-${randomBytes(4).toString("hex")}`,
			);
			const thirdPartyKeypair = await ensureKeypair(thirdPartyDir);
			const thirdPartySiteId = thirdPartyKeypair.siteId;
			const thirdPartyPrivateKey = thirdPartyKeypair.privateKey;

			// Add third party to keyring
			const extendedKeyring: KeyringConfig = {
				hosts: {
					...keyring.hosts,
					[thirdPartySiteId]: {
						public_key: await exportPublicKey(thirdPartyKeypair.publicKey),
						url: "http://localhost:3300",
					},
				},
			};

			const app = createSyncRoutes(
				db,
				spokeSiteId,
				extendedKeyring,
				createMockEventBus(),
				createMockLogger(),
				undefined,
				hubSiteId, // hubSiteId is different from thirdPartySiteId
			);

			const entry: RelayInboxEntry = {
				id: "relay-2",
				source_site_id: "some-origin",
				kind: "tool_result",
				ref_id: "ref-2",
				idempotency_key: "idem-2",
				stream_id: null,
				payload: '{"data": "test"}',
				expires_at: "2026-03-26T12:00:00Z",
				received_at: "2026-03-26T11:00:00Z",
				processed: 0,
			};

			const body = JSON.stringify({ entries: [entry] });
			const headers = await signRequest(
				thirdPartyPrivateKey,
				thirdPartySiteId,
				"POST",
				"/api/relay-deliver",
				body,
			);

			const response = await app.request("/api/relay-deliver", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers,
				},
				body,
			});

			expect(response.status).toBe(403);
			const result = await response.json();
			expect(result.error).toContain("Not from current hub");
		});

		it("deduplicates relay messages via INSERT OR IGNORE on second push", async () => {
			const app = createSyncRoutes(
				db,
				spokeSiteId,
				keyring,
				createMockEventBus(),
				createMockLogger(),
				undefined,
				hubSiteId,
			);

			const entry: RelayInboxEntry = {
				id: "relay-dedup-1",
				source_site_id: "some-origin",
				kind: "tool_result",
				ref_id: "ref-3",
				idempotency_key: "idem-3",
				stream_id: null,
				payload: '{"data": "dedup"}',
				expires_at: "2026-03-26T12:00:00Z",
				received_at: "2026-03-26T11:00:00Z",
				processed: 0,
			};

			const body = JSON.stringify({ entries: [entry] });
			const headers1 = await signRequest(
				hubPrivateKey,
				hubSiteId,
				"POST",
				"/api/relay-deliver",
				body,
			);

			// First push succeeds
			const response1 = await app.request("/api/relay-deliver", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers1,
				},
				body,
			});

			expect(response1.status).toBe(200);
			const result1 = await response1.json();
			expect(result1.received).toBe(1);

			// Second push with same entry - should dedupe
			const headers2 = await signRequest(
				hubPrivateKey,
				hubSiteId,
				"POST",
				"/api/relay-deliver",
				body,
			);
			const response2 = await app.request("/api/relay-deliver", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...headers2,
				},
				body,
			});

			expect(response2.status).toBe(200);
			const result2 = await response2.json();
			expect(result2.received).toBe(0); // No new insertions
		});
	});
});
