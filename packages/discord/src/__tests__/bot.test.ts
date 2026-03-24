import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoop } from "@bound/agent";
import { createAppContext } from "@bound/core";
import { DiscordBot, shouldActivate } from "../bot";

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
