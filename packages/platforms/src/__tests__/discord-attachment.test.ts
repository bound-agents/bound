import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { Logger, PlatformConnectorConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { DiscordClientManager } from "../connectors/discord-client-manager.js";
import { DiscordConnector } from "../connectors/discord.js";

// Store original fetch for restoration
const originalFetch = global.fetch;

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// Mock client manager
const createMockClientManager = (): DiscordClientManager => {
	// Tests call onMessage() directly via cast — no real client needed
	return {
		getClient: () => {
			throw new Error("No client in test");
		},
		connect: async () => {},
		disconnect: async () => {},
	} as unknown as DiscordClientManager;
};

describe("Discord attachment ingestion", () => {
	let db: Database;
	let testDbPath: string;
	let eventBus: TypedEventEmitter;
	let mockLogger: Logger;
	let config: PlatformConnectorConfig;

	beforeEach(() => {
		const testId = randomBytes(4).toString("hex");
		testDbPath = `/tmp/test-discord-attachment-${testId}.db`;
		const sqlite3 = require("bun:sqlite");
		db = new sqlite3.Database(testDbPath);
		applySchema(db);

		eventBus = new TypedEventEmitter();
		mockLogger = createMockLogger();

		config = {
			platform: "discord",
			token: "test-token",
			failover_threshold_ms: 30000,
			allowed_users: [],
		};

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

	afterAll(() => {
		// Restore original fetch
		global.fetch = originalFetch;
	});

	it("small image attachment stored as inline base64 ContentBlock (AC1.1, AC7.5)", async () => {
		const mockImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG header

		// Mock fetch to return image data
		(global as { fetch: typeof fetch }).fetch = async (url: string | URL | Request) => {
			if (String(url).includes("cdn.discordapp.com")) {
				return new Response(mockImageBytes, {
					headers: { "Content-Type": "image/png" },
				});
			}
			return originalFetch(url as RequestInfo | URL, undefined);
		};

		const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger, createMockClientManager());

		const attachment = {
			id: "att1",
			name: "photo.png",
			size: 1024,
			contentType: "image/png",
			url: "https://cdn.discordapp.com/photo.png",
			description: "my photo",
		};

		const mockMessage = {
			id: "msg-1",
			author: {
				id: "user123",
				bot: false,
				username: "alice",
				displayName: "Alice",
			},
			channel: { type: 1, sendTyping: async () => {} },
			content: "Here's a photo",
			attachments: {
				values: () => [attachment],
			},
		};

		await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMessage);

		// Query the message
		const messages = db
			.query("SELECT content FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1")
			.all("user");
		expect(messages.length).toBeGreaterThan(0);

		const message = messages[0] as { content: string };
		const blocks = JSON.parse(message.content);

		expect(Array.isArray(blocks)).toBe(true);
		expect(blocks.length).toBeGreaterThan(0);

		const imageBlock = blocks.find((b: { type: string }) => b.type === "image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock.source.type).toBe("base64");
		expect(imageBlock.source.media_type).toBe("image/png");
		expect(imageBlock.description).toBe("my photo");
		expect(imageBlock.source.data.length).toBeGreaterThan(0);

		// Verify text block is also present
		const textBlock = blocks.find((b: { type: string }) => b.type === "text");
		expect(textBlock).toBeDefined();
		expect(textBlock.text).toBe("Here's a photo");
	});

	it("large image attachment (>= 1MB) stored as file_ref (AC1.2, AC7.5)", async () => {
		// 2 MB attachment
		const largeBytes = new Uint8Array(2 * 1024 * 1024).fill(255);

		// Mock fetch to return large image data
		(global as { fetch: typeof fetch }).fetch = async () =>
			new Response(largeBytes, {
				headers: { "Content-Type": "image/jpeg" },
			});

		const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger, createMockClientManager());

		const attachment = {
			id: "att2",
			name: "big.jpg",
			size: 2 * 1024 * 1024,
			contentType: "image/jpeg",
			url: "https://cdn.discordapp.com/big.jpg",
		};

		const mockMessage = {
			id: "msg-2",
			author: {
				id: "user123",
				bot: false,
				username: "alice",
				displayName: "Alice",
			},
			channel: { type: 1, sendTyping: async () => {} },
			content: "Big image",
			attachments: {
				values: () => [attachment],
			},
		};

		await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMessage);

		// Check files table has entry
		const fileRows = db
			.query("SELECT id, content FROM files WHERE path LIKE ? LIMIT 1")
			.all("discord-attachments%");
		expect(fileRows.length).toBeGreaterThan(0);

		const fileRow = fileRows[0] as { id: string; content: string };
		expect(fileRow.content.length).toBeGreaterThan(0); // base64 stored

		// Check message has file_ref block
		const messages = db
			.query("SELECT content FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1")
			.all("user");
		expect(messages.length).toBeGreaterThan(0);

		const message = messages[0] as { content: string };
		const blocks = JSON.parse(message.content);

		const imageBlock = blocks.find((b: { type: string }) => b.type === "image");
		expect(imageBlock).toBeDefined();
		expect(imageBlock.source.type).toBe("file_ref");
		expect(imageBlock.source.file_id).toBe(fileRow.id);
		expect(imageBlock.description).toBe("big.jpg");
	});

	it("message with no image attachments stores plain text (backward-compat)", async () => {
		const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger, createMockClientManager());

		const mockMessage = {
			id: "msg-3",
			author: {
				id: "user123",
				bot: false,
				username: "alice",
				displayName: "Alice",
			},
			channel: { type: 1, sendTyping: async () => {} },
			content: "plain text",
			attachments: {
				values: () => [],
			},
		};

		await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMessage);

		const messages = db
			.query("SELECT content FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1")
			.all("user");
		expect(messages.length).toBeGreaterThan(0);

		const message = messages[0] as { content: string };
		// Plain text should not be JSON
		expect(message.content).toBe("plain text");
	});

	it("message with non-image attachments skips them gracefully", async () => {
		// Mock fetch
		(global as { fetch: typeof fetch }).fetch = async (url: string | URL | Request) => {
			if (String(url).includes("cdn.discordapp.com")) {
				return new Response(new Uint8Array([0, 0, 0, 0]), {
					headers: { "Content-Type": "application/pdf" },
				});
			}
			return originalFetch(url as RequestInfo | URL, undefined);
		};

		const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger, createMockClientManager());

		const attachment = {
			id: "att3",
			name: "document.pdf",
			size: 50000,
			contentType: "application/pdf",
			url: "https://cdn.discordapp.com/document.pdf",
		};

		const mockMessage = {
			id: "msg-4",
			author: {
				id: "user123",
				bot: false,
				username: "alice",
				displayName: "Alice",
			},
			channel: { type: 1, sendTyping: async () => {} },
			content: "check this doc",
			attachments: {
				values: () => [attachment],
			},
		};

		await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMessage);

		const messages = db
			.query("SELECT content FROM messages WHERE role = ? ORDER BY created_at DESC LIMIT 1")
			.all("user");
		expect(messages.length).toBeGreaterThan(0);

		const message = messages[0] as { content: string };
		// PDF should be skipped, so content is plain text
		expect(message.content).toBe("check this doc");
	});

	it("attachment metadata included in intake payload", async () => {
		const mockImageBytes = new Uint8Array([137, 80, 78, 71]); // PNG header

		// Mock fetch
		(global as { fetch: typeof fetch }).fetch = async (url: string | URL | Request) => {
			if (String(url).includes("cdn.discordapp.com")) {
				return new Response(mockImageBytes, {
					headers: { "Content-Type": "image/png" },
				});
			}
			return originalFetch(url as RequestInfo | URL, undefined);
		};

		const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger, createMockClientManager());

		const attachment = {
			id: "att4",
			name: "small.png",
			size: 2048,
			contentType: "image/png",
			url: "https://cdn.discordapp.com/small.png",
			description: "small image",
		};

		const mockMessage = {
			id: "msg-5",
			author: {
				id: "user123",
				bot: false,
				username: "alice",
				displayName: "Alice",
			},
			channel: { type: 1, sendTyping: async () => {} },
			content: "with attachment",
			attachments: {
				values: () => [attachment],
			},
		};

		await (connector as { onMessage: (msg: unknown) => Promise<void> }).onMessage(mockMessage);

		// Check intake relay payload includes attachments metadata
		const outboxEntries = db.query("SELECT * FROM relay_outbox WHERE kind = ?").all("intake");
		expect(outboxEntries.length).toBeGreaterThan(0);

		const outboxEntry = outboxEntries[outboxEntries.length - 1] as Record<string, unknown>;
		const payload = JSON.parse(outboxEntry.payload as string);

		expect(payload.attachments).toBeDefined();
		expect(Array.isArray(payload.attachments)).toBe(true);
		expect(payload.attachments.length).toBeGreaterThan(0);

		const payloadAttachment = payload.attachments[0];
		expect(payloadAttachment.filename).toBe("small.png");
		expect(payloadAttachment.content_type).toBe("image/png");
		expect(payloadAttachment.size).toBe(2048);
		expect(payloadAttachment.url).toBe("https://cdn.discordapp.com/small.png");
		expect(payloadAttachment.description).toBe("small image");
	});
});
