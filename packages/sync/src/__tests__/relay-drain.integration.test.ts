import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { writeOutbox } from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("relay drain integration tests", () => {
	let instanceA: TestInstance;
	let instanceB: TestInstance;
	let instanceC: TestInstance;
	let keyring: KeyringConfig;
	let testRunId: string;

	async function setupThreeInstances() {
		testRunId = randomBytes(4).toString("hex");

		const portA = 10000 + Math.floor(Math.random() * 50000);
		const portB = portA + 1;
		const portC = portA + 2;

		const keypairA = await ensureKeypair(`/tmp/bound-test-a-drain-${testRunId}`);
		const keypairB = await ensureKeypair(`/tmp/bound-test-b-drain-${testRunId}`);
		const keypairC = await ensureKeypair(`/tmp/bound-test-c-drain-${testRunId}`);

		const pubKeyA = await exportPublicKey(keypairA.publicKey);
		const pubKeyB = await exportPublicKey(keypairB.publicKey);
		const pubKeyC = await exportPublicKey(keypairC.publicKey);

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
				[keypairC.siteId]: {
					public_key: pubKeyC,
					url: `http://localhost:${portC}`,
				},
			},
		};

		instanceA = await createTestInstance({
			name: "a",
			port: portA,
			dbPath: `/tmp/bound-test-a-drain-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-test-a-drain-${testRunId}`,
		});

		instanceB = await createTestInstance({
			name: "b",
			port: portB,
			dbPath: `/tmp/bound-test-b-drain-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portA,
			keyring,
			keypairPath: `/tmp/bound-test-b-drain-${testRunId}`,
		});

		instanceC = await createTestInstance({
			name: "c",
			port: portC,
			dbPath: `/tmp/bound-test-c-drain-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-test-c-drain-${testRunId}`,
		});
	}

	beforeEach(async () => {
		await setupThreeInstances();
	});

	afterEach(async () => {
		await instanceA.cleanup();
		await instanceB.cleanup();
		await instanceC.cleanup();
	});

	it("AC4.2: during drain, spoke holds request-kind entries but sends response-kind entries", async () => {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();

		// Set drain flag on hub (simulating boundctl set-hub phase)
		instanceA.db
			.query("INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)")
			.run("relay_draining", "true");

		// Spoke syncs first to learn about the drain flag
		let syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Now write a response-kind entry (should be sent while draining)
		const resultId = crypto.randomUUID();
		writeOutbox(instanceB.db, {
			id: resultId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "result",
			ref_id: crypto.randomUUID(),
			idempotency_key: null,
			payload: JSON.stringify({ status: "success" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Write a request-kind entry (should be held during drain)
		const toolCallId = crypto.randomUUID();
		writeOutbox(instanceB.db, {
			id: toolCallId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "tool_call",
			ref_id: crypto.randomUUID(),
			idempotency_key: null,
			payload: JSON.stringify({ tool: "test" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Spoke syncs again - should filter outbox based on relay_draining flag
		syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Check: response-kind entry should be delivered, request-kind should be held
		const resultEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(resultId) as { delivered: number } | undefined;
		const toolCallEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(toolCallId) as { delivered: number } | undefined;

		expect(resultEntry?.delivered).toBe(1);
		expect(toolCallEntry?.delivered).toBe(0);
	});

	it("AC4.3: cancel entries flow during drain alongside response-kind entries", async () => {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();

		// Set drain flag
		instanceA.db
			.query("INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)")
			.run("relay_draining", "true");

		// Spoke syncs first to learn about the drain flag
		let syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Now write entries after drain flag is known
		// Write a response-kind entry
		const resultId = crypto.randomUUID();
		writeOutbox(instanceB.db, {
			id: resultId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "result",
			ref_id: crypto.randomUUID(),
			idempotency_key: null,
			payload: JSON.stringify({ status: "success" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Write a cancel entry
		const cancelId = crypto.randomUUID();
		writeOutbox(instanceB.db, {
			id: cancelId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "cancel",
			ref_id: crypto.randomUUID(),
			idempotency_key: null,
			payload: JSON.stringify({ ref_id: "something" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Write a request-kind entry (should be held)
		const toolCallId = crypto.randomUUID();
		writeOutbox(instanceB.db, {
			id: toolCallId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "tool_call",
			ref_id: crypto.randomUUID(),
			idempotency_key: null,
			payload: JSON.stringify({ tool: "test" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Spoke syncs again
		syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Check: both result and cancel should be delivered
		const resultEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(resultId) as { delivered: number } | undefined;
		const cancelEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(cancelId) as { delivered: number } | undefined;
		const toolCallEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(toolCallId) as { delivered: number } | undefined;

		expect(resultEntry?.delivered).toBe(1);
		expect(cancelEntry?.delivered).toBe(1);
		expect(toolCallEntry?.delivered).toBe(0);
	});

	it("AC4.4: after hub switch, held request-kind entries deliver to new hub on first sync", async () => {
		const now = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 60000).toISOString();

		// Set drain flag on hub A FIRST
		instanceA.db
			.query("INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)")
			.run("relay_draining", "true");

		// Spoke syncs to learn about drain flag
		let syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// NOW write a request-kind outbox entry while draining
		const toolCallId = crypto.randomUUID();
		writeOutbox(instanceB.db, {
			id: toolCallId,
			source_site_id: instanceB.siteId,
			target_site_id: instanceA.siteId,
			kind: "tool_call",
			ref_id: crypto.randomUUID(),
			idempotency_key: null,
			payload: JSON.stringify({ tool: "test" }),
			created_at: now,
			expires_at: expiresAt,
		});

		// Spoke syncs again - entry should be held
		syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Verify entry is still undelivered
		const heldEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(toolCallId) as { delivered: number } | undefined;
		expect(heldEntry?.delivered).toBe(0);

		// Update spoke's hub pointer to new hub
		instanceB.db
			.query("INSERT OR REPLACE INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)")
			.run("cluster_hub", instanceC.siteId, new Date().toISOString());

		// Update the held entry's target to point to the new hub
		instanceB.db
			.query("UPDATE relay_outbox SET target_site_id = ? WHERE id = ?")
			.run(instanceC.siteId, toolCallId);

		// Update spoke's sync client to point to new hub
		if (instanceB.syncClient) {
			instanceB.syncClient.updateHubUrl(`http://localhost:${instanceC.port}`);
		}

		// Clear drain flag on old hub
		instanceA.db.query("DELETE FROM host_meta WHERE key = 'relay_draining'").run();

		// Spoke syncs with new hub - hub URL changed and relayDraining was reset to false,
		// so held request-kind entry should deliver on FIRST sync after switch
		syncResult = await instanceB.syncClient?.syncCycle();
		expect(syncResult?.ok).toBe(true);

		// Verify entry is now delivered (on first sync with new hub)
		const deliveredEntry = instanceB.db
			.query("SELECT * FROM relay_outbox WHERE id = ?")
			.get(toolCallId) as { delivered: number } | undefined;
		expect(deliveredEntry?.delivered).toBe(1);
	});
});
