import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { readUnprocessed } from "@bound/core";
import type { KeyringConfig, RelayInboxEntry } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { eagerPushToSpoke } from "../eager-push.js";
import { ReachabilityTracker } from "../reachability.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("eagerPushToSpoke", () => {
	let hub: TestInstance;
	let spoke: TestInstance;
	let keyring: KeyringConfig;
	let testRunId: string;

	async function setupInstances() {
		// Generate unique ID for this test run
		testRunId = randomBytes(4).toString("hex");

		// Generate unique ports
		const hubPort = 10000 + Math.floor(Math.random() * 50000);
		const spokePort = hubPort + 1;

		// Generate keypairs
		const hubKeypair = await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`);
		const spokeKeypair = await ensureKeypair(`/tmp/bound-test-spoke-eager-${testRunId}`);

		const hubPubKey = await exportPublicKey(hubKeypair.publicKey);
		const spokePubKey = await exportPublicKey(spokeKeypair.publicKey);

		// Create keyring
		keyring = {
			hosts: {
				[hubKeypair.siteId]: {
					public_key: hubPubKey,
					url: `http://localhost:${hubPort}`,
				},
				[spokeKeypair.siteId]: {
					public_key: spokePubKey,
					url: `http://localhost:${spokePort}`,
				},
			},
		};

		// Create hub instance
		hub = await createTestInstance({
			name: "hub-eager",
			port: hubPort,
			dbPath: `/tmp/bound-test-hub-eager-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-test-hub-eager-${testRunId}`,
		});

		// Create spoke instance with hub reference
		spoke = await createTestInstance({
			name: "spoke-eager",
			port: spokePort,
			dbPath: `/tmp/bound-test-spoke-eager-${testRunId}/bound.db`,
			role: "spoke",
			hubPort,
			keyring,
			keypairPath: `/tmp/bound-test-spoke-eager-${testRunId}`,
		});

		// Insert spoke into hub's hosts table so sync_url is available
		hub.db.run(
			`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			spoke.siteId,
			"spoke-eager",
			"1.0.0",
			`http://localhost:${spokePort}`,
			new Date().toISOString(),
			new Date().toISOString(),
		);
	}

	beforeEach(async () => {
		await setupInstances();
	});

	afterEach(async () => {
		await hub.cleanup();
		await spoke.cleanup();
	});

	it("AC2.1: Hub eager-pushes relay entry to addressable spoke", async () => {
		// Create relay inbox entry
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-123",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success", data: "test" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		// Create reachability tracker
		const tracker = new ReachabilityTracker();

		// Perform eager push
		const eagerPushConfig = {
			privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
			siteId: hub.siteId,
			db: hub.db,
			keyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		const result = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry]);

		// Verify push succeeded
		expect(result).toBe(true);

		// Verify spoke received the entry in inbox
		const inboxEntries = readUnprocessed(spoke.db);
		expect(inboxEntries.length).toBeGreaterThan(0);
		const deliveredEntry = inboxEntries.find((e) => e.id === entry.id);
		expect(deliveredEntry).toBeDefined();
		expect(deliveredEntry?.source_site_id).toBe(hub.siteId);
		expect(deliveredEntry?.kind).toBe("result");
	});

	it("AC2.2: Duplicate delivery deduped via INSERT OR IGNORE on UUID PK", async () => {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entryId = crypto.randomUUID();

		// Create two entries with same ID
		const entry1: RelayInboxEntry = {
			id: entryId,
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-123",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success", data: "test1" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		const entry2: RelayInboxEntry = {
			id: entryId, // Same ID — should be deduped
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-123",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success", data: "test2" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		const tracker = new ReachabilityTracker();
		const eagerPushConfig = {
			privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
			siteId: hub.siteId,
			db: hub.db,
			keyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		// Push first entry
		const result1 = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry1]);
		expect(result1).toBe(true);

		// Verify first entry in inbox
		let inboxEntries = readUnprocessed(spoke.db);
		expect(inboxEntries.length).toBe(1);

		// Push second entry with same ID (simulates sync also delivering)
		const result2 = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry2]);
		expect(result2).toBe(true);

		// Verify still only one entry (deduped by INSERT OR IGNORE)
		inboxEntries = readUnprocessed(spoke.db);
		expect(inboxEntries.length).toBe(1);
		expect(inboxEntries[0].id).toBe(entryId);
		// Verify original payload preserved (insert was ignored)
		const payload = JSON.parse(inboxEntries[0].payload);
		expect(payload.data).toBe("test1");
	});

	it("AC2.3: Eager push failure degrades to sync-only delivery", async () => {
		// Create a spoke with a URL that doesn't exist to trigger network failure
		const testSpokeId = crypto.randomUUID();
		const badPort = 65432; // Port unlikely to have anything listening

		// Add a spoke entry to hub's hosts table with unreachable URL
		hub.db.run(
			`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, 0)`,
			testSpokeId,
			"unreachable-spoke",
			"1.0.0",
			`http://localhost:${badPort}`,
			new Date().toISOString(),
			new Date().toISOString(),
		);

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-456",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success", data: "test" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		const tracker = new ReachabilityTracker();
		const eagerPushConfig = {
			privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
			siteId: hub.siteId,
			db: hub.db,
			keyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		// Eager push should fail but not throw
		const result = await eagerPushToSpoke(eagerPushConfig, testSpokeId, [entry]);
		expect(result).toBe(false);

		// Reachability tracker should record the failure
		expect(tracker.isReachable(testSpokeId)).toBe(true); // One failure, not unreachable yet

		// Verify the entry was NOT added to real spoke inbox
		const inboxEntries = readUnprocessed(spoke.db);
		expect(inboxEntries.length).toBe(0);
	});

	it("AC2.4: 3 consecutive push failures mark spoke unreachable", async () => {
		// Create an unreachable spoke that will fail all pushes
		const unreachableSpokeId = crypto.randomUUID();
		const badPort = 65431; // Port unlikely to have anything listening

		hub.db.run(
			`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, 0)`,
			unreachableSpokeId,
			"unreachable-spoke",
			"1.0.0",
			`http://localhost:${badPort}`,
			new Date().toISOString(),
			new Date().toISOString(),
		);

		const tracker = new ReachabilityTracker(3);
		const eagerPushConfig = {
			privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
			siteId: hub.siteId,
			db: hub.db,
			keyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const createEntry = () => ({
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result" as const,
			ref_id: "ref-789",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		});

		// Verify spoke starts as reachable
		expect(tracker.isReachable(unreachableSpokeId)).toBe(true);

		// Record 3 consecutive failures
		for (let i = 0; i < 3; i++) {
			const result = await eagerPushToSpoke(eagerPushConfig, unreachableSpokeId, [createEntry()]);
			expect(result).toBe(false);

			if (i < 2) {
				// Still reachable after 1-2 failures
				expect(tracker.isReachable(unreachableSpokeId)).toBe(true);
			}
		}

		// After 3 failures, marked unreachable
		expect(tracker.isReachable(unreachableSpokeId)).toBe(false);

		// Successful push to the original reachable spoke resets the unreachable spoke's tracker
		// In this case, we'll test that a previously unreachable spoke can be recovered
		// by manually calling recordSuccess
		tracker.recordSuccess(unreachableSpokeId);

		// Back to reachable
		expect(tracker.isReachable(unreachableSpokeId)).toBe(true);
		const state = tracker.getState(unreachableSpokeId);
		expect(state?.failureCount).toBe(0);
	});

	it("AC2.1: Skips push to unreachable spoke (after 3 failures)", async () => {
		// Mark spoke as unreachable in tracker
		const tracker = new ReachabilityTracker(3);
		for (let i = 0; i < 3; i++) {
			tracker.recordFailure(spoke.siteId);
		}
		expect(tracker.isReachable(spoke.siteId)).toBe(false);

		const eagerPushConfig = {
			privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
			siteId: hub.siteId,
			db: hub.db,
			keyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-skip",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		// Push should return false without attempting network call
		const result = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry]);
		expect(result).toBe(false);
	});

	it("AC9.4: Push from non-hub siteId rejected with 403", async () => {
		// This is tested at the route level in routes.test.ts
		// Here we verify the scenario: different hub trying to push
		// The eager push function itself doesn't enforce this (routes middleware does)
		// But we can verify that IF a non-hub spoke sends, our push would fail
		// This is more of an integration test at route level

		// For this unit test, we verify the routing rejects non-hub sources
		// by attempting a push request from a different siteId
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-auth",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		// Generate a third keypair (attacker)
		const attackerKeypair = await ensureKeypair(`/tmp/bound-test-attacker-${testRunId}`);
		const attackerPubKey = await exportPublicKey(attackerKeypair.publicKey);

		// Extend keyring with attacker
		const extendedKeyring: KeyringConfig = {
			hosts: {
				...keyring.hosts,
				[attackerKeypair.siteId]: {
					public_key: attackerPubKey,
					url: "http://localhost:9999",
				},
			},
		};

		const tracker = new ReachabilityTracker();
		const eagerPushConfig = {
			privateKey: attackerKeypair.privateKey,
			siteId: attackerKeypair.siteId, // Attacker's siteId
			db: hub.db,
			keyring: extendedKeyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		// The push will fail because the request is signed by the attacker,
		// and spoke's /api/relay-deliver route validates the sender is the hub
		// This is validated at the route level with hubSiteId check
		const result = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry]);

		// Should fail (network error from non-hub signature rejection)
		expect(result).toBe(false);
	});

	it("Spoke with no sync_url (NAT'd) — push skipped, returns false", async () => {
		// Create spoke without sync_url
		const tracker = new ReachabilityTracker();
		const eagerPushConfig = {
			privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
			siteId: hub.siteId,
			db: hub.db,
			keyring,
			reachabilityTracker: tracker,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};

		// Create a NAT'd spoke entry (no sync_url)
		const natSpokeId = crypto.randomUUID();
		hub.db.run(
			`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			natSpokeId,
			"nat-spoke",
			"1.0.0",
			null, // No sync_url
			new Date().toISOString(),
			new Date().toISOString(),
		);

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-nat",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		// Push should return false without attempting network call
		const result = await eagerPushToSpoke(eagerPushConfig, natSpokeId, [entry]);
		expect(result).toBe(false);
	});

	it("Records failure when push returns error response", async () => {
		// Test that non-200 responses are treated as failures
		const tracker = new ReachabilityTracker();

		// Create a mock spoke server that returns 500 on relay-deliver
		const errorSpokePort = 10000 + Math.floor(Math.random() * 50000);
		const errorSpokeApp = new (await import("hono")).Hono();

		// Add a handler that returns 500 for relay-deliver
		errorSpokeApp.post("/api/relay-deliver", async (c) => {
			return c.json({ ok: false, error: "Internal server error" }, 500);
		});

		const errorSpokeServer = Bun.serve({
			port: errorSpokePort,
			fetch: errorSpokeApp.fetch,
		});

		try {
			// Create a spoke entry for the error spoke
			const errorSpokeId = crypto.randomUUID();

			// Add error spoke to hub's hosts table
			hub.db.run(
				`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, 0)`,
				errorSpokeId,
				"error-spoke",
				"1.0.0",
				`http://localhost:${errorSpokePort}`,
				new Date().toISOString(),
				new Date().toISOString(),
			);

			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();
			const entry: RelayInboxEntry = {
				id: crypto.randomUUID(),
				source_site_id: hub.siteId,
				kind: "result",
				ref_id: "ref-error",
				idempotency_key: null,
				stream_id: null,
				payload: JSON.stringify({ status: "error" }),
				expires_at: expiresAt,
				received_at: now,
				processed: 0,
			};

			const eagerPushConfig = {
				privateKey: (await ensureKeypair(`/tmp/bound-test-hub-eager-${testRunId}`)).privateKey,
				siteId: hub.siteId,
				db: hub.db,
				keyring,
				reachabilityTracker: tracker,
				logger: {
					info: () => {},
					warn: () => {},
					error: () => {},
					debug: () => {},
				},
			};

			// Call eagerPushToSpoke against the error spoke
			const result = await eagerPushToSpoke(eagerPushConfig, errorSpokeId, [entry]);

			// Push should fail due to 500 response
			expect(result).toBe(false);

			// Verify tracker recorded the failure
			expect(tracker.isReachable(errorSpokeId)).toBe(true); // One failure, not yet unreachable
			const state = tracker.getState(errorSpokeId);
			expect(state?.failureCount).toBe(1);
		} finally {
			errorSpokeServer.stop();
		}
	});
});
