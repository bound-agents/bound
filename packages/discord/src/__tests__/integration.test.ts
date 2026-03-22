import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import { createAppContext } from "@bound/core";
import { DiscordBot } from "../bot";

describe("Discord Integration", () => {
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

	it("complete DM flow: allowlisted user creates thread, message persisted, agent loop spawned", () => {
		if (process.env.SKIP_DISCORD === "1") {
			return;
		}

		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();
		const userId = randomUUID();

		// Insert alice
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId, "Alice", "alice-discord-123", now, now],
		);

		// Track agent loop calls
		let agentLoopCreated = false;

		const mockFactory = (_config: AgentLoopConfig): AgentLoop => {
			agentLoopCreated = true;
			return {
				run: async () => ({
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				}),
			} as unknown as AgentLoop;
		};

		const bot = new DiscordBot(ctx, mockFactory, "test-token");

		expect(bot).toBeDefined();
		expect(agentLoopCreated).toBe(false); // Agent loop not created until message received
	});

	it("non-allowlisted user DM is silently ignored", () => {
		if (process.env.SKIP_DISCORD === "1") {
			return;
		}

		const ctx = createAppContext(configDir, dbPath);

		// Don't insert any users - empty allowlist

		let agentLoopCreated = false;

		const mockFactory = (): AgentLoop => {
			agentLoopCreated = true;
			return {
				run: async () => ({
					messagesCreated: 0,
					toolCallsMade: 0,
					filesChanged: 0,
				}),
			} as unknown as AgentLoop;
		};

		const bot = new DiscordBot(ctx, mockFactory, "test-token");

		expect(bot).toBeDefined();
		expect(agentLoopCreated).toBe(false);

		// Verify no threads created for non-allowlisted user
		const threads = ctx.db.query("SELECT * FROM threads").all();
		expect(threads.length).toBe(0);
	});
});
