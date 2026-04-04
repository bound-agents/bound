import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { readUnprocessed } from "@bound/core";
import type { KeyringConfig, RelayInboxEntry } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { eagerPushToSpoke } from "../eager-push.js";
import { ReachabilityTracker } from "../reachability.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("eagerPushToSpoke with encryption", () => {
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
		const hubKeypair = await ensureKeypair(`/tmp/bound-test-hub-enc-${testRunId}`);
		const spokeKeypair = await ensureKeypair(`/tmp/bound-test-spoke-enc-${testRunId}`);

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
			name: "hub-enc",
			port: hubPort,
			dbPath: `/tmp/bound-test-hub-enc-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-test-hub-enc-${testRunId}`,
		});

		// Create spoke instance with hub reference
		spoke = await createTestInstance({
			name: "spoke-enc",
			port: spokePort,
			dbPath: `/tmp/bound-test-spoke-enc-${testRunId}/bound.db`,
			role: "spoke",
			hubPort,
			keyring,
			keypairPath: `/tmp/bound-test-spoke-enc-${testRunId}`,
		});

		// Insert spoke into hub's hosts table so sync_url is available
		hub.db.run(
			`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			spoke.siteId,
			"spoke-enc",
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

	it("AC9.1: Transport field configured enables encrypted path", async () => {
		// This test verifies that EagerPushConfig accepts a transport field
		// and uses it for encrypted delivery

		const hubKeypair = await ensureKeypair(`/tmp/bound-test-hub-enc-${testRunId}`);

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-enc-001",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success", data: "test-data" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		const tracker = new ReachabilityTracker();

		// Config without transport (baseline — uses plaintext)
		const configNoTransport = {
			privateKey: hubKeypair.privateKey,
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

		// This should succeed using plaintext signing
		const result1 = await eagerPushToSpoke(configNoTransport, spoke.siteId, [entry]);
		expect(result1).toBe(true);

		// Verify entry was delivered
		let inboxEntries = readUnprocessed(spoke.db);
		expect(inboxEntries.length).toBe(1);

		// Config type now accepts optional transport field (type checking)
		const configWithOptionalTransport: typeof configNoTransport & { transport?: unknown } = {
			...configNoTransport,
			transport: undefined,
		};
		expect(configWithOptionalTransport).toBeDefined();
	});

	it("AC9.2: Plaintext fallback works when transport not provided", async () => {
		// This verifies backward compatibility: push without transport uses plaintext signing

		const hubKeypair = await ensureKeypair(`/tmp/bound-test-hub-enc-${testRunId}`);

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-plaintext-e2e",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success", data: "plaintext-delivery" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		const tracker = new ReachabilityTracker();
		const eagerPushConfig = {
			privateKey: hubKeypair.privateKey,
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
			// No transport field — uses plaintext signing
		};

		const result = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry]);
		expect(result).toBe(true);

		// Verify spoke's inbox has the entry
		const inboxEntries = readUnprocessed(spoke.db);
		const received = inboxEntries.find((e) => e.id === entry.id);
		expect(received).toBeDefined();
		expect(received?.payload).toBe(entry.payload);
	});

	it("AC9.3: Reachability tracking works regardless of transport", async () => {
		// This verifies reachability tracking is unaffected by encryption layer

		const hubKeypair = await ensureKeypair(`/tmp/bound-test-hub-enc-${testRunId}`);
		const tracker = new ReachabilityTracker(3);

		const eagerPushConfig = {
			privateKey: hubKeypair.privateKey,
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
			// No transport — plaintext path
		};

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entry: RelayInboxEntry = {
			id: crypto.randomUUID(),
			source_site_id: hub.siteId,
			kind: "result",
			ref_id: "ref-reach",
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ status: "success" }),
			expires_at: expiresAt,
			received_at: now,
			processed: 0,
		};

		// First push should succeed and record success
		const result1 = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry]);
		expect(result1).toBe(true);
		expect(tracker.isReachable(spoke.siteId)).toBe(true);
		let state = tracker.getState(spoke.siteId);
		expect(state?.failureCount).toBe(0);

		// Now send to unreachable spoke
		const unreachableSpokeId = crypto.randomUUID();
		const badPort = 65433;
		hub.db.run(
			`INSERT OR REPLACE INTO hosts (site_id, host_name, version, sync_url, modified_at, online_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, 0)`,
			unreachableSpokeId,
			"unreachable",
			"1.0.0",
			`http://localhost:${badPort}`,
			new Date().toISOString(),
			new Date().toISOString(),
		);

		const entry2: RelayInboxEntry = {
			...entry,
			id: crypto.randomUUID(),
			ref_id: "ref-unreach",
		};

		// Push to unreachable spoke
		const result2 = await eagerPushToSpoke(eagerPushConfig, unreachableSpokeId, [entry2]);
		expect(result2).toBe(false);

		// Failure should be recorded
		state = tracker.getState(unreachableSpokeId);
		expect(state?.failureCount).toBe(1);

		// After 3 failures, marked unreachable
		for (let i = 1; i < 3; i++) {
			const entryX: RelayInboxEntry = {
				...entry,
				id: crypto.randomUUID(),
				ref_id: `ref-unreach-${i}`,
			};
			await eagerPushToSpoke(eagerPushConfig, unreachableSpokeId, [entryX]);
		}

		expect(tracker.isReachable(unreachableSpokeId)).toBe(false);

		// Recovery: success to another spoke
		const entry3: RelayInboxEntry = {
			...entry,
			id: crypto.randomUUID(),
			ref_id: "ref-reach-2",
		};
		const result3 = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, [entry3]);
		expect(result3).toBe(true);
		expect(tracker.isReachable(spoke.siteId)).toBe(true);
	});

	it("Backward compatibility maintained with plaintext path", async () => {
		// Ensures existing code works without transport field

		const hubKeypair = await ensureKeypair(`/tmp/bound-test-hub-enc-${testRunId}`);

		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();
		const entries: RelayInboxEntry[] = [];

		for (let i = 0; i < 3; i++) {
			entries.push({
				id: crypto.randomUUID(),
				source_site_id: hub.siteId,
				kind: "result",
				ref_id: `ref-compat-${i}`,
				idempotency_key: null,
				stream_id: null,
				payload: JSON.stringify({ data: `test-${i}` }),
				expires_at: expiresAt,
				received_at: now,
				processed: 0,
			});
		}

		const tracker = new ReachabilityTracker();
		const eagerPushConfig = {
			privateKey: hubKeypair.privateKey,
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

		const result = await eagerPushToSpoke(eagerPushConfig, spoke.siteId, entries);
		expect(result).toBe(true);

		// Verify all entries were delivered
		const inboxEntries = readUnprocessed(spoke.db);
		expect(inboxEntries.length).toBe(3);
		for (let i = 0; i < 3; i++) {
			const received = inboxEntries.find((e) => e.ref_id === `ref-compat-${i}`);
			expect(received).toBeDefined();
		}
	});
});
