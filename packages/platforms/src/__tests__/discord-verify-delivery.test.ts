/**
 * DiscordConnector.verifyDelivery — post-loop hook that decides whether
 * the agent actually reached the user via discord_send_message, or whether
 * the current turn ended without a delivered reply.
 *
 * Rules:
 *   - "delivered": at least one successful discord_send_message tool_result
 *     exists for messages newer than turnStartAt.
 *   - "intentional-silence": the turn WAS triggered by a retry-nudge message
 *     (identified by messages.metadata.discord_platform_delivery_retry), and
 *     the agent chose not to call discord_send_message in response. This
 *     respects deliberate silence after the agent has been explicitly told
 *     the user cannot see plain assistant text.
 *   - "missing": neither of the above — first-turn terminal without a send.
 *     Produces a nudge string for the caller to enqueue as a notification.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { applySchema, insertRow, writeMessageMetadata } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { DiscordClientManager } from "../connectors/discord-client-manager.js";
import { DiscordConnector } from "../connectors/discord.js";

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

const createMockClientManager = (): DiscordClientManager => {
	const mockClient = { on: () => {}, off: () => {} };
	return {
		getClient: () => mockClient,
		connect: async () => {},
		disconnect: async () => {},
	} as unknown as DiscordClientManager;
};

describe("DiscordConnector.verifyDelivery (P2.1)", () => {
	let db: Database;
	let testDbPath: string;
	let eventBus: TypedEventEmitter;
	let connector: DiscordConnector;
	const siteId = "verify-site";

	beforeEach(() => {
		testDbPath = `/tmp/test-verify-${randomBytes(4).toString("hex")}.db`;
		const sqlite3 = require("bun:sqlite");
		db = new sqlite3.Database(testDbPath);
		applySchema(db);
		eventBus = new TypedEventEmitter();
		const config: PlatformConnectorConfig = {
			name: "discord",
			type: "discord",
			settings: { token: "stub" },
		};
		connector = new DiscordConnector(
			config,
			db,
			siteId,
			eventBus,
			createMockLogger(),
			createMockClientManager(),
		);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {}
		try {
			unlinkSync(testDbPath);
		} catch {}
	});

	function seedThread(): string {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"users",
			{ id: userId, display_name: "vd", first_seen_at: now, modified_at: now, deleted: 0 },
			siteId,
		);
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "discord",
				host_origin: "test",
				color: 0,
				title: "t",
				summary: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
		return threadId;
	}

	function insertToolCall(
		threadId: string,
		toolUseId: string,
		toolName: string,
		at: string,
	): string {
		const id = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id,
				thread_id: threadId,
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: toolUseId, name: toolName, input: { content: "hi" } },
				]),
				model_id: null,
				tool_name: null,
				created_at: at,
				modified_at: at,
				host_origin: "test",
				deleted: 0,
			},
			siteId,
		);
		return id;
	}

	function insertToolResult(
		threadId: string,
		toolUseId: string,
		content: string,
		at: string,
	): string {
		const id = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id,
				thread_id: threadId,
				role: "tool_result",
				content,
				model_id: null,
				tool_name: toolUseId,
				created_at: at,
				modified_at: at,
				host_origin: "test",
				deleted: 0,
			},
			siteId,
		);
		return id;
	}

	function insertDeveloperMessage(
		threadId: string,
		content: string,
		at: string,
		metadata?: Record<string, unknown>,
	): string {
		const id = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id,
				thread_id: threadId,
				role: "developer",
				content,
				model_id: null,
				tool_name: null,
				created_at: at,
				modified_at: at,
				host_origin: "test",
				deleted: 0,
				metadata: metadata ? JSON.stringify(metadata) : null,
			},
			siteId,
		);
		return id;
	}

	it("returns delivered when discord_send_message tool_result landed this turn", async () => {
		const threadId = seedThread();
		const turnStartAt = new Date(Date.now() - 10_000).toISOString();
		const toolUseId = "tooluse_abc123";
		insertToolCall(threadId, toolUseId, "discord_send_message", new Date().toISOString());
		insertToolResult(threadId, toolUseId, "sent", new Date().toISOString());

		const verdict = await connector.verifyDelivery(threadId, turnStartAt);
		expect(verdict.kind).toBe("delivered");
	});

	it("returns missing with a nudge when no send tool call happened this turn", async () => {
		const threadId = seedThread();
		const turnStartAt = new Date(Date.now() - 10_000).toISOString();
		// The agent used some other tool but never called discord_send_message.
		const toolUseId = "tooluse_xyz789";
		insertToolCall(threadId, toolUseId, "query", new Date().toISOString());
		insertToolResult(threadId, toolUseId, "[]", new Date().toISOString());

		const verdict = await connector.verifyDelivery(threadId, turnStartAt);
		expect(verdict.kind).toBe("missing");
		if (verdict.kind === "missing") {
			// The nudge should mention the tool name and authorize silence.
			expect(verdict.nudge).toContain("discord_send_message");
			expect(verdict.nudge.toLowerCase()).toContain("silence");
		}
	});

	it("returns missing when the agent produced plain text but no tool call", async () => {
		const threadId = seedThread();
		const turnStartAt = new Date(Date.now() - 10_000).toISOString();
		// Assistant text but no tool_call at all — the textbook failure mode.
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "assistant",
				content: "I think the answer is 42.",
				model_id: "test-model",
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "test",
				deleted: 0,
			},
			siteId,
		);

		const verdict = await connector.verifyDelivery(threadId, turnStartAt);
		expect(verdict.kind).toBe("missing");
	});

	it("returns delivered even when another failing tool was also used", async () => {
		// Presence of any successful discord_send_message wins regardless of
		// concurrent tool failures.
		const threadId = seedThread();
		const turnStartAt = new Date(Date.now() - 10_000).toISOString();
		insertToolCall(threadId, "tooluse_query", "query", new Date().toISOString());
		insertToolResult(threadId, "tooluse_query", "Error: syntax", new Date().toISOString());
		insertToolCall(threadId, "tooluse_send", "discord_send_message", new Date().toISOString());
		insertToolResult(threadId, "tooluse_send", "sent", new Date().toISOString());

		const verdict = await connector.verifyDelivery(threadId, turnStartAt);
		expect(verdict.kind).toBe("delivered");
	});

	it("returns intentional-silence when a prior retry-nudge exists and agent stayed silent", async () => {
		const threadId = seedThread();
		// The previous turn nudged; its developer message carries the retry
		// metadata. This turn followed that nudge and produced no send.
		const nudgeAt = new Date(Date.now() - 60_000).toISOString();
		insertDeveloperMessage(threadId, "[Delivery retry] ...", nudgeAt, {
			discord_platform_delivery_retry: randomUUID(),
		});
		// Current turn began after the nudge and produced only thinking/text.
		const turnStartAt = new Date(Date.now() - 10_000).toISOString();
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "assistant",
				content: "staying silent",
				model_id: "test-model",
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "test",
				deleted: 0,
			},
			siteId,
		);

		const verdict = await connector.verifyDelivery(threadId, turnStartAt);
		expect(verdict.kind).toBe("intentional-silence");
	});

	it("prefers delivered over intentional-silence when agent did call the tool", async () => {
		const threadId = seedThread();
		const nudgeAt = new Date(Date.now() - 60_000).toISOString();
		insertDeveloperMessage(threadId, "[Delivery retry] ...", nudgeAt, {
			discord_platform_delivery_retry: randomUUID(),
		});
		const turnStartAt = new Date(Date.now() - 10_000).toISOString();
		insertToolCall(threadId, "tooluse_final", "discord_send_message", new Date().toISOString());
		insertToolResult(threadId, "tooluse_final", "sent", new Date().toISOString());

		const verdict = await connector.verifyDelivery(threadId, turnStartAt);
		expect(verdict.kind).toBe("delivered");
	});

	it("writeMessageMetadata produces the marker that verifyDelivery recognizes", () => {
		// Regression guard on the metadata read path: the key we write with
		// writeMessageMetadata is exactly what verifyDelivery queries for.
		const threadId = seedThread();
		const at = new Date(Date.now() - 60_000).toISOString();
		const id = insertDeveloperMessage(threadId, "[Delivery retry] ...", at);
		writeMessageMetadata(db, id, { discord_platform_delivery_retry: "uuid-123" }, siteId);

		const row = db.query("SELECT metadata FROM messages WHERE id = ?").get(id) as {
			metadata: string;
		};
		const meta = JSON.parse(row.metadata);
		expect(meta.discord_platform_delivery_retry).toBe("uuid-123");
	});
});
