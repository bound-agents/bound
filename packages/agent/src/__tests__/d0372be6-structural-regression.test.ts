import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import { randomUUID } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { buildVolatileContext } from "../context-assembly";

function createTempDb(dbPath: string): Database {
	const db = new Database(dbPath);
	applySchema(db);
	return db;
}

describe("d0372be6 confabulation pattern — structural surface", () => {
	let dbPath: string;
	let configDir: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		configDir = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}`);
	});

	afterEach(async () => {
		await cleanupTmpDir(configDir);
		try {
			unlinkSync(dbPath);
		} catch {}
	});

	test("Live State footer names tool_results as the canonical source for current-thread payloads", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "webhook-handler-thread";
		const siteId = "test-site";

		// Register a webhook event-handler thread with one tool_result containing envelope JSON
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Webhook Event Handler",
				summary: null,
				deleted: 0,
			},
			siteId,
		);

		// Insert a message with a tool_result containing envelope JSON
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "assistant",
				content: JSON.stringify([
					{
						type: "tool_result",
						tool_use_id: "test-tool-call",
						content: JSON.stringify({ event: "test", payload: {} }),
					},
				]),
				created_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		expect(result.content).toContain(
			"Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary",
		);

		db.close();
	});

	test("cross-thread digest emits no Summary: line for any sibling thread", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "main-thread";
		const siteId = "test-site";

		// Register main thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Main Thread",
				summary: null,
				deleted: 0,
			},
			siteId,
		);

		// Insert two sibling threads with non-empty summary fields
		const siblingId1 = randomUUID();
		insertRow(
			db,
			"threads",
			{
				id: siblingId1,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Sibling Thread 1",
				summary: "This is a sibling thread summary with important details",
				deleted: 0,
			},
			siteId,
		);

		const siblingId2 = randomUUID();
		insertRow(
			db,
			"threads",
			{
				id: siblingId2,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Sibling Thread 2",
				summary: "Another sibling thread with its own summary",
				deleted: 0,
			},
			siteId,
		);

		// Insert messages into sibling threads to make them appear in cross-thread digest
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: siblingId1,
				role: "user",
				content: "Some content",
				created_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: siblingId2,
				role: "user",
				content: "More content",
				created_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// Per §8.3 step 4: no Summary: line for ANY sibling thread
		// Use multiline regex to catch indented Summary: lines too
		expect(result.content).not.toMatch(/^\s*Summary:/m);

		db.close();
	});

	test("output contains no 'Do not mention' meta-instruction", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "test-thread";
		const siteId = "test-site";

		// Register thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Test Thread",
				summary: null,
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		expect(result.content).not.toContain("Do not mention");

		db.close();
	});

	test("output contains no 'Recent Activity Digest:' header (legacy section header is gone)", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "test-thread";
		const siteId = "test-site";

		// Register thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Test Thread",
				summary: null,
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		expect(result.content).not.toContain("Recent Activity Digest:");

		db.close();
	});

	test("Live State header text is exact", () => {
		const db = createTempDb(dbPath);
		const userId = "test-user";
		const threadId = "test-thread";
		const siteId = "test-site";

		// Register thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				title: "Test Thread",
				summary: null,
				deleted: 0,
			},
			siteId,
		);

		const result = buildVolatileContext({
			db,
			threadId,
			userId,
			siteId,
		});

		// The em-dash is U+2014
		expect(result.content).toContain("## Live State — pointers to canonical sources");

		db.close();
	});
});
