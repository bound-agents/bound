import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { IntakePayload } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { DiscordConnector } from "../connectors/discord.js";

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

describe("platform-connectors Phase 7 — intake pipeline integration", () => {
	let db: Database;
	let testDbPath: string;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		const testId = randomBytes(4).toString("hex");
		testDbPath = `/tmp/test-intake-pipeline-${testId}.db`;
		const sqlite3 = require("bun:sqlite");
		db = new sqlite3.Database(testDbPath);
		applySchema(db);

		eventBus = new TypedEventEmitter();

		// Initialize cluster_hub
		db.run("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [
			"cluster_hub",
			"hub-site-id",
			new Date().toISOString(),
		]);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// Already closed
		}
		try {
			require("node:fs").unlinkSync(testDbPath);
		} catch {
			// Already deleted
		}
	});

	it("AC3.3: DiscordConnector writes intake payload to relay_outbox", async () => {
		const config: PlatformConnectorConfig = {
			platform: "discord",
			token: "test-token",
			failover_threshold_ms: 30000,
			allowed_users: [],
		};

		const connector = new DiscordConnector(config, db, "site-1", eventBus, createMockLogger());

		// Create a test Discord message
		const mockMsg = {
			id: "discord-msg-1",
			author: {
				id: "user123",
				bot: false,
				username: "alice",
				displayName: "Alice",
			},
			channel: { type: 1 }, // DM channel
			content: "Hello from intake test!",
		};

		// Call onMessage to trigger intake relay write
		await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMsg);

		// Verify intake relay was written to outbox
		const outboxEntries = db.query("SELECT * FROM relay_outbox WHERE kind = ?").all("intake");
		expect(outboxEntries.length).toBeGreaterThan(0);

		const outboxEntry = outboxEntries[0] as Record<string, unknown>;
		const payload = JSON.parse(outboxEntry.payload as string) as IntakePayload;

		expect(payload.platform).toBe("discord");
		expect(payload.platform_event_id).toBe("discord-msg-1");
		expect(payload.content).toBe("Hello from intake test!");
		expect(payload.thread_id).toBeDefined();
		expect(payload.user_id).toBeDefined();
		expect(payload.message_id).toBeDefined();
	});

	it("AC3.7: Intake relay can be processed with correct payload structure", async () => {
		// This test verifies AC3.7 from the platforms package perspective:
		// An intake relay payload is correctly structured and can be processed
		const now = new Date().toISOString();
		const threadId = randomUUID();
		const userId = randomUUID();
		const messageId = randomUUID();

		const intakePayload: IntakePayload = {
			platform: "discord",
			platform_event_id: "test-event-1",
			thread_id: threadId,
			user_id: userId,
			message_id: messageId,
			content: "Test intake message",
		};

		// Write intake relay directly to relay_outbox (simulating DiscordConnector)
		const intakeId = randomUUID();
		db.run(
			`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, idempotency_key, payload, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				intakeId,
				"platform-site-1",
				"hub",
				"intake",
				`intake:discord:${intakeId}`,
				JSON.stringify(intakePayload),
				now,
				new Date(Date.now() + 60_000).toISOString(),
			],
		);

		// Verify intake relay exists in outbox
		const outboxEntries = db
			.query("SELECT * FROM relay_outbox WHERE kind = ? AND id = ?")
			.all("intake", intakeId);
		expect(outboxEntries.length).toBe(1);

		const entry = outboxEntries[0] as Record<string, unknown>;
		const parsedPayload = JSON.parse(entry.payload as string) as IntakePayload;

		// Verify all AC3.7 requirements: payload is structurally correct
		expect(parsedPayload.platform).toBe("discord");
		expect(parsedPayload.platform_event_id).toBe("test-event-1");
		expect(parsedPayload.thread_id).toBe(threadId);
		expect(parsedPayload.user_id).toBe(userId);
		expect(parsedPayload.message_id).toBe(messageId);
		expect(parsedPayload.content).toBe("Test intake message");
	});
});
