import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppContext } from "@bound/core";
import { isAllowlisted } from "../allowlist";

describe("Allowlist", () => {
	let configDir: string;
	let dbPath: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);

		// Create valid config files
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
				charlie: {
					display_name: "Charlie",
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

	it("returns true for allowlisted user with discord_id", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();

		// Insert alice with discord_id
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[randomUUID(), "Alice", "alice-discord-123", now, now],
		);

		const result = isAllowlisted("alice-discord-123", ctx.db);

		expect(result).toBe(true);
	});

	it("returns true for another allowlisted user", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();

		// Insert bob with discord_id
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[randomUUID(), "Bob", "bob-discord-456", now, now],
		);

		const result = isAllowlisted("bob-discord-456", ctx.db);

		expect(result).toBe(true);
	});

	it("returns false for non-allowlisted discord_id", () => {
		const ctx = createAppContext(configDir, dbPath);

		// Unknown discord ID (not in database)
		const result = isAllowlisted("unknown-discord-789", ctx.db);

		expect(result).toBe(false);
	});

	it("returns false for user without discord_id", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();

		// Insert charlie with no discord_id
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[randomUUID(), "Charlie", null, now, now],
		);

		// Discord ID "charlie" does not exist in database
		const result = isAllowlisted("charlie", ctx.db);

		expect(result).toBe(false);
	});

	it("returns false for deleted users", () => {
		const ctx = createAppContext(configDir, dbPath);
		const now = new Date().toISOString();
		const userId = randomUUID();

		// Insert alice, then soft-delete
		ctx.db.run(
			`INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, 0)`,
			[userId, "Alice", "alice-discord-123", now, now],
		);

		ctx.db.run("UPDATE users SET deleted = 1 WHERE id = ?", [userId]);

		const result = isAllowlisted("alice-discord-123", ctx.db);

		expect(result).toBe(false);
	});
});
