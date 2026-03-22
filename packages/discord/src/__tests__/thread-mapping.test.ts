import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppContext } from "@bound/core";
import { findOrCreateThread, mapDiscordUser } from "../thread-mapping";

describe("Thread Mapping", () => {
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
				bob: {
					display_name: "Bob",
					discord_id: "bob-discord-456",
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

	it("mapDiscordUser returns null for non-allowlisted discord_id", () => {
		const ctx = createAppContext(configDir, dbPath);

		const result = mapDiscordUser(ctx.db, "unknown-discord-id");

		expect(result).toBe(null);
	});

	it("mapDiscordUser returns user for allowlisted discord_id", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();
		const userId = randomUUID();

		// Insert alice
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId, "Alice", "alice-discord-123", now, now],
		);

		const result = mapDiscordUser(ctx.db, "alice-discord-123");

		expect(result).toBeDefined();
		expect(result?.id).toBe(userId);
		expect(result?.display_name).toBe("Alice");
		expect(result?.discord_id).toBe("alice-discord-123");
	});

	it("findOrCreateThread creates new thread for new user", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();
		const userId = randomUUID();

		// Insert alice
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId, "Alice", "alice-discord-123", now, now],
		);

		const thread = findOrCreateThread(ctx.db, userId, "discord", ctx.siteId);

		expect(thread).toBeDefined();
		expect(thread.user_id).toBe(userId);
		expect(thread.interface).toBe("discord");
		expect(thread.host_origin).toBe(ctx.siteId);
		expect(thread.deleted).toBe(0);
	});

	it("findOrCreateThread returns same thread on second call", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();
		const userId = randomUUID();

		// Insert alice
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId, "Alice", "alice-discord-123", now, now],
		);

		const thread1 = findOrCreateThread(ctx.db, userId, "discord", ctx.siteId);
		const thread2 = findOrCreateThread(ctx.db, userId, "discord", ctx.siteId);

		expect(thread1.id).toBe(thread2.id);
	});

	it("findOrCreateThread creates separate threads for different users", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();
		const userId1 = randomUUID();
		const userId2 = randomUUID();

		// Insert alice and bob
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId1, "Alice", "alice-discord-123", now, now],
		);
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId2, "Bob", "bob-discord-456", now, now],
		);

		const thread1 = findOrCreateThread(ctx.db, userId1, "discord", ctx.siteId);
		const thread2 = findOrCreateThread(ctx.db, userId2, "discord", ctx.siteId);

		expect(thread1.id).not.toBe(thread2.id);
		expect(thread1.user_id).toBe(userId1);
		expect(thread2.user_id).toBe(userId2);
	});
});
