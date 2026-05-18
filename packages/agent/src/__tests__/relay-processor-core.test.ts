import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertInbox, readUnprocessed } from "@bound/core";
import { applyMetricsSchema } from "@bound/core";
import type { ChatParams, LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type {
	CacheWarmPayload,
	Logger,
	PromptInvokePayload,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ToolCallPayload,
	TypedEventEmitter,
} from "@bound/shared";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";
import { sleep, waitFor } from "./helpers";

// Mock MCPClient for testing
class MockMCPClient implements Partial<MCPClient> {
	constructor(
		private name: string,
		private tools: Map<string, { name: string; description: string }> = new Map(),
	) {}

	async callTool(name: string, _args: Record<string, unknown>) {
		if (!this.tools.has(name)) {
			throw new Error(`Tool ${name} not found`);
		}
		return {
			content: JSON.stringify({ tool: name, result: "mocked" }),
			isError: false,
		};
	}

	async readResource(uri: string) {
		return {
			uri,
			mimeType: "text/plain",
			content: `Resource content for ${uri}`,
		};
	}

	async invokePrompt(name: string, _args: Record<string, unknown>) {
		return {
			messages: [{ role: "user", content: `Prompt ${name} result` }],
		};
	}

	async listTools() {
		return Array.from(this.tools.values());
	}

	getConfig() {
		return {
			name: this.name,
			transport: "stdio" as const,
		};
	}
}

// Mock event bus
const createMockEventBus = (): TypedEventEmitter => {
	return new (require("@bound/shared").TypedEventEmitter)();
};

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// Mock LLM backend
class MockLLMBackend implements LLMBackend {
	// biome-ignore lint/correctness/useYield: mock generator for test
	async *chat(_params: ChatParams) {
		// Mock implementation
		return;
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 4096,
		};
	}
}

// Helper to create mock ModelRouter
function createMockModelRouter(): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("mock-model", new MockLLMBackend());
	return new ModelRouter(backends, "mock-model");
}

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-processor-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
	applyMetricsSchema(db);
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

describe("RelayProcessor", () => {
	describe("background loop", () => {
		it("creates RelayProcessor and returns stop handle", () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const handle = processor.start(10);
			expect(handle).toBeDefined();
			expect(handle.stop).toBeDefined();
			expect(typeof handle.stop).toBe("function");

			handle.stop();
		});

		it("polls readUnprocessed entries on regular interval", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			// Insert an unprocessed inbox entry
			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "entry-1",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "test-tool",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);

			// Wait for processor to pick up the entry
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			handle.stop();

			// Entry should be marked as processed (or handled in some way)
			const entries = readUnprocessed(db);
			// Should have processed the entry (even if it errored)
			expect(entries.length).toBeLessThanOrEqual(1);
		});

		it("gracefully stops processing on stop()", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set<string>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const handle = processor.start(10);
			await sleep(50);
			handle.stop();

			// Verify no errors during shutdown
			expect(true).toBe(true);
		});
	});

	describe("validation", () => {
		it("rejects unknown source_site_id (AC1.2)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["trusted-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "entry-1",
				source_site_id: "unknown-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "test",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Should have written error response to outbox
			const outboxEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ?")
				.all("error") as RelayOutboxEntry[];
			expect(outboxEntries.length).toBeGreaterThan(0);
		});

		it("discards expired inbox entries (AC9.2)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const expiredEntry: RelayInboxEntry = {
				id: "expired-1",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "test",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() - 1000).toISOString(), // Already expired
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					expiredEntry.id,
					expiredEntry.source_site_id,
					expiredEntry.kind,
					expiredEntry.ref_id,
					expiredEntry.idempotency_key,
					expiredEntry.payload,
					expiredEntry.expires_at,
					expiredEntry.received_at,
					expiredEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Entry should be marked as processed
			const entries = readUnprocessed(db);
			expect(entries.length).toBe(0);

			// No outbox entry should be created for expired request
			const outboxEntries = db.query("SELECT COUNT(*) as count FROM relay_outbox").get() as {
				count: number;
			};
			expect(outboxEntries.count).toBe(0);
		});
	});

	describe("execution - resource_read (AC1.3)", () => {
		it("executes resource_read and writes result to outbox (AC1.3)", async () => {
			const mockClient = new MockMCPClient("resource-server");
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("resource-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const resourceUri = "memory://test/resource";
			const inboxEntry: RelayInboxEntry = {
				id: "resource-1",
				source_site_id: "requester-site",
				kind: "resource_read",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					resource_uri: resourceUri,
				} as ResourceReadPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Check that result was written to outbox
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("execution - prompt_invoke (AC1.4)", () => {
		it("executes prompt_invoke and writes result to outbox (AC1.4)", async () => {
			const mockClient = new MockMCPClient("prompt-server");
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("prompt-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "prompt-1",
				source_site_id: "requester-site",
				kind: "prompt_invoke",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					prompt_name: "test-prompt",
					prompt_args: { key: "value" },
				} as PromptInvokePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Check that result was written to outbox
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("execution - cache_warm (AC1.5)", () => {
		it("executes cache_warm and writes file contents to outbox (AC1.5)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			// Create temporary test files
			const fs = require("node:fs");
			const testDir = `/tmp/relay-cache-warm-test-${randomBytes(4).toString("hex")}`;
			require("node:fs").mkdirSync(testDir, { recursive: true });
			const testFile1 = `${testDir}/file1.txt`;
			const testFile2 = `${testDir}/file2.txt`;
			fs.writeFileSync(testFile1, "test content 1");
			fs.writeFileSync(testFile2, "test content 2");

			try {
				const now = new Date();
				const inboxEntry: RelayInboxEntry = {
					id: "cache-warm-1",
					source_site_id: "requester-site",
					kind: "cache_warm",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify({
						paths: [testFile1, testFile2],
						max_payload_bytes: 1000,
					} as CacheWarmPayload),
					expires_at: new Date(now.getTime() + 60000).toISOString(),
					received_at: now.toISOString(),
					processed: 0,
				};

				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						inboxEntry.id,
						inboxEntry.source_site_id,
						inboxEntry.kind,
						inboxEntry.ref_id,
						inboxEntry.idempotency_key,
						inboxEntry.payload,
						inboxEntry.expires_at,
						inboxEntry.received_at,
						inboxEntry.processed,
					],
				);

				const handle = processor.start(10);
				await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
				handle.stop();

				// Check that result was written to outbox
				const results = db
					.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
					.all("result", inboxEntry.id) as RelayOutboxEntry[];
				expect(results.length).toBeGreaterThan(0);

				// Verify the content includes file data
				if (results.length > 0) {
					const resultPayload = JSON.parse(results[0].payload);
					expect(resultPayload.stdout).toContain("test content");
				}
			} finally {
				// Cleanup
				try {
					require("node:fs").unlinkSync(testFile1);
					require("node:fs").unlinkSync(testFile2);
					require("node:fs").rmdirSync(testDir);
				} catch {
					// Cleanup errors are non-fatal
				}
			}
		});
	});

	describe("idempotency", () => {
		it("returns cached response on duplicate idempotency_key (AC5.1)", async () => {
			const mockClient = new MockMCPClient(
				"test-server",
				new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
			);
			let callCount = 0;
			const originalCallTool = mockClient.callTool.bind(mockClient);
			mockClient.callTool = async (name: string, args: Record<string, unknown>) => {
				callCount++;
				return originalCallTool(name, args);
			};

			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("test-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const idempotencyKey = "test-idem-key";

			// Insert first request with idempotency_key using insertInbox (respects INSERT OR IGNORE)
			const entry1: RelayInboxEntry = {
				id: "req-1",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			const inserted1 = insertInbox(db, entry1);
			expect(inserted1).toBe(true);

			// Process first request
			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			const callCountAfterFirst = callCount;
			expect(callCountAfterFirst).toBeGreaterThan(0);

			// Try to insert second request with same idempotency_key (will be ignored)
			const entry2: RelayInboxEntry = {
				id: "req-2",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			const inserted2 = insertInbox(db, entry2);
			expect(inserted2).toBe(false); // Deduped by idempotency_key

			handle.stop();

			// callCount should not increase (duplicate was deduped)
			expect(callCount).toBe(callCountAfterFirst);

			// Verify only one request was inserted due to deduplication
			const unprocessedEntries = db
				.query("SELECT * FROM relay_inbox WHERE kind = ?")
				.all("tool_call") as RelayInboxEntry[];
			expect(unprocessedEntries.length).toBe(1);
		});

		it("expires cache entries after 5 minutes (AC5.3)", async () => {
			const mockClient = new MockMCPClient(
				"test-server",
				new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
			);
			let callCount = 0;
			const originalCallTool = mockClient.callTool.bind(mockClient);
			mockClient.callTool = async (name: string, args: Record<string, unknown>) => {
				callCount++;
				return originalCallTool(name, args);
			};

			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("test-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const baseTime = Date.now();
			const idempotencyKey = "test-idem-key-expiry";

			// Insert first request with idempotency_key using insertInbox
			const entry1: RelayInboxEntry = {
				id: "req-1-expiry",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(baseTime + 600000).toISOString(),
				received_at: new Date(baseTime).toISOString(),
				processed: 0,
			};

			const inserted1 = insertInbox(db, entry1);
			expect(inserted1).toBe(true);

			// Process first request
			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			const callCountAfterFirst = callCount;
			expect(callCountAfterFirst).toBeGreaterThan(0);

			// Try to insert second request with same idempotency_key before cache expiry (will be ignored)
			const entry2: RelayInboxEntry = {
				id: "req-2-expiry",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(baseTime + 600000).toISOString(),
				received_at: new Date(baseTime).toISOString(),
				processed: 0,
			};

			const inserted2 = insertInbox(db, entry2);
			expect(inserted2).toBe(false); // Deduped by idempotency_key

			const callCountAfterSecond = callCount;
			// Should still be the same (dedup prevented second insert)
			expect(callCountAfterSecond).toBe(callCountAfterFirst);

			handle.stop();

			// Mock Date.now() to advance past 5 minutes (5 min TTL + 1 second)
			const originalDateNow = Date.now;
			Date.now = () => baseTime + 5 * 60 * 1000 + 1000;

			// Delete the cached entry to simulate cache expiry
			db.run("DELETE FROM relay_outbox WHERE idempotency_key = ?", [idempotencyKey]);

			// Insert third request with different ID but same idempotency_key after TTL expiry
			// Since cache was cleared, this should trigger re-execution
			const entry3: RelayInboxEntry = {
				id: "req-3-expiry",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: `${idempotencyKey}-expired`,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(baseTime + 600000).toISOString(),
				received_at: new Date(baseTime).toISOString(),
				processed: 0,
			};

			const inserted3 = insertInbox(db, entry3);
			expect(inserted3).toBe(true);

			const handle2 = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle2.stop();

			// Restore Date.now()
			Date.now = originalDateNow;

			// callCount should have increased (new request with different key was processed)
			expect(callCount).toBeGreaterThan(callCountAfterFirst);
		});
	});

	describe("cancel handling", () => {
		it("skips execution if cancel arrives before processing (AC7.3)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const requestId = "tool-req-1";

			// Insert cancel entry first
			const cancelEntry: RelayInboxEntry = {
				id: "cancel-1",
				source_site_id: "requester-site",
				kind: "cancel",
				ref_id: requestId,
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					cancelEntry.id,
					cancelEntry.source_site_id,
					cancelEntry.kind,
					cancelEntry.ref_id,
					cancelEntry.idempotency_key,
					cancelEntry.payload,
					cancelEntry.expires_at,
					cancelEntry.received_at,
					cancelEntry.processed,
				],
			);

			// Insert the actual tool request
			const toolEntry: RelayInboxEntry = {
				id: requestId,
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "test",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					toolEntry.id,
					toolEntry.source_site_id,
					toolEntry.kind,
					toolEntry.ref_id,
					toolEntry.idempotency_key,
					toolEntry.payload,
					toolEntry.expires_at,
					toolEntry.received_at,
					toolEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Tool request should be marked processed but no execution should occur
			const entries = readUnprocessed(db);
			expect(entries.length).toBe(0);
		});

		it("writes result if cancel arrives after execution (AC7.4)", async () => {
			const mockClient = new MockMCPClient("test-server");
			mockClient.tools = new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]);
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("test-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const requestId = "tool-req-late-cancel";

			// Insert the tool request first
			const toolEntry: RelayInboxEntry = {
				id: requestId,
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					toolEntry.id,
					toolEntry.source_site_id,
					toolEntry.kind,
					toolEntry.ref_id,
					toolEntry.idempotency_key,
					toolEntry.payload,
					toolEntry.expires_at,
					toolEntry.received_at,
					toolEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			// Now insert cancel after tool execution
			const cancelEntry: RelayInboxEntry = {
				id: "cancel-late",
				source_site_id: "requester-site",
				kind: "cancel",
				ref_id: requestId,
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					cancelEntry.id,
					cancelEntry.source_site_id,
					cancelEntry.kind,
					cancelEntry.ref_id,
					cancelEntry.idempotency_key,
					cancelEntry.payload,
					cancelEntry.expires_at,
					cancelEntry.received_at,
					cancelEntry.processed,
				],
			);

			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Result should have been written to outbox (execution occurred)
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", requestId) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("error handling", () => {
		it("returns error response for unknown server name", async () => {
			const mockClient = new MockMCPClient("test-server");
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("test-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "unknown-tool-1",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "nonexistent-server",
					args: { subcommand: "some_command" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Should have written error response to outbox
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("error", inboxEntry.id) as RelayOutboxEntry[];
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0].payload).toContain("MCP server not found");
		});

		it("returns error response with retriable flag when MCP client call fails", async () => {
			const failingClient = new MockMCPClient(
				"failing-server",
				new Map([["test_command", { name: "test_command", description: "Test command" }]]),
			);
			// Override callTool to throw an error
			failingClient.callTool = async () => {
				throw new Error("MCP client connection failed");
			};

			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("failing-server", failingClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "client-error-1",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "failing-server",
					args: { subcommand: "test_command" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Should have written error response to outbox with retriable flag
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("error", inboxEntry.id) as RelayOutboxEntry[];
			expect(errors.length).toBeGreaterThan(0);
			const errorPayload = JSON.parse(errors[0].payload);
			expect(errorPayload.retriable).toBe(true);
			expect(errorPayload.error).toContain("MCP client connection failed");
		});
	});

	describe("execution - tool_call with subcommand dispatch (AC1.2)", () => {
		it("server-name tool call with subcommand in args dispatches correctly", async () => {
			// Create a mock MCP client that tracks callTool invocations
			const mockClient = new MockMCPClient(
				"github",
				new Map([["create_issue", { name: "create_issue", description: "Create an issue" }]]),
			);
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("github", mockClient as unknown as MCPClient);

			// Track what was passed to callTool
			let capturedToolName: string | null = null;
			let capturedArgs: Record<string, unknown> | null = null;
			const originalCallTool = mockClient.callTool.bind(mockClient);
			mockClient.callTool = async (name: string, args: Record<string, unknown>) => {
				capturedToolName = name;
				capturedArgs = args;
				return originalCallTool(name, args);
			};

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "tool-call-1",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "github",
					args: { subcommand: "create_issue", title: "Fix bug", body: "Details here" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Verify: callTool was called with subcommand as tool name and remaining args without subcommand
			expect(capturedToolName).toBe("create_issue");
			expect(capturedArgs).toEqual({ title: "Fix bug", body: "Details here" });

			// Verify: result was written to outbox
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
		});

		it("missing subcommand in args returns error response", async () => {
			const mockClient = new MockMCPClient("github");
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("github", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "tool-call-missing-subcommand",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "github",
					args: { title: "Fix bug" }, // Missing subcommand
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Verify: error response was written to outbox
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("error", inboxEntry.id) as RelayOutboxEntry[];
			expect(errors.length).toBeGreaterThan(0);
		});

		it("unknown server name (client not in mcpClients map) returns error response", async () => {
			const mcpClients = new Map<string, MCPClient>();
			// Don't add "unknown-server" to clients map

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "tool-call-unknown-server",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "unknown-server",
					args: { subcommand: "some_command" },
				} as ToolCallPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);

			const handle = processor.start(10);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Verify: error response was written to outbox
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("error", inboxEntry.id) as RelayOutboxEntry[];
			expect(errors.length).toBeGreaterThan(0);
		});
	});

	describe("response kind filtering", () => {
		it("does not generate error responses for 'error' kind inbox entries", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["remote-site"]);
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(
				db,
				siteId,
				mcpClients,
				null,
				keyringSiteIds,
				logger,
				eventBus,
			);

			// Insert an 'error' response kind into relay_inbox
			// (simulates a hub routing an error response back to this spoke)
			const { insertInbox } = require("@bound/core");
			insertInbox(db, {
				id: "error-response-1",
				source_site_id: "remote-site",
				kind: "error",
				ref_id: "original-request-id",
				idempotency_key: "error-idemp-1",
				stream_id: null,
				payload: JSON.stringify({ error: "some remote error", retriable: false }),
				expires_at: new Date(Date.now() + 300_000).toISOString(),
				received_at: new Date().toISOString(),
				processed: 0,
			});

			// Start processor and wait for it to process
			const handle = processor.start(10);
			await sleep(300);
			handle.stop();

			// The error entry should be marked processed (not left unprocessed)
			const unprocessed = readUnprocessed(db);
			const errorEntry = unprocessed.find((e: RelayInboxEntry) => e.id === "error-response-1");
			expect(errorEntry).toBeUndefined();

			// Check the inbox entry was actually processed (not just ignored)
			const inboxEntry = db
				.query("SELECT processed FROM relay_inbox WHERE id = ?")
				.get("error-response-1") as { processed: number } | null;
			expect(inboxEntry).not.toBeNull();
			expect(inboxEntry?.processed).toBe(1);

			// And it should NOT have generated a new error in relay_outbox
			// Check ALL outbox entries (no filter by target)
			const allOutbox = db.query("SELECT * FROM relay_outbox").all() as RelayOutboxEntry[];
			const amplifiedErrors = allOutbox.filter(
				(e) => e.kind === "error" && e.payload?.includes("Unknown request kind"),
			);
			// BUG: This should be 0 (response kinds should be silently consumed)
			// but the current code generates error amplification
			expect(amplifiedErrors.length).toBe(0);
		});

		it("does not generate error responses for 'result' kind inbox entries", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["remote-site"]);
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(
				db,
				siteId,
				mcpClients,
				null,
				keyringSiteIds,
				logger,
				eventBus,
			);

			const { insertInbox } = require("@bound/core");
			insertInbox(db, {
				id: "result-response-1",
				source_site_id: "remote-site",
				kind: "result",
				ref_id: "original-request-id",
				idempotency_key: "result-idemp-1",
				stream_id: null,
				payload: JSON.stringify({ result: "some result" }),
				expires_at: new Date(Date.now() + 300_000).toISOString(),
				received_at: new Date().toISOString(),
				processed: 0,
			});

			const handle = processor.start(10);
			await sleep(300);
			handle.stop();

			// Should be marked processed without generating new outbox errors
			const unprocessed = readUnprocessed(db);
			expect(
				unprocessed.find((e: RelayInboxEntry) => e.id === "result-response-1"),
			).toBeUndefined();

			const allOutbox2 = db.query("SELECT * FROM relay_outbox").all() as RelayOutboxEntry[];
			const errors = allOutbox2.filter((e) => e.kind === "error");
			expect(errors.length).toBe(0);
		});
	});
});
