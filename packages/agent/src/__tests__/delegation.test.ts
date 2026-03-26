import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { getDelegationTarget, getRecentToolCalls } from "../delegation.js";

// Test database setup
let db: Database;
let testDbPath: string;

const createMockBackend = (id: string): LLMBackend => ({
	id,
	chat: async function* () {
		yield { type: "text", text: "test" } as const;
	},
	capabilities: () => ({
		streaming: true,
		tools: true,
		vision: false,
		maxContextWindow: 200000,
	}),
});

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-delegation-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
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

describe("Delegation", () => {
	describe("getRecentToolCalls", () => {
		it("returns empty array when thread has no tool calls", () => {
			const threadId = "thread-123";
			const now = new Date().toISOString();

			// Insert thread and user message
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				"local-site",
			);

			insertRow(
				db,
				"messages",
				{
					id: "msg-1",
					thread_id: threadId,
					role: "user",
					content: "Hello",
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: null,
					host_origin: "localhost",
					deleted: 0,
				},
				"local-site",
			);

			const toolCalls = getRecentToolCalls(db, threadId);
			expect(toolCalls).toEqual([]);
		});

		it("returns tool call counts grouped and ordered by recency", () => {
			const threadId = "thread-123";
			const now = new Date().toISOString();
			const earlier = new Date(Date.now() - 10 * 60 * 1000).toISOString();

			// Insert thread
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: earlier,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				"local-site",
			);

			// Insert tool call messages
			for (let i = 0; i < 3; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-tool-1-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolA",
						created_at: earlier,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					"local-site",
				);
			}

			for (let i = 0; i < 2; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-tool-2-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolB",
						created_at: now,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					"local-site",
				);
			}

			const toolCalls = getRecentToolCalls(db, threadId);

			expect(toolCalls.length).toBe(2);
			// Most recent first
			expect(toolCalls[0]).toEqual({ toolName: "server-toolB", count: 2 });
			expect(toolCalls[1]).toEqual({ toolName: "server-toolA", count: 3 });
		});
	});

	describe("getDelegationTarget", () => {
		it("returns null when model is local (AC6.5)", () => {
			const threadId = "thread-123";
			const localSiteId = "local-site";
			const now = new Date().toISOString();

			// Create local backend
			const mockBackend = createMockBackend("claude-opus");
			const backends = new Map([["claude-opus", mockBackend]]);
			const modelRouter = new ModelRouter(backends, "claude-opus");

			// Setup thread (no tool calls)
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				localSiteId,
			);

			const target = getDelegationTarget(db, threadId, "claude-opus", modelRouter, localSiteId);
			expect(target).toBeNull();
		});

		it("returns null when multiple hosts have remote model (AC6.5)", () => {
			const threadId = "thread-123";
			const localSiteId = "local-site";
			const now = new Date().toISOString();

			// Create empty model router (no local models)
			const backends = new Map();
			const modelRouter = new ModelRouter(backends, "default");

			// Setup thread
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				localSiteId,
			);

			// Register two remote hosts with the model
			for (const hostId of ["remote-1", "remote-2"]) {
				db.run(
					`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at, deleted)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						hostId,
						`host-${hostId}`,
						null,
						"http://host:3000",
						null,
						JSON.stringify(["server-toolA"]),
						JSON.stringify(["remote-model"]),
						null,
						now,
						now,
						0,
					],
				);
			}

			const target = getDelegationTarget(db, threadId, "remote-model", modelRouter, localSiteId);
			expect(target).toBeNull(); // Two hosts — condition unmet
		});

		it("returns null when only 30% of tools match remote host (AC6.5)", () => {
			const threadId = "thread-123";
			const localSiteId = "local-site";
			const remoteHost = "remote-1";
			const now = new Date().toISOString();

			// Create empty model router (no local models)
			const backends = new Map();
			const modelRouter = new ModelRouter(backends, "default");

			// Setup thread
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				localSiteId,
			);

			// Register one remote host
			db.run(
				`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					remoteHost,
					"host-remote-1",
					null,
					"http://host:3000",
					null,
					JSON.stringify(["server-toolA"]),
					JSON.stringify(["remote-model"]),
					null,
					now,
					now,
					0,
				],
			);

			// Create thread with 10 tool calls: 3 on target host, 7 elsewhere
			for (let i = 0; i < 3; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-toolA-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolA",
						created_at: now,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					localSiteId,
				);
			}

			for (let i = 0; i < 7; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-toolB-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolB",
						created_at: now,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					localSiteId,
				);
			}

			const target = getDelegationTarget(db, threadId, "remote-model", modelRouter, localSiteId);
			expect(target).toBeNull(); // 30% < 50% threshold
		});

		it("returns target host when 60% of tools match (AC6.1)", () => {
			const threadId = "thread-123";
			const localSiteId = "local-site";
			const remoteHost = "remote-1";
			const now = new Date().toISOString();

			// Create empty model router (no local models)
			const backends = new Map();
			const modelRouter = new ModelRouter(backends, "default");

			// Setup thread
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				localSiteId,
			);

			// Register one remote host
			db.run(
				`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					remoteHost,
					"host-remote-1",
					null,
					"http://host:3000",
					null,
					JSON.stringify(["server-toolA", "server-toolC"]),
					JSON.stringify(["remote-model"]),
					null,
					now,
					now,
					0,
				],
			);

			// Create thread with 10 tool calls: 8 on target host, 2 elsewhere
			for (let i = 0; i < 5; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-toolA-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolA",
						created_at: now,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					localSiteId,
				);
			}

			for (let i = 0; i < 3; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-toolC-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolC",
						created_at: now,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					localSiteId,
				);
			}

			for (let i = 0; i < 2; i++) {
				insertRow(
					db,
					"messages",
					{
						id: `msg-toolB-${i}`,
						thread_id: threadId,
						role: "tool_result",
						content: "result",
						model_id: null,
						tool_name: "server-toolB",
						created_at: now,
						modified_at: null,
						host_origin: "localhost",
						deleted: 0,
					},
					localSiteId,
				);
			}

			const target = getDelegationTarget(db, threadId, "remote-model", modelRouter, localSiteId);
			expect(target).not.toBeNull();
			if (target) {
				expect(target.site_id).toBe(remoteHost);
				expect(target.host_name).toBe("host-remote-1");
			}
		});

		it("returns target host for thread with no tool calls (AC6.7 vacuous match)", () => {
			const threadId = "thread-123";
			const localSiteId = "local-site";
			const remoteHost = "remote-1";
			const now = new Date().toISOString();

			// Create empty model router (no local models)
			const backends = new Map();
			const modelRouter = new ModelRouter(backends, "default");

			// Setup thread
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-123",
					interface: "web",
					host_origin: "localhost",
					color: 0,
					title: null,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				localSiteId,
			);

			// Register one remote host
			db.run(
				`INSERT INTO hosts (site_id, host_name, version, sync_url, mcp_servers, mcp_tools, models, overlay_root, online_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					remoteHost,
					"host-remote-1",
					null,
					"http://host:3000",
					null,
					JSON.stringify(["server-toolA"]),
					JSON.stringify(["remote-model"]),
					null,
					now,
					now,
					0,
				],
			);

			// Thread has no tool calls — add user message only
			insertRow(
				db,
				"messages",
				{
					id: "msg-user-1",
					thread_id: threadId,
					role: "user",
					content: "Hello, no tools called yet",
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: null,
					host_origin: "localhost",
					deleted: 0,
				},
				localSiteId,
			);

			const target = getDelegationTarget(db, threadId, "remote-model", modelRouter, localSiteId);
			expect(target).not.toBeNull(); // Vacuous match — delegate
			if (target) {
				expect(target.site_id).toBe(remoteHost);
			}
		});
	});
});
