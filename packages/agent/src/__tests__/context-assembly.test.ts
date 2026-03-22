import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { assembleContext } from "../context-assembly";

describe("Context Assembly Pipeline", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "context-test-"));
		dbPath = join(tmpDir, "test.db");

		// Create database and apply schema
		db = createDatabase(dbPath);
		applySchema(db);

		// Create a test user and thread
		userId = randomUUID();
		threadId = randomUUID();

		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should return an array of LLMMessages", async () => {
		const messages = assembleContext({
			db,
			threadId,
			userId,
		});

		expect(Array.isArray(messages)).toBe(true);
	});

	it("should assemble context with message history", async () => {
		// Insert a user message
		const msgId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				msgId,
				threadId,
				"user",
				"Hello",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
			],
		);

		const messages = assembleContext({
			db,
			threadId,
			userId,
		});

		expect(Array.isArray(messages)).toBe(true);
	});

	it("should support no_history mode", async () => {
		const messages = assembleContext({
			db,
			threadId,
			userId,
			noHistory: true,
		});

		expect(Array.isArray(messages)).toBe(true);
	});
});
