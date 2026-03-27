import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { RelayProcessor } from "@bound/agent";
import { insertRow } from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { EventBroadcastPayload } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("platform-connectors Phase 7 — event broadcast integration", () => {
	let hub: TestInstance;
	let spokeA: TestInstance;
	let spokeB: TestInstance;
	let testRunId: string;

	beforeEach(async () => {
		testRunId = randomBytes(4).toString("hex");
		const portHub = 10000 + Math.floor(Math.random() * 40000);
		const portA = portHub + 1;
		const portB = portHub + 2;

		// Generate keypairs for all three instances upfront
		const keypairHub = await ensureKeypair(`/tmp/bound-bc-keys-hub-${testRunId}`);
		const keypairA = await ensureKeypair(`/tmp/bound-bc-keys-a-${testRunId}`);
		const keypairB = await ensureKeypair(`/tmp/bound-bc-keys-b-${testRunId}`);

		const pubKeyHub = await exportPublicKey(keypairHub.publicKey);
		const pubKeyA = await exportPublicKey(keypairA.publicKey);
		const pubKeyB = await exportPublicKey(keypairB.publicKey);

		// Create keyring shared by all three
		const keyring: KeyringConfig = {
			hosts: {
				[keypairHub.siteId]: {
					public_key: pubKeyHub,
					url: `http://localhost:${portHub}`,
				},
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

		hub = await createTestInstance({
			name: "hub",
			port: portHub,
			dbPath: `/tmp/bound-bc-hub-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-bc-keys-hub-${testRunId}`,
		});

		spokeA = await createTestInstance({
			name: "spokeA",
			port: portA,
			dbPath: `/tmp/bound-bc-a-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring,
			keypairPath: `/tmp/bound-bc-keys-a-${testRunId}`,
		});

		spokeB = await createTestInstance({
			name: "spokeB",
			port: portB,
			dbPath: `/tmp/bound-bc-b-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portHub,
			keyring,
			keypairPath: `/tmp/bound-bc-keys-b-${testRunId}`,
		});
	});

	afterEach(async () => {
		await hub.cleanup();
		await spokeA.cleanup();
		await spokeB.cleanup();
	});

	it("AC4.3: RelayProcessor fires event_broadcast on eventBus, making event available for Scheduler", async () => {
		const now = new Date().toISOString();
		const userId = randomUUID();
		const threadId = randomUUID();
		const taskId = randomUUID();

		// Seed an event-driven task in spokeB's DB
		// The task has trigger_type = "event" and trigger_value = "test:custom-event"
		insertRow(
			spokeB.db,
			"users",
			{
				id: userId,
				display_name: "Test User",
				platform_ids: "{}",
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			spokeB.siteId,
		);

		insertRow(
			spokeB.db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "test",
				host_origin: spokeB.siteId,
				color: 0xffffff,
				title: "Test",
				created_at: now,
				modified_at: now,
				last_message_at: now,
				deleted: 0,
			},
			spokeB.siteId,
		);

		insertRow(
			spokeB.db,
			"tasks",
			{
				id: taskId,
				type: "custom",
				status: "pending",
				thread_id: threadId,
				trigger_spec: JSON.stringify({
					trigger_type: "event",
					trigger_value: "test:custom-event",
				}),
				inject_mode: "after",
				created_at: now,
				created_by: userId,
				modified_at: now,
				deleted: 0,
			},
			spokeB.siteId,
		);

		// Write event_broadcast relay directly to spokeB's inbox
		// (simulating successful delivery via sync)
		const broadcastId = randomUUID();
		spokeB.db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				broadcastId,
				spokeA.siteId,
				"event_broadcast",
				null,
				`event_broadcast:test:custom-event:${randomUUID()}`,
				JSON.stringify({
					event_name: "test:custom-event",
					event_payload: { detail: "test payload" },
					source_host: "spokeA",
					event_depth: 1,
				} satisfies EventBroadcastPayload),
				new Date(Date.now() + 60_000).toISOString(),
				now,
				0,
			],
		);

		// Set up spokeB's RelayProcessor to process the event_broadcast
		const spokeBEventBus = new TypedEventEmitter();
		const firedEvents: string[] = [];

		// Register listener for the custom event
		spokeBEventBus.on("test:custom-event" as never, () => {
			firedEvents.push("test:custom-event");
		});

		const spokeBProcessor = new RelayProcessor(
			spokeB.db,
			spokeB.siteId,
			new Map(),
			null,
			new Set([hub.siteId, spokeA.siteId, spokeB.siteId]),
			{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			spokeBEventBus,
		);

		const processorHandle = spokeBProcessor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 200));
		processorHandle.stop();

		// Assert: "test:custom-event" was fired on spokeB's eventBus
		expect(firedEvents).toContain("test:custom-event");

		// Verify the event fired which would trigger task evaluation
		// (Actual scheduler behavior is covered by scheduler tests)
		expect(firedEvents.length).toBeGreaterThan(0);

		// Verify task exists and is still pending (waiting for scheduler to claim it)
		const task = spokeB.db
			.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ? LIMIT 1")
			.get(taskId);

		expect(task).toBeDefined();
		expect(task?.status).toBe("pending");
	});
});
