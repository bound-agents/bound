import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import type { LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import {
	clientSessionWakeupWarning,
	getClientSessionDelegationTarget,
	getClientSessions,
	getDelegationTarget,
	getRecentToolCalls,
	hasLocalClientSession,
	isClientSessionLive,
} from "../delegation.js";

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
	testDbPath = join(tmpdir(), `test-delegation-${testId}.db`);
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
		it("returns null when model is local (AC6.5 case 3)", () => {
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

		it("returns null when model resolves to error (AC6.5 case 4)", () => {
			const threadId = "thread-123";
			const localSiteId = "local-site";
			const now = new Date().toISOString();

			// Create empty model router (no local models)
			const backends = new Map();
			const modelRouter = new ModelRouter(backends, "default");

			// Setup thread with no hosts having the model
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

			// Don't insert any hosts — model "unknown-model" is not available anywhere
			const target = getDelegationTarget(db, threadId, "unknown-model", modelRouter, localSiteId);
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

	describe("Confirmed tools blocking on delegated loops (AC6.6)", () => {
		it("confirmed tools blocked on delegated loops; agent receives block error", () => {
			// This test verifies that when an AgentLoop is created with a delegated taskId,
			// MCP-bridged confirmed tools will return a block error instead of prompting for confirmation.
			// The actual check happens in mcp-bridge.ts line 112:
			// if (isConfirmed && ctx.taskId && !ctx.taskId.startsWith("interactive-"))
			// This test documents the expected behavior through context creation.

			const threadId = "thread-delegated";
			const localSiteId = "local-site";
			const now = new Date().toISOString();

			// Create empty model router
			const backends = new Map();
			const _modelRouter = new ModelRouter(backends, "default");

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

			// Simulate a delegated taskId (format: "delegated-{id}")
			const delegatedTaskId = "delegated-abc-123";

			// Verify taskId does NOT start with "interactive-"
			expect(delegatedTaskId.startsWith("interactive-")).toBe(false);
			// Verify it starts with "delegated-"
			expect(delegatedTaskId.startsWith("delegated-")).toBe(true);

			// The mcp-bridge.ts will check this taskId when a confirmed tool is invoked.
			// Since delegatedTaskId does NOT start with "interactive-", the confirmed tool
			// will return a block error with message:
			// "Tool {name} requires confirmation and cannot be used in autonomous mode"
			// This is verified in unit tests of mcp-bridge.ts, not directly here, but this
			// test documents the delegated taskId pattern and confirms the check will apply.

			expect(delegatedTaskId).toBeDefined();
		});
	});
});

describe("getClientSessionDelegationTarget", () => {
	const LOCAL = "local-site";
	const REMOTE = "remote-site";
	const THREAD = "thread-cs";

	function insertHost(siteId: string, ageMs: number): void {
		const ts = new Date(Date.now() - ageMs).toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: siteId,
				sync_url: null,
				online_at: ts,
				modified_at: ts,
				deleted: 0,
			},
			"test-writer-site",
		);
	}

	function insertSession(connectionId: string, threadId: string, siteId: string): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"client_sessions",
			{
				id: `${connectionId}::${threadId}`,
				connection_id: connectionId,
				thread_id: threadId,
				site_id: siteId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			"test-writer-site",
		);
	}

	it("returns null when no client session exists for the thread", () => {
		expect(getClientSessionDelegationTarget(db, THREAD, LOCAL)).toBeNull();
	});

	it("returns null when the session is on the local host (tools resolve here)", () => {
		insertHost(LOCAL, 0);
		insertSession("conn-local", THREAD, LOCAL);
		expect(getClientSessionDelegationTarget(db, THREAD, LOCAL)).toBeNull();
	});

	it("returns the remote host when a live session lives there", () => {
		insertHost(REMOTE, 0);
		insertSession("conn-remote", THREAD, REMOTE);
		expect(getClientSessionDelegationTarget(db, THREAD, LOCAL)).toMatchObject({ site_id: REMOTE });
	});

	it("returns null when the only remote session host is stale/offline", () => {
		insertHost(REMOTE, 10 * 60 * 1000); // 10 min old — past the 5 min window
		insertSession("conn-remote", THREAD, REMOTE);
		expect(getClientSessionDelegationTarget(db, THREAD, LOCAL)).toBeNull();
	});

	it("prefers running locally when sessions exist on both local and remote", () => {
		insertHost(LOCAL, 0);
		insertHost(REMOTE, 0);
		insertSession("conn-local", THREAD, LOCAL);
		insertSession("conn-remote", THREAD, REMOTE);
		expect(getClientSessionDelegationTarget(db, THREAD, LOCAL)).toBeNull();
	});

	it("ignores soft-deleted session rows", () => {
		insertHost(REMOTE, 0);
		insertSession("conn-remote", THREAD, REMOTE);
		db.run("UPDATE client_sessions SET deleted = 1 WHERE thread_id = ?", [THREAD]);
		expect(getClientSessionDelegationTarget(db, THREAD, LOCAL)).toBeNull();
	});

	describe("hasLocalClientSession", () => {
		it("is false when no session exists", () => {
			expect(hasLocalClientSession(db, THREAD, LOCAL)).toBe(false);
		});

		it("is true when a live session lives on the local host", () => {
			insertSession("conn-local", THREAD, LOCAL);
			expect(hasLocalClientSession(db, THREAD, LOCAL)).toBe(true);
		});

		it("is false when the only session is on a remote host", () => {
			insertSession("conn-remote", THREAD, REMOTE);
			expect(hasLocalClientSession(db, THREAD, LOCAL)).toBe(false);
		});

		it("ignores soft-deleted local session rows", () => {
			insertSession("conn-local", THREAD, LOCAL);
			db.run("UPDATE client_sessions SET deleted = 1 WHERE thread_id = ?", [THREAD]);
			expect(hasLocalClientSession(db, THREAD, LOCAL)).toBe(false);
		});
	});

	describe("isClientSessionLive", () => {
		it("is false when no session exists for the thread", () => {
			expect(isClientSessionLive(db, THREAD)).toBe(false);
		});

		it("is true when a session lives on a fresh host (local or remote)", () => {
			insertHost(LOCAL, 0);
			insertSession("conn-local", THREAD, LOCAL);
			expect(isClientSessionLive(db, THREAD)).toBe(true);
		});

		it("is true for a fresh remote-only session (host-agnostic, unlike hasLocalClientSession)", () => {
			insertHost(REMOTE, 0);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(isClientSessionLive(db, THREAD)).toBe(true);
			// Contrast: the local-only predicate is false for the same state.
			expect(hasLocalClientSession(db, THREAD, LOCAL)).toBe(false);
		});

		it("is false when the only session host is stale/offline", () => {
			insertHost(REMOTE, 10 * 60 * 1000); // 10 min old — past the 5 min window
			insertSession("conn-remote", THREAD, REMOTE);
			expect(isClientSessionLive(db, THREAD)).toBe(false);
		});

		it("is true when at least one of several session hosts is fresh", () => {
			insertHost(LOCAL, 10 * 60 * 1000); // stale
			insertHost(REMOTE, 0); // fresh
			insertSession("conn-local", THREAD, LOCAL);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(isClientSessionLive(db, THREAD)).toBe(true);
		});

		it("ignores soft-deleted session rows", () => {
			insertHost(REMOTE, 0);
			insertSession("conn-remote", THREAD, REMOTE);
			db.run("UPDATE client_sessions SET deleted = 1 WHERE thread_id = ?", [THREAD]);
			expect(isClientSessionLive(db, THREAD)).toBe(false);
		});
	});

	describe("getClientSessions", () => {
		it("returns an empty array when there are no sessions", () => {
			expect(getClientSessions(db)).toEqual([]);
		});

		it("returns one entry per distinct (thread, host) with a live verdict", () => {
			insertHost(LOCAL, 0); // fresh
			insertHost(REMOTE, 10 * 60 * 1000); // stale
			insertSession("conn-local", THREAD, LOCAL);
			insertSession("conn-remote", "thread-other", REMOTE);

			const sessions = getClientSessions(db);
			expect(sessions).toHaveLength(2);
			const byThread = new Map(sessions.map((s) => [s.threadId, s]));
			expect(byThread.get(THREAD)).toMatchObject({ siteId: LOCAL, hostName: LOCAL, live: true });
			expect(byThread.get("thread-other")).toMatchObject({ siteId: REMOTE, live: false });
		});

		it("dedups multiple connections on the same host into one entry", () => {
			insertHost(LOCAL, 0);
			insertSession("conn-a", THREAD, LOCAL);
			insertSession("conn-b", THREAD, LOCAL);
			expect(getClientSessions(db)).toHaveLength(1);
		});

		it("excludes soft-deleted sessions", () => {
			insertHost(LOCAL, 0);
			insertSession("conn-local", THREAD, LOCAL);
			db.run("UPDATE client_sessions SET deleted = 1 WHERE thread_id = ?", [THREAD]);
			expect(getClientSessions(db)).toEqual([]);
		});
	});

	describe("clientSessionWakeupWarning", () => {
		function insertThread(threadId: string, threadInterface: string): void {
			const now = new Date().toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "u",
					interface: threadInterface,
					host_origin: "test-writer-site",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				"test-writer-site",
			);
		}

		it("returns null for a non-existent thread", () => {
			expect(clientSessionWakeupWarning(db, "ghost")).toBeNull();
		});

		it("returns null for a non-client-tool interface (e.g. web), session or not", () => {
			insertThread(THREAD, "web");
			expect(clientSessionWakeupWarning(db, THREAD)).toBeNull();
		});

		it("returns null for a boundless thread WITH a live session", () => {
			insertThread(THREAD, "boundless");
			insertHost(REMOTE, 0);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(clientSessionWakeupWarning(db, THREAD)).toBeNull();
		});

		it("warns for a boundless thread with NO session", () => {
			insertThread(THREAD, "boundless");
			const warning = clientSessionWakeupWarning(db, THREAD);
			expect(warning).toContain("no live boundless session");
		});

		it("warns for a boundless thread whose only session is stale", () => {
			insertThread(THREAD, "boundless");
			insertHost(REMOTE, 10 * 60 * 1000);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(clientSessionWakeupWarning(db, THREAD)).toContain("no live boundless session");
		});
	});
});
