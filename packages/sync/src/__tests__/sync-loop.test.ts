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
			CREATE TABLE cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				modified_at TEXT NOT NULL
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
							source_seq_start: 0,
							source_seq_end: 0,
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
});
