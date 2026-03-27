import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "crypto";
import type { KeyringConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { IntakePayload } from "@bound/shared";
import { RelayProcessor } from "@bound/agent";
import { writeOutbox } from "@bound/core";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("platform-connectors Phase 7 — intake pipeline integration", () => {
	let instanceA: TestInstance; // hub
	let instanceB: TestInstance; // spoke
	let testRunId: string;

	beforeEach(async () => {
		testRunId = randomBytes(4).toString("hex");
		const portA = 10000 + Math.floor(Math.random() * 40000);
		const portB = portA + 1;

		// Generate keypairs for both instances upfront
		const keypairA = await ensureKeypair(`/tmp/bound-intake-keys-a-${testRunId}`);
		const keypairB = await ensureKeypair(`/tmp/bound-intake-keys-b-${testRunId}`);

		const pubKeyA = await exportPublicKey(keypairA.publicKey);
		const pubKeyB = await exportPublicKey(keypairB.publicKey);

		// Create keyring shared by both - hosts is a Record with site_id as key
		const keyring: KeyringConfig = {
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

		instanceA = await createTestInstance({
			name: "a",
			port: portA,
			dbPath: `/tmp/bound-intake-a-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-intake-keys-a-${testRunId}`,
		});

		instanceB = await createTestInstance({
			name: "b",
			port: portB,
			dbPath: `/tmp/bound-intake-b-${testRunId}/bound.db`,
			role: "spoke",
			hubPort: portA,
			keyring,
			keypairPath: `/tmp/bound-intake-keys-b-${testRunId}`,
		});
	});

	afterEach(async () => {
		await instanceA.cleanup();
		await instanceB.cleanup();
	});

	it("AC3.7: RelayProcessor marks intake relay as processed", async () => {
		// This test verifies the RelayProcessor correctly handles intake relays
		// Setup: create intake relay directly in hub's inbox (simulating delivery via sync)
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const userId = randomUUID();
		const messageId = randomUUID();

		// Write intake relay directly to hub's inbox
		const intakeId = randomUUID();
		instanceA.db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				intakeId,
				instanceB.siteId,
				"intake",
				null,
				`intake:discord:test-event-1`,
				JSON.stringify({
					platform: "discord",
					platform_event_id: "test-event-1",
					thread_id: threadId,
					user_id: userId,
					message_id: messageId,
					content: "Hello!",
				} satisfies IntakePayload),
				new Date(Date.now() + 60_000).toISOString(),
				now,
				0,
			],
		);

		// Verify intake relay was added
		const initialInbox = instanceA.db
			.query("SELECT kind FROM relay_inbox WHERE kind = ? AND processed = 0")
			.all("intake") as Array<{ kind: string }>;
		expect(initialInbox.length).toBe(1);

		// Set up hub's RelayProcessor with thread-affinity map pointing to spoke
		const affinityMap = new Map([[threadId, instanceB.siteId]]);
		const hubEventBus = new TypedEventEmitter();
		const hubProcessor = new RelayProcessor(
			instanceA.db,
			instanceA.siteId,
			new Map(),
			null,
			new Set([instanceA.siteId, instanceB.siteId]),
			{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			hubEventBus,
			null,
			undefined,
			affinityMap,
		);

		// Process one tick
		const handle = hubProcessor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 200));
		handle.stop();

		// Verify intake was marked processed on hub
		const processedIntakes = instanceA.db
			.query("SELECT kind FROM relay_inbox WHERE kind = ? AND processed = 1 LIMIT 1")
			.all("intake") as Array<{ kind: string }>;
		expect(processedIntakes.length).toBeGreaterThan(0);
	});
});
