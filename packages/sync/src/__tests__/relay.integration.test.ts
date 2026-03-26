import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { readUndelivered, readUnprocessed, writeOutbox } from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import type { RelayExecutor } from "../relay-executor.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("relay integration tests", () => {
	let instanceA: TestInstance;
	let instanceB: TestInstance;
	let keyring: KeyringConfig;
	let testRunId: string;

	// Helper to create hub and spoke instances with optional executor
	async function setupInstances(executor?: RelayExecutor) {
		// Generate unique ID for this test run to avoid port/file conflicts
		testRunId = randomBytes(4).toString("hex");

		// Generate unique ports for this test run
		const portA = 10000 + Math.floor(Math.random() * 50000);
		const portB = portA + 1;

		// Generate keypairs for both instances upfront
		const keypairA = await ensureKeypair(`/tmp/bound-test-keys-a-${testRunId}`);
		const keypairB = await ensureKeypair(`/tmp/bound-test-keys-b-${testRunId}`);

		const pubKeyA = await exportPublicKey(keypairA.publicKey);
		const pubKeyB = await exportPublicKey(keypairB.publicKey);

		// Create keyring shared by both
		keyring = {
			hosts: {
				[keypairA.siteId]: {
					public_key: pubKeyA,
					url: `http://localhost:${portA}`,
				},
				[keypairB.siteId]: {
					public_key: pubKeyB,
					url: `http://localhost:${portB}`,
				},
			},
		};

		// Create instances using the pre-generated keypairs
		instanceA = await createTestInstance({
			name: "a",
			port: portA,
			dbPath: `/tmp/bound-test-a-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-test-keys-a-${testRunId}`,
			relayExecutor: executor,
		});

		instanceB = await createTestInstance({
			name: "b",
			port: portB,
			dbPath: `/tmp/bound-test-b-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portA,
			keyring,
			keypairPath: `/tmp/bound-test-keys-b-${testRunId}`,
		});
	}

	beforeEach(async () => {
		// Setup with default (no executor)
		await setupInstances();
	});

	afterEach(async () => {
		await instanceA.cleanup();
		await instanceB.cleanup();
	});

	it("AC1.2: Hub-local relay execution - spoke sends request targeting hub, hub executes locally via executor, spoke receives result", async () => {
		// Setup executor that echoes back a successful result
		const executor: RelayExecutor = async (request, hubSiteId) => {
			return [
				{
					id: crypto.randomUUID(),
					source_site_id: hubSiteId,
					kind: "result",
					ref_id: request.id,
					idempotency_key: null,
					stream_id: request.stream_id ?? null,
					payload: JSON.stringify({
						status: "success",
						data: "echoed from hub executor",
					}),
					expires_at: request.expires_at,
					received_at: new Date().toISOString(),
					processed: 0,
				},
			];
		};

		// Cleanup old instances and setup with executor
		await instanceA.cleanup();
		await instanceB.cleanup();
		await setupInstances(executor);

		// Verify spoke instance has syncClient
		expect(instanceB.syncClient).toBeDefined();

		// Spoke writes a relay outbox entry targeting the hub
		const requestId = crypto.randomUUID();
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();

		writeOutbox(instanceB.db, {
			id: requestId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "request",
			ref_id: requestId,
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ test: "data" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Verify outbox entry exists
		const outboxBefore = readUndelivered(instanceB.db);
		expect(outboxBefore).toHaveLength(1);

		// Spoke runs sync cycle (which includes relay phase)
		const syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Verify outbox entry is marked delivered
		const outboxAfter = readUndelivered(instanceB.db);
		expect(outboxAfter).toHaveLength(0);

		// Verify spoke received the result in inbox
		const inboxB = readUnprocessed(instanceB.db);
		expect(inboxB.length).toBeGreaterThan(0);
		const resultEntry = inboxB.find((e) => e.ref_id === requestId);
		expect(resultEntry).toBeDefined();
		expect(resultEntry?.kind).toBe("result");
		if (resultEntry) {
			const payload = JSON.parse(resultEntry.payload);
			expect(payload.data).toBe("echoed from hub executor");
		}
	});

	it("AC5.2: Idempotency - hub rejects duplicate outbox pushes with same idempotency_key targeting another spoke", async () => {
		// Setup a hub and two spokes to test spoke-to-spoke routing with idempotency
		const portHub = 10000 + Math.floor(Math.random() * 50000);
		const portSpoke1 = portHub + 1;
		const portSpoke2 = portHub + 2;

		// Generate keypairs
		const keypairHub = await ensureKeypair(`/tmp/bound-test-hub-idempotency-${testRunId}`);
		const keypairSpoke1 = await ensureKeypair(`/tmp/bound-test-spoke1-idempotency-${testRunId}`);
		const keypairSpoke2 = await ensureKeypair(`/tmp/bound-test-spoke2-idempotency-${testRunId}`);

		const pubKeyHub = await exportPublicKey(keypairHub.publicKey);
		const pubKeySpoke1 = await exportPublicKey(keypairSpoke1.publicKey);
		const pubKeySpoke2 = await exportPublicKey(keypairSpoke2.publicKey);

		const keyringIdempotency: KeyringConfig = {
			hosts: {
				[keypairHub.siteId]: {
					public_key: pubKeyHub,
					url: `http://localhost:${portHub}`,
				},
				[keypairSpoke1.siteId]: {
					public_key: pubKeySpoke1,
					url: `http://localhost:${portSpoke1}`,
				},
				[keypairSpoke2.siteId]: {
					public_key: pubKeySpoke2,
					url: `http://localhost:${portSpoke2}`,
				},
			},
		};

		// Create hub
		const hub = await createTestInstance({
			name: "hub",
			port: portHub,
			dbPath: `/tmp/bound-test-hub-idempotency-${testRunId}/bound.db`,
			role: "hub",
			keyring: keyringIdempotency,
			keypairPath: `/tmp/bound-test-hub-idempotency-${testRunId}`,
		});

		// Create spoke1 and spoke2
		const spoke1 = await createTestInstance({
			name: "spoke1",
			port: portSpoke1,
			dbPath: `/tmp/bound-test-spoke1-idempotency-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring: keyringIdempotency,
			keypairPath: `/tmp/bound-test-spoke1-idempotency-${testRunId}`,
		});

		const spoke2 = await createTestInstance({
			name: "spoke2",
			port: portSpoke2,
			dbPath: `/tmp/bound-test-spoke2-idempotency-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring: keyringIdempotency,
			keypairPath: `/tmp/bound-test-spoke2-idempotency-${testRunId}`,
		});

		try {
			// Verify spoke instances have syncClient
			expect(spoke1.syncClient).toBeDefined();
			expect(spoke2.syncClient).toBeDefined();

			const idempotencyKey = crypto.randomUUID();
			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			// First request: Spoke1 sends message to Spoke2 with idempotency_key
			const requestId1 = crypto.randomUUID();
			writeOutbox(spoke1.db, {
				id: requestId1,
				source_site_id: spoke1.siteId,
				target_site_id: spoke2.siteId,
				kind: "relay_message",
				ref_id: requestId1,
				idempotency_key: idempotencyKey,
				stream_id: null,
				payload: JSON.stringify({ attempt: 1 }),
				created_at: now,
				expires_at: expiresAt,
			});

			// First sync - hub stores message for spoke2
			let syncResult = await spoke1.syncClient?.syncCycle();
			expect(syncResult?.ok).toBe(true);

			// Verify request is delivered
			let outbox1 = readUndelivered(spoke1.db);
			expect(outbox1).toHaveLength(0);

			// Second request: Spoke1 sends another message to Spoke2 with SAME idempotency_key but different ID
			const requestId2 = crypto.randomUUID();
			writeOutbox(spoke1.db, {
				id: requestId2,
				source_site_id: spoke1.siteId,
				target_site_id: spoke2.siteId,
				kind: "relay_message",
				ref_id: requestId2,
				idempotency_key: idempotencyKey,
				stream_id: null,
				payload: JSON.stringify({ attempt: 2 }),
				created_at: now,
				expires_at: expiresAt,
			});

			// Second sync - hub rejects duplicate due to idempotency_key
			syncResult = await spoke1.syncClient?.syncCycle();
			expect(syncResult?.ok).toBe(true);

			// Verify second request is marked delivered (idempotency dedup)
			outbox1 = readUndelivered(spoke1.db);
			expect(outbox1).toHaveLength(0);

			// Verify hub's outbox only has ONE copy of the message (the first one)
			const hubOutbox = readUndelivered(hub.db);
			const spoke2Targets = hubOutbox.filter((e) => e.target_site_id === spoke2.siteId);
			expect(spoke2Targets).toHaveLength(1);
			expect(spoke2Targets[0].idempotency_key).toBe(idempotencyKey);
		} finally {
			await hub.cleanup();
			await spoke1.cleanup();
			await spoke2.cleanup();
		}
	});

	it("Spoke→Hub→Spoke flow - message routed between two spokes via hub", async () => {
		// Need 3 instances: hub and two spokes
		const portHub = 10000 + Math.floor(Math.random() * 50000);
		const portSpoke1 = portHub + 1;
		const portSpoke2 = portHub + 2;

		// Generate keypairs
		const keypairHub = await ensureKeypair(`/tmp/bound-test-hub-${testRunId}`);
		const keypairSpoke1 = await ensureKeypair(`/tmp/bound-test-spoke1-${testRunId}`);
		const keypairSpoke2 = await ensureKeypair(`/tmp/bound-test-spoke2-${testRunId}`);

		const pubKeyHub = await exportPublicKey(keypairHub.publicKey);
		const pubKeySpoke1 = await exportPublicKey(keypairSpoke1.publicKey);
		const pubKeySpoke2 = await exportPublicKey(keypairSpoke2.publicKey);

		const keyringThree: KeyringConfig = {
			hosts: {
				[keypairHub.siteId]: {
					public_key: pubKeyHub,
					url: `http://localhost:${portHub}`,
				},
				[keypairSpoke1.siteId]: {
					public_key: pubKeySpoke1,
					url: `http://localhost:${portSpoke1}`,
				},
				[keypairSpoke2.siteId]: {
					public_key: pubKeySpoke2,
					url: `http://localhost:${portSpoke2}`,
				},
			},
		};

		// Create hub
		const hub = await createTestInstance({
			name: "hub",
			port: portHub,
			dbPath: `/tmp/bound-test-hub-${testRunId}/bound.db`,
			role: "hub",
			keyring: keyringThree,
			keypairPath: `/tmp/bound-test-hub-${testRunId}`,
		});

		// Create spokes
		const spoke1 = await createTestInstance({
			name: "spoke1",
			port: portSpoke1,
			dbPath: `/tmp/bound-test-spoke1-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring: keyringThree,
			keypairPath: `/tmp/bound-test-spoke1-${testRunId}`,
		});

		const spoke2 = await createTestInstance({
			name: "spoke2",
			port: portSpoke2,
			dbPath: `/tmp/bound-test-spoke2-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring: keyringThree,
			keypairPath: `/tmp/bound-test-spoke2-${testRunId}`,
		});

		try {
			// Spoke1 writes relay outbox entry targeting Spoke2
			const messageId = crypto.randomUUID();
			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			writeOutbox(spoke1.db, {
				id: messageId,
				source_site_id: spoke1.siteId,
				target_site_id: spoke2.siteId,
				kind: "relay_message",
				ref_id: messageId,
				idempotency_key: null,
				stream_id: null,
				payload: JSON.stringify({ message: "hello from spoke1" }),
				created_at: now,
				expires_at: expiresAt,
			});

			// Verify spoke instances have syncClient
			expect(spoke1.syncClient).toBeDefined();
			expect(spoke2.syncClient).toBeDefined();

			// Spoke1 syncs - hub stores message for Spoke2
			let syncResult = await spoke1.syncClient?.syncCycle();
			expect(syncResult?.ok).toBe(true);

			// Verify spoke1's outbox is empty
			const outbox1 = readUndelivered(spoke1.db);
			expect(outbox1).toHaveLength(0);

			// Spoke2 syncs - receives message from hub
			syncResult = await spoke2.syncClient?.syncCycle();
			expect(syncResult?.ok).toBe(true);

			// Verify spoke2 received the message in inbox
			const inbox2 = readUnprocessed(spoke2.db);
			expect(inbox2.length).toBeGreaterThan(0);
			const messageEntry = inbox2.find((e) => e.ref_id === messageId);
			expect(messageEntry).toBeDefined();
			expect(messageEntry?.source_site_id).toBe(spoke1.siteId);
			if (messageEntry) {
				const payload = JSON.parse(messageEntry.payload);
				expect(payload.message).toBe("hello from spoke1");
			}
		} finally {
			await hub.cleanup();
			await spoke1.cleanup();
			await spoke2.cleanup();
		}
	});

	it("Empty relay - spoke with no outbox entries syncs successfully with empty response", async () => {
		// Verify spoke instance has syncClient
		expect(instanceB.syncClient).toBeDefined();

		// Spoke with no outbox entries runs sync
		const syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Verify no inbox entries were created
		const inboxB = readUnprocessed(instanceB.db);
		expect(inboxB).toHaveLength(0);
	});

	it("Relay failure non-fatal - if relay endpoint returns error, sync still completes", async () => {
		// Create a broken relay executor that throws
		const brokenExecutor: RelayExecutor = async (_request, _hubSiteId) => {
			throw new Error("Executor broke!");
		};

		// Cleanup old instances and setup with broken executor
		await instanceA.cleanup();
		await instanceB.cleanup();
		await setupInstances(brokenExecutor);

		// Verify spoke instance has syncClient
		expect(instanceB.syncClient).toBeDefined();

		// Spoke writes a relay outbox entry
		const requestId = crypto.randomUUID();
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();

		writeOutbox(instanceB.db, {
			id: requestId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "request",
			ref_id: requestId,
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ test: "data" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Sync cycle should still succeed (relay failure is non-fatal)
		const syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Verify the sync result indicates push/pull succeeded
		if (syncResult?.ok) {
			expect(syncResult.value.pushed).toBeGreaterThanOrEqual(0);
			expect(syncResult.value.pulled).toBeGreaterThanOrEqual(0);
		}
	});

	it("INSERT OR IGNORE dedup - same relay inbox entry delivered twice results in only one row", async () => {
		const executor: RelayExecutor = async (request, hubSiteId) => {
			return [
				{
					id: crypto.randomUUID(),
					source_site_id: hubSiteId,
					kind: "result",
					ref_id: request.id,
					idempotency_key: null,
					stream_id: request.stream_id ?? null,
					payload: JSON.stringify({ test: "data" }),
					expires_at: request.expires_at,
					received_at: new Date().toISOString(),
					processed: 0,
				},
			];
		};

		// Cleanup old instances and setup with executor
		await instanceA.cleanup();
		await instanceB.cleanup();
		await setupInstances(executor);

		// Verify spoke instance has syncClient
		expect(instanceB.syncClient).toBeDefined();

		// Spoke writes a relay outbox entry
		const requestId = crypto.randomUUID();
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();

		writeOutbox(instanceB.db, {
			id: requestId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "request",
			ref_id: requestId,
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({ test: "data" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// First sync - receives result
		const syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		let inboxB = readUnprocessed(instanceB.db);
		const initialCount = inboxB.length;
		expect(initialCount).toBeGreaterThan(0);

		// Manually insert the same inbox entry again (simulating eager push + sync)
		const existingResult = inboxB.find((e) => e.ref_id === requestId);
		if (existingResult) {
			const inboxQuery = instanceB.db.query(
				"INSERT OR IGNORE INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			);
			inboxQuery.run([
				existingResult.id,
				existingResult.source_site_id,
				existingResult.kind,
				existingResult.ref_id,
				existingResult.idempotency_key,
				existingResult.stream_id,
				existingResult.payload,
				existingResult.expires_at,
				existingResult.received_at,
			]);
		}

		// Verify no duplicate was inserted
		inboxB = readUnprocessed(instanceB.db);
		expect(inboxB.length).toBe(initialCount);
	});

	it("stream_id round-trip - spoke writes outbox with stream_id, hub routes to target, target receives with same stream_id", async () => {
		// Setup a hub and two spokes
		const portHub = 10000 + Math.floor(Math.random() * 50000);
		const portSpoke1 = portHub + 1;
		const portSpoke2 = portHub + 2;

		// Generate keypairs
		const keypairHub = await ensureKeypair(`/tmp/bound-test-hub-stream-${testRunId}`);
		const keypairSpoke1 = await ensureKeypair(`/tmp/bound-test-spoke1-stream-${testRunId}`);
		const keypairSpoke2 = await ensureKeypair(`/tmp/bound-test-spoke2-stream-${testRunId}`);

		const pubKeyHub = await exportPublicKey(keypairHub.publicKey);
		const pubKeySpoke1 = await exportPublicKey(keypairSpoke1.publicKey);
		const pubKeySpoke2 = await exportPublicKey(keypairSpoke2.publicKey);

		const keyringStream: KeyringConfig = {
			hosts: {
				[keypairHub.siteId]: {
					public_key: pubKeyHub,
					url: `http://localhost:${portHub}`,
				},
				[keypairSpoke1.siteId]: {
					public_key: pubKeySpoke1,
					url: `http://localhost:${portSpoke1}`,
				},
				[keypairSpoke2.siteId]: {
					public_key: pubKeySpoke2,
					url: `http://localhost:${portSpoke2}`,
				},
			},
		};

		// Create hub
		const hub = await createTestInstance({
			name: "hub-stream",
			port: portHub,
			dbPath: `/tmp/bound-test-hub-stream-${testRunId}/bound.db`,
			role: "hub",
			keyring: keyringStream,
			keypairPath: `/tmp/bound-test-hub-stream-${testRunId}`,
		});

		// Create spokes
		const spoke1 = await createTestInstance({
			name: "spoke1-stream",
			port: portSpoke1,
			dbPath: `/tmp/bound-test-spoke1-stream-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring: keyringStream,
			keypairPath: `/tmp/bound-test-spoke1-stream-${testRunId}`,
		});

		const spoke2 = await createTestInstance({
			name: "spoke2-stream",
			port: portSpoke2,
			dbPath: `/tmp/bound-test-spoke2-stream-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring: keyringStream,
			keypairPath: `/tmp/bound-test-spoke2-stream-${testRunId}`,
		});

		try {
			// Verify spoke instances have syncClient
			expect(spoke1.syncClient).toBeDefined();
			expect(spoke2.syncClient).toBeDefined();

			// Spoke1 writes relay outbox entry targeting Spoke2 WITH stream_id
			const streamId = crypto.randomUUID();
			const now = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 60000).toISOString();

			writeOutbox(spoke1.db, {
				id: crypto.randomUUID(),
				source_site_id: spoke1.siteId,
				target_site_id: spoke2.siteId,
				kind: "stream_chunk",
				ref_id: null,
				idempotency_key: null,
				stream_id: streamId,
				payload: JSON.stringify({ chunks: [], seq: 1 }),
				created_at: now,
				expires_at: expiresAt,
			});

			// Spoke1 syncs - hub should store message with stream_id preserved
			let syncResult = await spoke1.syncClient?.syncCycle();
			expect(syncResult?.ok).toBe(true);

			// Verify spoke1's outbox is empty (delivered)
			const outbox1 = readUndelivered(spoke1.db);
			expect(outbox1).toHaveLength(0);

			// Verify hub's outbox has the entry with stream_id preserved
			const hubOutbox = readUndelivered(hub.db);
			const spoke2Targets = hubOutbox.filter((e) => e.target_site_id === spoke2.siteId);
			expect(spoke2Targets.length).toBeGreaterThan(0);
			const hubEntry = spoke2Targets[0];
			expect(hubEntry.stream_id).toBe(streamId);

			// Spoke2 syncs - should receive the message with stream_id preserved
			syncResult = await spoke2.syncClient?.syncCycle();
			expect(syncResult?.ok).toBe(true);

			// Verify spoke2 received the message with stream_id
			const inbox2 = readUnprocessed(spoke2.db);
			expect(inbox2.length).toBeGreaterThan(0);
			const streamEntry = inbox2.find((e) => e.stream_id === streamId);
			expect(streamEntry).toBeDefined();
			expect(streamEntry?.kind).toBe("stream_chunk");
			expect(streamEntry?.stream_id).toBe(streamId);
		} finally {
			await hub.cleanup();
			await spoke1.cleanup();
			await spoke2.cleanup();
		}
	});
});
