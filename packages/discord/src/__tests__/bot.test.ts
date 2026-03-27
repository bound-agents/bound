import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoop } from "@bound/agent";
import { applySchema, createDatabase, createAppContext } from "@bound/core";
import { DiscordBot, shouldActivate, buildAttachmentContent } from "../bot";

describe("DiscordBot", () => {
	let configDir: string;
	let dbPath: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);

		const allowlist = {
			default_web_user: "alice",
			users: {
				alice: {
					display_name: "Alice",
					discord_id: "alice-discord-123",
				},
			},
		};

		const backends = {
			backends: [
				{
					id: "ollama-local",
					provider: "ollama",
					model: "llama3",
					context_window: 4096,
					tier: 1,
					base_url: "http://localhost:11434",
				},
			],
			default: "ollama-local",
		};

		writeFileSync(join(configDir, "allowlist.json"), JSON.stringify(allowlist));
		writeFileSync(join(configDir, "model_backends.json"), JSON.stringify(backends));
	});

	afterEach(() => {
		try {
			const fs = require("node:fs");
			fs.rmSync(configDir, { recursive: true });
		} catch {
			// ignore
		}
		try {
			const fs = require("node:fs");
			fs.unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it.skipIf(process.env.SKIP_DISCORD === "1")(
		"DiscordBot instantiates with context, factory, and token",
		() => {
			const ctx = createAppContext(configDir, dbPath);
			const now = new Date().toISOString();
			const userId = randomUUID();

			// Insert alice
			ctx.db.run(
				`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
				[userId, "Alice", "alice-discord-123", now, now],
			);

			const mockFactory = (_config: unknown) =>
				({
					run: () => Promise.resolve({ messagesCreated: 0, toolCallsMade: 0, filesChanged: 0 }),
				}) as AgentLoop;

			const bot = new DiscordBot(ctx, mockFactory, "test-token");

			expect(bot).toBeDefined();
		},
	);

	it("shouldActivate returns false when discord.json not found", () => {
		const ctx = createAppContext(configDir, dbPath);

		// discord.json does not exist
		const result = shouldActivate(ctx);

		expect(result).toBe(false);
	});

	it("shouldActivate returns true when discord.json exists and host matches", () => {
		// Create discord.json BEFORE context (so it's loaded during initialization)
		// Mock the hostname by passing it directly in the config
		const ctx = createAppContext(configDir, dbPath);

		// Override the hostname to match what we'll put in the config
		const testHostName = "test-host-match";
		Object.defineProperty(ctx, "hostName", { value: testHostName, writable: false });

		const discordConfig = {
			bot_token: "test-token",
			host: testHostName,
		};
		writeFileSync(join(configDir, "discord.json"), JSON.stringify(discordConfig));

		// Reload context with the new config
		const ctxWithConfig = createAppContext(configDir, dbPath);
		Object.defineProperty(ctxWithConfig, "hostName", { value: testHostName, writable: false });

		const result = shouldActivate(ctxWithConfig);

		expect(result).toBe(true);
	});

	describe("buildAttachmentContent", () => {
		it("appends text file content inline", async () => {
			const db = createDatabase(":memory:");
			applySchema(db);
			const siteId = randomUUID();
			const fileBytes = new TextEncoder().encode("const x = 42;");

			const result = await buildAttachmentContent(
				"look at this",
				[{ name: "index.ts", contentType: "text/typescript", url: "http://cdn/index.ts", size: fileBytes.byteLength }],
				db,
				siteId,
				"test-host",
				async (_url) => fileBytes.buffer as ArrayBuffer,
			);

			expect(result).toContain("look at this");
			expect(result).toContain("index.ts");
			expect(result).toContain("const x = 42;");

			// File must be stored in the DB
			const row = db.prepare("SELECT is_binary FROM files WHERE path LIKE '%index.ts'").get() as { is_binary: number } | null;
			expect(row).not.toBeNull();
			expect(row!.is_binary).toBe(0);
		});

		it("appends binary file metadata without raw content", async () => {
			const db = createDatabase(":memory:");
			applySchema(db);
			const siteId = randomUUID();
			const pngBytes = new Uint8Array([137, 80, 78, 71]);

			const result = await buildAttachmentContent(
				"",
				[{ name: "photo.png", contentType: "image/png", url: "http://cdn/photo.png", size: pngBytes.byteLength }],
				db,
				siteId,
				"test-host",
				async (_url) => pngBytes.buffer as ArrayBuffer,
			);

			expect(result).toContain("photo.png");
			expect(result).toContain("binary");
			// Must NOT dump base64 into the message
			expect(result).not.toContain(Buffer.from(pngBytes).toString("base64"));

			const row = db.prepare("SELECT is_binary FROM files WHERE path LIKE '%photo.png'").get() as { is_binary: number } | null;
			expect(row!.is_binary).toBe(1);
		});

		it("handles attachment-only message (empty text content)", async () => {
			const db = createDatabase(":memory:");
			applySchema(db);
			const textBytes = new TextEncoder().encode("data");
			const result = await buildAttachmentContent(
				"",
				[{ name: "data.csv", contentType: "text/csv", url: "http://cdn/data.csv", size: 4 }],
				db,
				randomUUID(),
				"host",
				async (_url) => textBytes.buffer as ArrayBuffer,
			);
			// Content should not be empty even though msg.content was ""
			expect(result.trim().length).toBeGreaterThan(0);
		});
	});

	it("shouldActivate returns false when host does not match", () => {
		// Create discord.json BEFORE context with a non-matching host
		const discordConfig = {
			bot_token: "test-token",
			host: "different-host-that-does-not-match",
		};
		writeFileSync(join(configDir, "discord.json"), JSON.stringify(discordConfig));

		const ctx = createAppContext(configDir, dbPath);

		const result = shouldActivate(ctx);

		expect(result).toBe(false);
	});
});
