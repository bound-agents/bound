import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { KeyringConfig, Logger, SyncConfig, TypedEventEmitter } from "@bound/shared";
import { SyncClient, type SyncResult, resolveHubUrl } from "../sync-loop.js";

// Mock TypedEventEmitter for testing
const createMockEventBus = (): TypedEventEmitter => {
	return new (require("@bound/shared").TypedEventEmitter)();
};

const createMockLogger = (): Logger => ({
	info: mock(() => {}),
	warn: mock(() => {}),
	error: mock(() => {}),
	debug: mock(() => {}),
});

describe("sync-loop", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");

		db.run(`
			CREATE TABLE change_log (
				hlc TEXT PRIMARY KEY,
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
				last_received TEXT NOT NULL DEFAULT '',
				last_sent TEXT NOT NULL DEFAULT '',
				last_sync_at TEXT,
				sync_errors INTEGER NOT NULL DEFAULT 0
			)
		`);

		db.run(`
			CREATE TABLE cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				modified_at TEXT NOT NULL
			)
		`);

		db.run(`
			CREATE TABLE relay_outbox (
				id TEXT PRIMARY KEY,
				source_site_id TEXT,
				target_site_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				ref_id TEXT,
				idempotency_key TEXT,
				payload TEXT NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				delivered INTEGER NOT NULL DEFAULT 0
			)
		`);

		db.run(`
			CREATE TABLE relay_inbox (
				id TEXT PRIMARY KEY,
				source_site_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				ref_id TEXT,
				idempotency_key TEXT,
				payload TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				received_at TEXT NOT NULL,
				processed INTEGER NOT NULL DEFAULT 0
			)
		`);
	});

	afterEach(() => {
		db.close();
	});

	describe("resolveHubUrl", () => {
		it("reads from cluster_config.cluster_hub if present", () => {
			db.run(
				`INSERT INTO cluster_config (key, value, modified_at)
				VALUES (?, ?, ?)`,
				["cluster_hub", "http://hub.internal:3100", "2026-03-22T10:00:00Z"],
			);

			const syncConfig: SyncConfig = {
				hub: "http://fallback:3100",
				sync_interval_seconds: 60,
			};
			const keyring: KeyringConfig = { hosts: {} };

			const url = resolveHubUrl(db, syncConfig, keyring);

			expect(url).toBe("http://hub.internal:3100");
		});

		it("falls back to sync.json.hub if cluster_config not present", () => {
			const syncConfig: SyncConfig = {
				hub: "http://sync-config-hub:3100",
				sync_interval_seconds: 60,
			};
			const keyring: KeyringConfig = { hosts: {} };

			const url = resolveHubUrl(db, syncConfig, keyring);

			expect(url).toBe("http://sync-config-hub:3100");
		});
	});

	describe("SyncClient", () => {
		it("creates a new client with required parameters", async () => {
			const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
				"sign",
				"verify",
			]);
			const { privateKey } = keyPair as CryptoKeyPair;

			const eventBus = createMockEventBus();
			const logger = createMockLogger();
			const keyring: KeyringConfig = { hosts: {} };

			const client = new SyncClient(
				db,
				"test-site",
				privateKey,
				"http://localhost:3100",
				logger,
				eventBus,
				keyring,
			);

			expect(client).toBeDefined();
		});

		it("tracks sync state across calls", async () => {
			const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
				"sign",
				"verify",
			]);
			const { privateKey } = keyPair as CryptoKeyPair;

			// Mock fetch for push/pull/ack endpoints
			const originalFetch = globalThis.fetch;

			globalThis.fetch = mock(async (url: string) => {
				const path = new URL(url).pathname;

				if (path === "/sync/push") {
					return new Response(JSON.stringify({ ok: true, received: 0 }), { status: 200 });
				}
				if (path === "/sync/pull") {
					return new Response(
						JSON.stringify({
							events: [],
							source_site_id: "hub",
							source_hlc_start: "",
							source_hlc_end: "",
						}),
						{ status: 200 },
					);
				}
				if (path === "/sync/ack") {
					return new Response(JSON.stringify({ ok: true }), { status: 200 });
				}

				return new Response("Not found", { status: 404 });
			}) as never;

			const eventBus = createMockEventBus();
			const logger = createMockLogger();
			const keyring: KeyringConfig = { hosts: {} };

			const client = new SyncClient(
				db,
				"test-site",
				privateKey,
				"http://localhost:3100",
				logger,
				eventBus,
				keyring,
			);

			const result = await client.syncCycle();

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect((result.value as SyncResult).pushed).toBeGreaterThanOrEqual(0);
				expect((result.value as SyncResult).pulled).toBeGreaterThanOrEqual(0);
			}

			globalThis.fetch = originalFetch;
		});

		it("returns error on network failure", async () => {
			const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
				"sign",
				"verify",
			]);
			const { privateKey } = keyPair as CryptoKeyPair;

			const originalFetch = globalThis.fetch;

			globalThis.fetch = mock(async () => {
				throw new Error("Network error");
			}) as never;

			const eventBus = createMockEventBus();
			const logger = createMockLogger();
			const keyring: KeyringConfig = { hosts: {} };

			const client = new SyncClient(
				db,
				"test-site",
				privateKey,
				"http://localhost:3100",
				logger,
				eventBus,
				keyring,
			);

			const result = await client.syncCycle();

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain("Network error");
			}

			globalThis.fetch = originalFetch;
		});
	});

	describe("relay holdback logic (AC4.2, AC4.3)", () => {
		it("holds back request-kind entries when relayDraining is true", async () => {
			const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
				"sign",
				"verify",
			]);
			const { privateKey } = keyPair as CryptoKeyPair;

			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			const keyring: KeyringConfig = {
				hosts: {
					hub1: {
						public_key: "test-public-key",
						url: "http://hub:3100",
					},
				},
			};

			const client = new SyncClient(
				db,
				"spoke1",
				privateKey,
				"http://hub:3100",
				logger,
				eventBus,
				keyring,
			);

			// Manually insert relay outbox entries (some request-kind, some response-kind)
			const now = new Date().toISOString();
			const oneHourLater = new Date(Date.now() + 3600000).toISOString();

			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["req1", "spoke1", "remote", "tool_call", '{"tool":"test"}', now, oneHourLater, 0],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["resp1", "spoke1", "remote", "result", '{"stdout":"ok"}', now, oneHourLater, 0],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"req2",
					"spoke1",
					"remote",
					"resource_read",
					'{"resource_uri":"test"}',
					now,
					oneHourLater,
					0,
				],
			);

			// Set relayDraining to true manually
			// biome-ignore lint/suspicious/noExplicitAny: testing private field
			(client as any).relayDraining = true;

			// Mock fetch to capture the relay request
			// biome-ignore lint/suspicious/noExplicitAny: mock validation uses dynamic object
			let capturedRequest: any;
			const originalFetch = globalThis.fetch;
			globalThis.fetch = mock((url: string, options: { body: string }) => {
				if (url.includes("/sync/relay")) {
					capturedRequest = JSON.parse(options.body);
					return Promise.resolve(
						new Response(
							JSON.stringify({
								relay_inbox: [],
								relay_delivered: [],
								relay_draining: false,
							}),
							{ status: 200 },
						),
					);
				}
				return Promise.reject(new Error("Unknown endpoint"));
			});

			const result = await client.relay();

			expect(result.ok).toBe(true);
			if (result.ok) {
				// Only response-kind entry (result) should be sent, not request-kind entries
				expect(capturedRequest.relay_outbox.length).toBe(1);
				expect(capturedRequest.relay_outbox[0].id).toBe("resp1");
				expect(capturedRequest.relay_outbox[0].kind).toBe("result");
			}

			globalThis.fetch = originalFetch;
		});

		it("allows response-kind and cancel entries during drain", async () => {
			const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
				"sign",
				"verify",
			]);
			const { privateKey } = keyPair as CryptoKeyPair;

			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			const keyring: KeyringConfig = {
				hosts: {
					hub1: {
						public_key: "test-public-key",
						url: "http://hub:3100",
					},
				},
			};

			const client = new SyncClient(
				db,
				"spoke1",
				privateKey,
				"http://hub:3100",
				logger,
				eventBus,
				keyring,
			);

			// Insert relay outbox entries (response-kind and cancel)
			const now = new Date().toISOString();
			const oneHourLater = new Date(Date.now() + 3600000).toISOString();

			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["resp1", "spoke1", "remote", "result", '{"stdout":"ok"}', now, oneHourLater, 0],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["resp2", "spoke1", "remote", "error", '{"error":"failed"}', now, oneHourLater, 0],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, payload, created_at, expires_at, delivered)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["cancel1", "spoke1", "remote", "cancel", '{"ref_id":"req1"}', now, oneHourLater, 0],
			);

			// Set relayDraining to true manually
			// biome-ignore lint/suspicious/noExplicitAny: testing private field
			(client as any).relayDraining = true;

			// Mock fetch to capture the relay request
			// biome-ignore lint/suspicious/noExplicitAny: mock validation uses dynamic object
			let capturedRequest: any;
			const originalFetch = globalThis.fetch;
			globalThis.fetch = mock((url: string, options: { body: string }) => {
				if (url.includes("/sync/relay")) {
					capturedRequest = JSON.parse(options.body);
					return Promise.resolve(
						new Response(
							JSON.stringify({
								relay_inbox: [],
								relay_delivered: [],
								relay_draining: false,
							}),
							{ status: 200 },
						),
					);
				}
				return Promise.reject(new Error("Unknown endpoint"));
			});

			const result = await client.relay();

			expect(result.ok).toBe(true);
			if (result.ok) {
				// All response-kind and cancel entries should be sent
				expect(capturedRequest.relay_outbox.length).toBe(3);
				// biome-ignore lint/suspicious/noExplicitAny: RelayOutboxEntry array property access in mock
				const ids = capturedRequest.relay_outbox.map((e: any) => e.id).sort();
				expect(ids).toEqual(["cancel1", "resp1", "resp2"]);
			}

			globalThis.fetch = originalFetch;
		});
	});
});
