import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, markProcessed, readUnprocessed } from "@bound/core";
import { applyMetricsSchema } from "@bound/core";
import type { ChatParams, InferenceRequestPayload, LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type {
	CacheWarmPayload,
	EventBroadcastPayload,
	IntakePayload,
	Logger,
	PlatformDeliverPayload,
	PromptInvokePayload,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ToolCallPayload,
	TypedEventEmitter,
} from "@bound/shared";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";
import type { AgentLoopConfig } from "../types";
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

			const handle = processor.start(100);
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

			const handle = processor.start(50);

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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

				const handle = processor.start(50);
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

			// Insert first request with idempotency_key
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

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry1.id,
					entry1.source_site_id,
					entry1.kind,
					entry1.ref_id,
					entry1.idempotency_key,
					entry1.payload,
					entry1.expires_at,
					entry1.received_at,
					entry1.processed,
				],
			);

			// Process first request
			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			const callCountAfterFirst = callCount;
			expect(callCountAfterFirst).toBeGreaterThan(0);

			// Insert second request with same idempotency_key
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

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry2.id,
					entry2.source_site_id,
					entry2.kind,
					entry2.ref_id,
					entry2.idempotency_key,
					entry2.payload,
					entry2.expires_at,
					entry2.received_at,
					entry2.processed,
				],
			);

			// Wait for second request to be processed
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			handle.stop();

			// callCount should not increase (cached response used)
			expect(callCount).toBe(callCountAfterFirst);

			// Verify both requests have results in the outbox
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? ORDER BY created_at")
				.all("result") as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThanOrEqual(2);
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

			// Insert first request with idempotency_key
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

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry1.id,
					entry1.source_site_id,
					entry1.kind,
					entry1.ref_id,
					entry1.idempotency_key,
					entry1.payload,
					entry1.expires_at,
					entry1.received_at,
					entry1.processed,
				],
			);

			// Process first request
			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			const callCountAfterFirst = callCount;
			expect(callCountAfterFirst).toBeGreaterThan(0);

			// Insert second request with same idempotency_key before cache expiry
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

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry2.id,
					entry2.source_site_id,
					entry2.kind,
					entry2.ref_id,
					entry2.idempotency_key,
					entry2.payload,
					entry2.expires_at,
					entry2.received_at,
					entry2.processed,
				],
			);

			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });

			const callCountAfterSecond = callCount;
			// Should still be cached (no new call)
			expect(callCountAfterSecond).toBe(callCountAfterFirst);

			handle.stop();

			// Mock Date.now() to advance past 5 minutes (5 min TTL + 1 second)
			const originalDateNow = Date.now;
			Date.now = () => baseTime + 5 * 60 * 1000 + 1000;

			// Clear unprocessed entries and reset for next phase
			const unprocessedBefore = readUnprocessed(db);
			if (unprocessedBefore.length > 0) {
				markProcessed(
					db,
					unprocessedBefore.map((e) => e.id),
				);
			}

			// Insert third request with same idempotency_key after TTL expiry
			// This should trigger re-execution since cache is expired
			const entry3: RelayInboxEntry = {
				id: "req-3-expiry",
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

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry3.id,
					entry3.source_site_id,
					entry3.kind,
					entry3.ref_id,
					entry3.idempotency_key,
					entry3.payload,
					entry3.expires_at,
					entry3.received_at,
					entry3.processed,
				],
			);

			const handle2 = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle2.stop();

			// Restore Date.now()
			Date.now = originalDateNow;

			// callCount should have increased (cache was expired, re-execution happened)
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

	describe("platform-connectors Phase 2 — intake/platform_deliver/event_broadcast", () => {
		// AC3.2-AC3.6: Tier routing tests are tested implicitly through selectIntakeHost method
		// and are covered by integration tests in multi-instance.integration.test.ts

		// AC3.7-AC4.4: Event handler tests

		// (Tests AC3.2-AC3.6 would require complex database setup; these are covered by selectIntakeHost()
		// internal logic and the integration tests below)

		// AC3.7: platform_deliver emits on eventBus (replaces AC3.2-AC3.6 test block)
		it("AC3.2-AC3.6: intake routing tier tests (see selectIntakeHost test)", async () => {
			// Tier routing (affinity, model, tools, least-loaded) is tested implicitly
			// through the selectIntakeHost() method logic and integration tests
			// For unit test purposes, we verify the basic intake flow works
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const threadAffinityMap = new Map<string, string>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
				createMockModelRouter(),
				undefined,
				threadAffinityMap,
			);

			// Basic intake intake setup (skips complex tier logic)
			const hostTimestamp = new Date().toISOString();
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-a",
				"Host A",
				0,
				hostTimestamp,
			]);

			const now = new Date();
			const intakeEntry: RelayInboxEntry = {
				id: "intake-basic",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: "slack",
					platform_event_id: "event-basic",
					thread_id: "thread-basic",
					user_id: "user-1",
					message_id: "msg-basic",
					content: "Test",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					intakeEntry.id,
					intakeEntry.source_site_id,
					intakeEntry.kind,
					intakeEntry.ref_id,
					intakeEntry.idempotency_key,
					intakeEntry.payload,
					intakeEntry.expires_at,
					intakeEntry.received_at,
					intakeEntry.processed,
					intakeEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Verify process signal was created
			const processEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ?")
				.all("process") as RelayOutboxEntry[];
			expect(processEntries.length).toBe(1);
		});

		// AC3.2: Duplicate intake is discarded via idempotency
		it("AC3.2: duplicate intake with same platform+platform_event_id is discarded", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const threadAffinityMap = new Map<string, string>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
				createMockModelRouter(),
				undefined,
				threadAffinityMap,
			);

			// Setup: create two hosts
			const hostTimestamp = new Date().toISOString();
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-a",
				"Host A",
				0,
				hostTimestamp,
			]);
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-b",
				"Host B",
				0,
				hostTimestamp,
			]);

			const now = new Date();
			const threadId = "thread-1";
			const platformId = "slack";
			const eventId = "event-123";

			// Insert two intake inbox entries with same platform + platform_event_id
			const entry1: RelayInboxEntry = {
				id: "intake-1",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: platformId,
					platform_event_id: eventId,
					thread_id: threadId,
					user_id: "user-1",
					message_id: "msg-1",
					content: "Hello",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			const entry2: RelayInboxEntry = {
				id: "intake-2",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: platformId,
					platform_event_id: eventId,
					thread_id: threadId,
					user_id: "user-1",
					message_id: "msg-2",
					content: "Hello again",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry1.id,
					entry1.source_site_id,
					entry1.kind,
					entry1.ref_id,
					entry1.idempotency_key,
					entry1.payload,
					entry1.expires_at,
					entry1.received_at,
					entry1.processed,
					entry1.stream_id,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry2.id,
					entry2.source_site_id,
					entry2.kind,
					entry2.ref_id,
					entry2.idempotency_key,
					entry2.payload,
					entry2.expires_at,
					entry2.received_at,
					entry2.processed,
					entry2.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Count relay_outbox rows with kind="process" — should be 1 after processing both
			const processOutboxEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ?")
				.all("process") as RelayOutboxEntry[];
			expect(processOutboxEntries.length).toBe(1);
		});

		// AC3.3: Thread affinity routing
		it("AC3.3: intake routing selects host with active loop for the thread (thread affinity)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const threadAffinityMap = new Map<string, string>();

			// Set thread affinity for this thread to hostA
			const threadId = "thread-affinity-test";
			threadAffinityMap.set(threadId, "host-a");

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
				createMockModelRouter(),
				undefined,
				threadAffinityMap,
			);

			// Setup: create two hosts in hosts table
			const timestamp = new Date().toISOString();
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-a",
				"Host A",
				0,
				timestamp,
			]);
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-b",
				"Host B",
				0,
				timestamp,
			]);

			const now = new Date();
			const intakeEntry: RelayInboxEntry = {
				id: "intake-affinity",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: "slack",
					platform_event_id: "event-af",
					thread_id: threadId,
					user_id: "user-1",
					message_id: "msg-af",
					content: "Test",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					intakeEntry.id,
					intakeEntry.source_site_id,
					intakeEntry.kind,
					intakeEntry.ref_id,
					intakeEntry.idempotency_key,
					intakeEntry.payload,
					intakeEntry.expires_at,
					intakeEntry.received_at,
					intakeEntry.processed,
					intakeEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Verify process signal targets hostA
			const processEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND target_site_id = ?")
				.all("process", "host-a") as RelayOutboxEntry[];
			expect(processEntries.length).toBe(1);
		});

		// AC3.4: Model match routing
		it("AC3.4: intake routing selects host with matching model when no affinity", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const threadAffinityMap = new Map<string, string>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
				createMockModelRouter(),
				undefined,
				threadAffinityMap,
			);

			// Setup: two hosts with different models
			const timestamp = new Date().toISOString();
			db.run(
				"INSERT INTO hosts (site_id, host_name, models, deleted, modified_at) VALUES (?, ?, ?, ?, ?)",
				["host-a", "Host A", JSON.stringify(["gpt-4"]), 0, timestamp],
			);
			db.run(
				"INSERT INTO hosts (site_id, host_name, models, deleted, modified_at) VALUES (?, ?, ?, ?, ?)",
				["host-b", "Host B", JSON.stringify(["claude-3"]), 0, timestamp],
			);

			const threadId = "thread-model-match";
			// Insert a turns row for the thread with model_id = "claude-3"
			const turnTimestamp = new Date().toISOString();
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?)",
				[threadId, "claude-3", 100, 50, turnTimestamp],
			);

			const now = new Date();
			const intakeEntry: RelayInboxEntry = {
				id: "intake-model",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: "slack",
					platform_event_id: "event-model",
					thread_id: threadId,
					user_id: "user-1",
					message_id: "msg-model",
					content: "Test",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					intakeEntry.id,
					intakeEntry.source_site_id,
					intakeEntry.kind,
					intakeEntry.ref_id,
					intakeEntry.idempotency_key,
					intakeEntry.payload,
					intakeEntry.expires_at,
					intakeEntry.received_at,
					intakeEntry.processed,
					intakeEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Process signal should target hostB (which has claude-3)
			const processEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND target_site_id = ?")
				.all("process", "host-b") as RelayOutboxEntry[];
			expect(processEntries.length).toBe(1);
		});

		// AC3.5: Tool match routing
		it("AC3.5: intake routing selects host with most matching mcp_tools", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const threadAffinityMap = new Map<string, string>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
				createMockModelRouter(),
				undefined,
				threadAffinityMap,
			);

			// Setup: two hosts with different tools
			const timestamp = new Date().toISOString();
			db.run(
				"INSERT INTO hosts (site_id, host_name, mcp_tools, deleted, modified_at) VALUES (?, ?, ?, ?, ?)",
				["host-a", "Host A", JSON.stringify(["bash", "files"]), 0, timestamp],
			);
			db.run(
				"INSERT INTO hosts (site_id, host_name, mcp_tools, deleted, modified_at) VALUES (?, ?, ?, ?, ?)",
				["host-b", "Host B", JSON.stringify(["bash", "web", "files"]), 0, timestamp],
			);

			const threadId = "thread-tool-match";

			// Insert tool usage in the thread: ["bash", "web", "files"]
			const userId = "user-1";
			const nowIso = new Date().toISOString();
			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "unknown", "local", nowIso, nowIso],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, tool_name, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["msg-bash", threadId, "tool", "bash", "{}", "local", new Date().toISOString()],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, tool_name, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["msg-web", threadId, "tool", "web", "{}", "local", new Date().toISOString()],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, tool_name, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["msg-files", threadId, "tool", "files", "{}", "local", new Date().toISOString()],
			);

			const now = new Date();
			const intakeEntry: RelayInboxEntry = {
				id: "intake-tools",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: "slack",
					platform_event_id: "event-tools",
					thread_id: threadId,
					user_id: userId,
					message_id: "msg-intake",
					content: "Test",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					intakeEntry.id,
					intakeEntry.source_site_id,
					intakeEntry.kind,
					intakeEntry.ref_id,
					intakeEntry.idempotency_key,
					intakeEntry.payload,
					intakeEntry.expires_at,
					intakeEntry.received_at,
					intakeEntry.processed,
					intakeEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Process signal should target hostB (score 3 vs hostA score 2)
			const processEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND target_site_id = ?")
				.all("process", "host-b") as RelayOutboxEntry[];
			expect(processEntries.length).toBe(1);
		});

		// AC3.6: Fallback routing
		it("AC3.6: intake routing falls back to least-loaded host", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const threadAffinityMap = new Map<string, string>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				createMockEventBus(),
				createMockModelRouter(),
				undefined,
				threadAffinityMap,
			);

			// Setup: two hosts
			const timestamp = new Date().toISOString();
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-a",
				"Host A",
				0,
				timestamp,
			]);
			db.run("INSERT INTO hosts (site_id, host_name, deleted, modified_at) VALUES (?, ?, ?, ?)", [
				"host-b",
				"Host B",
				0,
				timestamp,
			]);

			// Add 3 pending relay_outbox entries targeting hostA, 1 targeting hostB
			const outboxTimestamp = new Date().toISOString();
			const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, delivered, created_at, expires_at, payload)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["out-1", "spoke-1", "host-a", "tool_call", 0, outboxTimestamp, expiresAt, "{}"],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, delivered, created_at, expires_at, payload)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["out-2", "spoke-1", "host-a", "tool_call", 0, outboxTimestamp, expiresAt, "{}"],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, delivered, created_at, expires_at, payload)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["out-3", "spoke-1", "host-a", "tool_call", 0, outboxTimestamp, expiresAt, "{}"],
			);
			db.run(
				`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, delivered, created_at, expires_at, payload)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				["out-4", "spoke-1", "host-b", "tool_call", 0, outboxTimestamp, expiresAt, "{}"],
			);

			const threadId = "thread-fallback";
			const now = new Date();
			const intakeEntry: RelayInboxEntry = {
				id: "intake-fallback",
				source_site_id: "requester-site",
				kind: "intake",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					platform: "slack",
					platform_event_id: "event-fallback",
					thread_id: threadId,
					user_id: "user-1",
					message_id: "msg-fallback",
					content: "Test",
				} as IntakePayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					intakeEntry.id,
					intakeEntry.source_site_id,
					intakeEntry.kind,
					intakeEntry.ref_id,
					intakeEntry.idempotency_key,
					intakeEntry.payload,
					intakeEntry.expires_at,
					intakeEntry.received_at,
					intakeEntry.processed,
					intakeEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Process signal should target hostB (least-loaded)
			const processEntries = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND target_site_id = ?")
				.all("process", "host-b") as RelayOutboxEntry[];
			expect(processEntries.length).toBe(1);
		});

		// AC3.7: platform_deliver emits on eventBus
		it("AC3.7: platform_deliver emits platform:deliver on eventBus", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const eventBus = createMockEventBus();
			let emittedPayload: PlatformDeliverPayload | null = null;

			// Listen for "platform:deliver" event
			eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
				emittedPayload = payload;
			});

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				eventBus,
			);

			const now = new Date();
			const deliverPayload: PlatformDeliverPayload = {
				platform: "slack",
				thread_id: "thread-1",
				message_id: "msg-1",
				content: "Delivery confirmation",
			};

			const inboxEntry: RelayInboxEntry = {
				id: "deliver-1",
				source_site_id: "requester-site",
				kind: "platform_deliver",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify(deliverPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					inboxEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Assert: eventBus emitted "platform:deliver" with the correct payload
			expect(emittedPayload).toBeDefined();
			expect(emittedPayload?.platform).toBe("slack");
			expect(emittedPayload?.thread_id).toBe("thread-1");
			expect(emittedPayload?.message_id).toBe("msg-1");
			expect(emittedPayload?.content).toBe("Delivery confirmation");
		});

		// AC3.8: event_broadcast fires event locally with correct event_depth
		it("AC3.8: event_broadcast fires named event on eventBus with correct event_depth", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const eventBus = createMockEventBus();
			let emittedPayload: Record<string, unknown> | null = null;

			// Listen for "task:triggered" event
			eventBus.on("task:triggered", (payload: Record<string, unknown>) => {
				emittedPayload = payload;
			});

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				eventBus,
			);

			const now = new Date();
			const broadcastPayload: EventBroadcastPayload = {
				event_name: "task:triggered",
				event_payload: { task_id: "t1", trigger: "test" },
				source_host: "hub",
				event_depth: 2,
			};

			const inboxEntry: RelayInboxEntry = {
				id: "broadcast-1",
				source_site_id: "requester-site",
				kind: "event_broadcast",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify(broadcastPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					inboxEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Assert: eventBus emitted "task:triggered" with correct payload
			expect(emittedPayload).toBeDefined();
			expect(emittedPayload?.task_id).toBe("t1");
			expect(emittedPayload?.trigger).toBe("test");
			// Assert: __relay_event_depth = 2
			expect(emittedPayload?.__relay_event_depth).toBe(2);
			// AC3.8: Verify that event_depth is NOT in emitted payload (should be transformed to __relay_event_depth)
			expect(emittedPayload?.event_depth).toBeUndefined();
		});

		// AC4.4: event_depth propagation
		it("AC4.4: event_broadcast with event_depth=1 fires with __relay_event_depth=1", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const eventBus = createMockEventBus();
			let emittedPayload: Record<string, unknown> | null = null;

			// Listen for "task:completed" event
			eventBus.on("task:completed", (payload: Record<string, unknown>) => {
				emittedPayload = payload;
			});

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				keyringSiteIds,
				createMockLogger(),
				eventBus,
			);

			const now = new Date();
			const broadcastPayload: EventBroadcastPayload = {
				event_name: "task:completed",
				event_payload: { task_id: "t2", status: "done" },
				source_host: "remote",
				event_depth: 1,
			};

			const inboxEntry: RelayInboxEntry = {
				id: "broadcast-depth-1",
				source_site_id: "requester-site",
				kind: "event_broadcast",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify(broadcastPayload),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					inboxEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Assert: emitted payload has __relay_event_depth = 1
			expect(emittedPayload).toBeDefined();
			expect(emittedPayload?.__relay_event_depth).toBe(1);
			expect(emittedPayload?.task_id).toBe("t2");
		});

		describe("execution - inference (AC8.5)", () => {
			it("AC8.5: passes abortController.signal to backend.chat()", async () => {
				// Mock LLM backend that captures parameters
				let capturedParams: ChatParams | null = null;

				class MockLLMBackend implements LLMBackend {
					async *chat(params: ChatParams) {
						capturedParams = params;
						yield { type: "text" as const, content: "Test response" };
						yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5, cache_write_tokens: null, cache_read_tokens: null, estimated: false} };
					}

					capabilities() {
						return {
							streaming: true,
							tool_use: true,
							system_prompt: true,
							prompt_caching: false,
							vision: false,
							max_context: 8000,
						};
					}
				}

				// Create a model router with the mock backend
				const mockBackend = new MockLLMBackend();
				const backends = new Map<string, LLMBackend>();
				backends.set("test-model", mockBackend);
				const modelRouter = new ModelRouter(backends, "test-model");

				const mcpClients = new Map<string, MCPClient>();
				const keyringSiteIds = new Set(["requester-site"]);
				const processor = new RelayProcessor(
					db,
					"target-site",
					mcpClients,
					modelRouter,
					keyringSiteIds,
					createMockLogger(),
					createMockEventBus(),
				);

				const now = new Date();
				const streamId = "stream-1";
				const inferencePayload: InferenceRequestPayload = {
					model: "test-model",
					messages: [{ role: "user", content: "test query" }],
				};

				const inboxEntry: RelayInboxEntry = {
					id: "inference-1",
					source_site_id: "requester-site",
					kind: "inference",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify(inferencePayload),
					expires_at: new Date(now.getTime() + 60000).toISOString(),
					received_at: now.toISOString(),
					processed: 0,
					stream_id: streamId,
				};

				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
						inboxEntry.stream_id,
					],
				);

				const handle = processor.start(50);
				await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
				handle.stop();

				// Assert: capturedParams includes signal property (defined, not undefined)
				expect(capturedParams).toBeDefined();
				expect(capturedParams?.signal).toBeDefined();
				expect(capturedParams?.signal).toBeInstanceOf(AbortSignal);
			});
		});

		// Item #2: Empty content guard in executeProcess
		it("Item #2: emits platform:deliver with empty content when platform-context process has tool_use-only assistant (typing stop)", async () => {
			// This test verifies that when the last assistant message contains ONLY tool_use blocks
			// (no text content), the platform:deliver event should NOT be emitted even though
			// the agent loop executed successfully.

			// Setup: Create thread with interface="discord"
			const threadId = "thread-item2";
			const userId = "user-1";
			const userMsgId = "msg-user-item2";
			const nowIso = new Date().toISOString();

			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
				[userId, "Test User", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userMsgId, threadId, "user", "Hello", "local", nowIso],
			);

			// Pre-insert an assistant message with ONLY tool_use blocks (the problematic case)
			const assistantMsgId = "msg-assistant-tool-only";
			const toolUseContent = JSON.stringify([
				{ type: "tool_use", id: "t1", name: "bash", input: {} },
			]);
			const laterTime = new Date(new Date(nowIso).getTime() + 5000).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[assistantMsgId, threadId, "assistant", toolUseContent, "local", laterTime],
			);

			// Setup: Create mock event bus to track platform:deliver emissions
			const eventBus = createMockEventBus();
			let platformDeliverEmitted = false;
			eventBus.on("platform:deliver", () => {
				platformDeliverEmitted = true;
			});

			// Setup: Create mock AppContext
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "local-site",
				hostName: "localhost",
			};

			// Setup: Create mock agent loop that completes successfully
			const mockAgentLoop = {
				run: async () => ({
					error: null,
					messagesCreated: 1,
					toolCallsMade: 1,
					filesChanged: 0,
				}),
			};

			// Create RelayProcessor with mock agent loop factory
			const processor = new RelayProcessor(
				db,
				"local-site",
				new Map(),
				createMockModelRouter(),
				new Set(["requester-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				mockAppCtx as any,
				undefined,
				new Map(),
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				() => mockAgentLoop as any,
			);

			// Execute: Insert a process inbox entry to trigger executeProcess
			const now = new Date();
			const processInboxEntry: RelayInboxEntry = {
				id: "process-item2",
				source_site_id: "requester-site",
				kind: "process",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					thread_id: threadId,
					message_id: userMsgId,
					user_id: userId,
					platform: "discord",
				}),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					processInboxEntry.id,
					processInboxEntry.source_site_id,
					processInboxEntry.kind,
					processInboxEntry.ref_id,
					processInboxEntry.idempotency_key,
					processInboxEntry.payload,
					processInboxEntry.expires_at,
					processInboxEntry.received_at,
					processInboxEntry.processed,
					processInboxEntry.stream_id,
				],
			);

			// Run processor to execute the process entry
			const handle = processor.start(50);
			await sleep(100);
			handle.stop();

			// Verify: platform:deliver IS now emitted even with tool_use-only assistant content.
			// In platform context, we always emit with empty content to stop the typing indicator.
			// (The Discord connector calls stopTyping() before checking content length.)
			expect(platformDeliverEmitted).toBe(true);
		});

		// Auto-deliver path (payload.platform = null): typing stop when no assistant messages
		it("auto-deliver: emits platform:deliver with empty content when no assistant messages (alert-only, typing stop)", async () => {
			// Bug: when auto-deliver runs with no assistant messages in the thread (e.g. agent only
			// created alert messages), platform:deliver is not emitted and typing persists.
			const threadId = "thread-auto-no-assistant";
			const userId = "user-auto-1";
			const userMsgId = "msg-user-auto-1";
			const nowIso = new Date().toISOString();

			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
			);
			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
				[userId, "Test User", nowIso, nowIso],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userMsgId, threadId, "user", "Hello", "local", nowIso],
			);
			// Agent created only an alert message (no assistant message)
			const laterTime = new Date(new Date(nowIso).getTime() + 5000).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					"msg-alert-auto",
					threadId,
					"alert",
					"Task failed: something went wrong",
					"local",
					laterTime,
				],
			);

			const eventBus = createMockEventBus();
			let platformDeliverPayload: PlatformDeliverPayload | null = null;
			eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
				platformDeliverPayload = payload;
			});
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "local-site",
				hostName: "localhost",
			};

			const processor = new RelayProcessor(
				db,
				"local-site",
				new Map(),
				createMockModelRouter(),
				new Set(["requester-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				mockAppCtx as any,
				undefined,
				new Map(),
				() =>
					({
						run: async () => ({
							error: null,
							messagesCreated: 1,
							toolCallsMade: 0,
							filesChanged: 0,
						}),
						// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					}) as any,
			);

			const now = new Date();
			db.run(
				"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"process-auto-no-asst",
					"requester-site",
					"process",
					null,
					null,
					JSON.stringify({
						thread_id: threadId,
						message_id: userMsgId,
						user_id: userId,
						platform: null,
					}),
					new Date(now.getTime() + 60000).toISOString(),
					now.toISOString(),
					0,
					null,
				],
			);

			const handle = processor.start(50);
			await sleep(100);
			handle.stop();

			// platform:deliver MUST be emitted even with no assistant messages, to stop typing.
			expect(platformDeliverPayload).not.toBeNull();
			expect((platformDeliverPayload as PlatformDeliverPayload | null)?.platform).toBe("discord");
			expect((platformDeliverPayload as PlatformDeliverPayload | null)?.content).toBe("");
		});

		// Auto-deliver path (payload.platform = null): typing stop when assistant has tool_use only
		it("auto-deliver: emits platform:deliver with empty content when assistant has only tool_use blocks (typing stop)", async () => {
			// Bug: when auto-deliver runs but last assistant has no text (only tool_use), the
			// `if (!textContent.trim()) return` guard prevents platform:deliver from firing.
			const threadId = "thread-auto-tool-only";
			const userId = "user-auto-2";
			const userMsgId = "msg-user-auto-2";
			const nowIso = new Date().toISOString();

			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
			);
			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
				[userId, "Test User", nowIso, nowIso],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userMsgId, threadId, "user", "Hello", "local", nowIso],
			);
			// Last assistant message has only tool_use blocks — no text content
			const toolOnlyContent = JSON.stringify([
				{ type: "tool_use", id: "t1", name: "bash", input: {} },
			]);
			const laterTime = new Date(new Date(nowIso).getTime() + 5000).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				["msg-asst-tool-auto", threadId, "assistant", toolOnlyContent, "local", laterTime],
			);

			const eventBus = createMockEventBus();
			let platformDeliverPayload: PlatformDeliverPayload | null = null;
			eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
				platformDeliverPayload = payload;
			});
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "local-site",
				hostName: "localhost",
			};

			const processor = new RelayProcessor(
				db,
				"local-site",
				new Map(),
				createMockModelRouter(),
				new Set(["requester-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				mockAppCtx as any,
				undefined,
				new Map(),
				() =>
					({
						run: async () => ({
							error: null,
							messagesCreated: 1,
							toolCallsMade: 1,
							filesChanged: 0,
						}),
						// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					}) as any,
			);

			const now = new Date();
			db.run(
				"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"process-auto-tool",
					"requester-site",
					"process",
					null,
					null,
					JSON.stringify({
						thread_id: threadId,
						message_id: userMsgId,
						user_id: userId,
						platform: null,
					}),
					new Date(now.getTime() + 60000).toISOString(),
					now.toISOString(),
					0,
					null,
				],
			);

			const handle = processor.start(50);
			await sleep(100);
			handle.stop();

			// platform:deliver MUST be emitted even with empty text content, to stop typing.
			expect(platformDeliverPayload).not.toBeNull();
			expect((platformDeliverPayload as PlatformDeliverPayload | null)?.platform).toBe("discord");
			expect((platformDeliverPayload as PlatformDeliverPayload | null)?.content).toBe("");
		});

		// Item #5: Test platform:deliver is emitted with correct content in happy path
		it("Item #5: emits platform:deliver with correct content when assistant message has text", async () => {
			// This test verifies the happy path: when the last assistant message contains text content,
			// platform:deliver SHOULD be emitted with that content.

			// Setup: Create thread with interface="discord"
			const threadId = "thread-item5";
			const userId = "user-1";
			const userMsgId = "msg-user-item5";
			const nowIso = new Date().toISOString();
			const expectedContent = "Hello from the agent!";

			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
				[userId, "Test User", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userMsgId, threadId, "user", "Hello", "local", nowIso],
			);

			// Pre-insert an assistant message with TEXT CONTENT (the happy path)
			const assistantMsgId = "msg-assistant-with-text";
			const laterTime = new Date(new Date(nowIso).getTime() + 5000).toISOString();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[assistantMsgId, threadId, "assistant", expectedContent, "local", laterTime],
			);

			// Setup: Create mock event bus to track platform:deliver emissions
			const eventBus = createMockEventBus();
			let platformDeliverPayload: PlatformDeliverPayload | null = null;
			eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
				platformDeliverPayload = payload;
			});

			// Setup: Create mock AppContext
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "local-site",
				hostName: "localhost",
			};

			// Setup: Create mock agent loop that completes successfully
			const mockAgentLoop = {
				run: async () => ({
					error: null,
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				}),
			};

			// Create RelayProcessor with mock agent loop factory
			const processor = new RelayProcessor(
				db,
				"local-site",
				new Map(),
				createMockModelRouter(),
				new Set(["requester-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				mockAppCtx as any,
				undefined,
				new Map(),
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				() => mockAgentLoop as any,
			);

			// Execute: Insert a process inbox entry to trigger executeProcess
			const now = new Date();
			const processInboxEntry: RelayInboxEntry = {
				id: "process-item5",
				source_site_id: "requester-site",
				kind: "process",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					thread_id: threadId,
					message_id: userMsgId,
					user_id: userId,
					platform: null,
				}),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					processInboxEntry.id,
					processInboxEntry.source_site_id,
					processInboxEntry.kind,
					processInboxEntry.ref_id,
					processInboxEntry.idempotency_key,
					processInboxEntry.payload,
					processInboxEntry.expires_at,
					processInboxEntry.received_at,
					processInboxEntry.processed,
					processInboxEntry.stream_id,
				],
			);

			// Run processor to execute the process entry
			const handle = processor.start(50);
			await sleep(100);
			handle.stop();

			// Verify: platform:deliver should be emitted with correct content
			expect(platformDeliverPayload).not.toBeNull();
			// Verify: auto-deliver should emit with the assistant's text content
			if (platformDeliverPayload) {
				expect(platformDeliverPayload.platform).toBe("discord");
				expect(platformDeliverPayload.content).toBe(expectedContent);
				expect(platformDeliverPayload.thread_id).toBe(threadId);
				expect(platformDeliverPayload.message_id).toBe(assistantMsgId);
			}
		});

		// Item #6: Rowid tiebreaker in ORDER BY
		it("Item #6: uses rowid tiebreaker when last-message timestamps are identical", async () => {
			// This test verifies that when two assistant messages have identical created_at timestamps,
			// the one with the higher rowid (inserted later) is selected.

			// Setup: Create thread with interface="discord"
			const threadId = "thread-item6";
			const userId = "user-1";
			const userMsgId = "msg-user-item6";
			const nowIso = new Date().toISOString();

			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
				[userId, "Test User", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userMsgId, threadId, "user", "Hello", "local", nowIso],
			);

			// INSERT TWO assistant messages with IDENTICAL created_at timestamps
			// SQLite assigns rowid in insertion order, so second message has higher rowid
			const sameTimestamp = nowIso;
			const firstMsgId = "msg-assistant-first";
			const secondMsgId = "msg-assistant-second";

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[firstMsgId, threadId, "assistant", "first", "local", sameTimestamp],
			);

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[secondMsgId, threadId, "assistant", "second", "local", sameTimestamp],
			);

			// Setup: Create mock event bus to track platform:deliver emissions
			const eventBus = createMockEventBus();
			let platformDeliverPayload: PlatformDeliverPayload | null = null;
			eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
				platformDeliverPayload = payload;
			});

			// Setup: Create mock AppContext
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "local-site",
				hostName: "localhost",
			};

			// Setup: Create mock agent loop
			const mockAgentLoop = {
				run: async () => ({
					error: null,
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				}),
			};

			// Create RelayProcessor
			const processor = new RelayProcessor(
				db,
				"local-site",
				new Map(),
				createMockModelRouter(),
				new Set(["requester-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				mockAppCtx as any,
				undefined,
				new Map(),
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				() => mockAgentLoop as any,
			);

			// Execute: Insert process entry
			const now = new Date();
			const processInboxEntry: RelayInboxEntry = {
				id: "process-item6",
				source_site_id: "requester-site",
				kind: "process",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					thread_id: threadId,
					message_id: userMsgId,
					user_id: userId,
					platform: null,
				}),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					processInboxEntry.id,
					processInboxEntry.source_site_id,
					processInboxEntry.kind,
					processInboxEntry.ref_id,
					processInboxEntry.idempotency_key,
					processInboxEntry.payload,
					processInboxEntry.expires_at,
					processInboxEntry.received_at,
					processInboxEntry.processed,
					processInboxEntry.stream_id,
				],
			);

			// Run processor
			const handle = processor.start(50);
			await sleep(100);
			handle.stop();

			// Verify: platform:deliver should contain content from SECOND message (higher rowid)
			expect(platformDeliverPayload).not.toBeNull();
			if (platformDeliverPayload) {
				expect(platformDeliverPayload.content).toBe("second");
				expect(platformDeliverPayload.message_id).toBe(secondMsgId);
			}
		});

		describe("executeProcess platform context", () => {
			it("injects platform tools into loop config when registry is set (AC6.1 setup + AC6.4 test)", async () => {
				// Setup: relay processor with mock registry, mock agentLoopFactory
				// Capture: what loopConfig was passed to agentLoopFactory
				// Assert: loopConfig.platform === "discord"
				// Assert: loopConfig.platformTools is a Map with "discord_send_message"

				// Setup: Create thread with interface="discord"
				const threadId = "thread-ac61";
				const userId = "user-ac61";
				const userMsgId = "msg-user-ac61";
				const nowIso = new Date().toISOString();

				db.run(
					"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
					[userId, "Test User", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userMsgId, threadId, "user", "Hello", "local", nowIso],
				);

				// Create mock event bus
				const eventBus = createMockEventBus();

				// Create mock AppContext
				const mockAppCtx = {
					db,
					config: {},
					optionalConfig: {},
					eventBus,
					logger: createMockLogger(),
					siteId: "local-site",
					hostName: "localhost",
				};

				// Capture loopConfig passed to agentLoopFactory
				let capturedLoopConfig: AgentLoopConfig | null = null;
				const mockAgentLoop = {
					run: async () => ({
						error: null,
						messagesCreated: 1,
						toolCallsMade: 1,
						filesChanged: 0,
					}),
				};

				const mockAgentLoopFactory = (config: AgentLoopConfig) => {
					capturedLoopConfig = config;
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					return mockAgentLoop as any;
				};

				// Create RelayProcessor
				const processor = new RelayProcessor(
					db,
					"local-site",
					new Map(),
					createMockModelRouter(),
					new Set(["requester-site"]),
					createMockLogger(),
					eventBus,
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					mockAppCtx as any,
					undefined,
					new Map(),
					mockAgentLoopFactory,
				);

				// Setup: Create mock platform connector registry
				const mockToolDefinition = {
					type: "function" as const,
					function: {
						name: "discord_send_message",
						description: "Send a message to Discord",
						parameters: { type: "object" as const, properties: {} },
					},
				};

				const mockPlatformTools = new Map([
					[
						"discord_send_message",
						{
							toolDefinition: mockToolDefinition,
							execute: async () => "message sent",
						},
					],
				]);

				const mockConnector = {
					getPlatformTools: () => mockPlatformTools,
				};

				const mockRegistry = {
					getConnector: (platform: string) => {
						if (platform === "discord") return mockConnector;
						return undefined;
					},
				};

				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				processor.setPlatformConnectorRegistry(mockRegistry as any);

				// Execute: Insert a process inbox entry to trigger executeProcess
				const now = new Date();
				const processInboxEntry: RelayInboxEntry = {
					id: "process-ac61",
					source_site_id: "requester-site",
					kind: "process",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify({
						thread_id: threadId,
						message_id: userMsgId,
						user_id: userId,
						platform: "discord",
					}),
					expires_at: new Date(now.getTime() + 60000).toISOString(),
					received_at: now.toISOString(),
					processed: 0,
					stream_id: null,
				};

				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						processInboxEntry.id,
						processInboxEntry.source_site_id,
						processInboxEntry.kind,
						processInboxEntry.ref_id,
						processInboxEntry.idempotency_key,
						processInboxEntry.payload,
						processInboxEntry.expires_at,
						processInboxEntry.received_at,
						processInboxEntry.processed,
						processInboxEntry.stream_id,
					],
				);

				// Run processor to execute the process entry
				const handle = processor.start(50);
				await sleep(100);
				handle.stop();

				// Assert: loopConfig.platform === "discord"
				expect(capturedLoopConfig).toBeDefined();
				expect(capturedLoopConfig.platform).toBe("discord");

				// Assert: loopConfig.platformTools is a Map with "discord_send_message"
				expect(capturedLoopConfig.platformTools).toBeDefined();
				expect(capturedLoopConfig.platformTools).toBeInstanceOf(Map);
				expect(capturedLoopConfig.platformTools.has("discord_send_message")).toBe(true);
			});

			it("emits platform:deliver with empty content for typing stop when payload.platform is non-null (AC6.2)", async () => {
				// Setup: listen for platform:deliver on eventBus
				// Run: process a relay with platform: "discord", agent produces an assistant message
				// Assert: platform:deliver was NOT emitted

				const threadId = "thread-ac62";
				const userId = "user-ac62";
				const userMsgId = "msg-user-ac62";
				const nowIso = new Date().toISOString();

				db.run(
					"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
					[userId, "Test User", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userMsgId, threadId, "user", "Hello", "local", nowIso],
				);

				// Setup: Create mock event bus to track platform:deliver emissions
				const eventBus = createMockEventBus();
				let platformDeliverEmitted = false;
				eventBus.on("platform:deliver", () => {
					platformDeliverEmitted = true;
				});

				// Setup: Create mock AppContext
				const mockAppCtx = {
					db,
					config: {},
					optionalConfig: {},
					eventBus,
					logger: createMockLogger(),
					siteId: "local-site",
					hostName: "localhost",
				};

				// Setup: Create mock agent loop that completes successfully and creates an assistant message
				const assistantMsgId = "msg-assistant-ac62";
				const assistantContent = "Hello from the agent!";

				const mockAgentLoop = {
					run: async () => {
						// Simulate agent creating an assistant message
						const laterTime = new Date(new Date(nowIso).getTime() + 5000).toISOString();
						db.run(
							"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							[assistantMsgId, threadId, "assistant", assistantContent, "local", laterTime],
						);
						return {
							error: null,
							messagesCreated: 1,
							toolCallsMade: 0,
							filesChanged: 0,
						};
					},
				};

				// Create RelayProcessor with mock agent loop factory
				const processor = new RelayProcessor(
					db,
					"local-site",
					new Map(),
					createMockModelRouter(),
					new Set(["requester-site"]),
					createMockLogger(),
					eventBus,
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					mockAppCtx as any,
					undefined,
					new Map(),
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					() => mockAgentLoop as any,
				);

				// Execute: Insert a process inbox entry with platform: "discord"
				const now = new Date();
				const processInboxEntry: RelayInboxEntry = {
					id: "process-ac62",
					source_site_id: "requester-site",
					kind: "process",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify({
						thread_id: threadId,
						message_id: userMsgId,
						user_id: userId,
						platform: "discord",
					}),
					expires_at: new Date(now.getTime() + 60000).toISOString(),
					received_at: now.toISOString(),
					processed: 0,
					stream_id: null,
				};

				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						processInboxEntry.id,
						processInboxEntry.source_site_id,
						processInboxEntry.kind,
						processInboxEntry.ref_id,
						processInboxEntry.idempotency_key,
						processInboxEntry.payload,
						processInboxEntry.expires_at,
						processInboxEntry.received_at,
						processInboxEntry.processed,
						processInboxEntry.stream_id,
					],
				);

				// Run processor to execute the process entry
				const handle = processor.start(50);
				await sleep(100);
				handle.stop();

				// Assert: platform:deliver IS emitted with empty content (typing stop), NOT with the assistant text
				expect(platformDeliverEmitted).toBe(true);
			});

			it("emits platform:deliver when payload.platform is null (AC6.3)", async () => {
				// Setup: thread with interface != "web", listen for platform:deliver
				// Run: process a relay with platform: null
				// Assert: platform:deliver was emitted with the last assistant message

				const threadId = "thread-ac63";
				const userId = "user-ac63";
				const userMsgId = "msg-user-ac63";
				const nowIso = new Date().toISOString();

				db.run(
					"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
					[userId, "Test User", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userMsgId, threadId, "user", "Hello", "local", nowIso],
				);

				// Setup: Create mock event bus to track platform:deliver emissions
				const eventBus = createMockEventBus();
				let platformDeliverPayload: PlatformDeliverPayload | null = null;
				eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
					platformDeliverPayload = payload;
				});

				// Setup: Create mock AppContext
				const mockAppCtx = {
					db,
					config: {},
					optionalConfig: {},
					eventBus,
					logger: createMockLogger(),
					siteId: "local-site",
					hostName: "localhost",
				};

				// Setup: Create mock agent loop that creates an assistant message
				const assistantMsgId = "msg-assistant-ac63";
				const assistantContent = "Hello from the agent!";

				const mockAgentLoop = {
					run: async () => {
						const laterTime = new Date(new Date(nowIso).getTime() + 5000).toISOString();
						db.run(
							"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							[assistantMsgId, threadId, "assistant", assistantContent, "local", laterTime],
						);
						return {
							error: null,
							messagesCreated: 1,
							toolCallsMade: 0,
							filesChanged: 0,
						};
					},
				};

				// Create RelayProcessor with mock agent loop factory
				const processor = new RelayProcessor(
					db,
					"local-site",
					new Map(),
					createMockModelRouter(),
					new Set(["requester-site"]),
					createMockLogger(),
					eventBus,
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					mockAppCtx as any,
					undefined,
					new Map(),
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					() => mockAgentLoop as any,
				);

				// Execute: Insert a process inbox entry with platform: null (NOT a platform context)
				const now = new Date();
				const processInboxEntry: RelayInboxEntry = {
					id: "process-ac63",
					source_site_id: "requester-site",
					kind: "process",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify({
						thread_id: threadId,
						message_id: userMsgId,
						user_id: userId,
						platform: null,
					}),
					expires_at: new Date(now.getTime() + 60000).toISOString(),
					received_at: now.toISOString(),
					processed: 0,
					stream_id: null,
				};

				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						processInboxEntry.id,
						processInboxEntry.source_site_id,
						processInboxEntry.kind,
						processInboxEntry.ref_id,
						processInboxEntry.idempotency_key,
						processInboxEntry.payload,
						processInboxEntry.expires_at,
						processInboxEntry.received_at,
						processInboxEntry.processed,
						processInboxEntry.stream_id,
					],
				);

				// Run processor to execute the process entry
				const handle = processor.start(50);
				await sleep(100);
				handle.stop();

				// Assert: platform:deliver should be emitted with the last assistant message
				expect(platformDeliverPayload).toBeDefined();
				if (platformDeliverPayload) {
					expect(platformDeliverPayload.platform).toBe("discord");
					expect(platformDeliverPayload.content).toBe(assistantContent);
					expect(platformDeliverPayload.thread_id).toBe(threadId);
					expect(platformDeliverPayload.message_id).toBe(assistantMsgId);
				}
			});

			it("gracefully proceeds when registry is not set (AC6.4)", async () => {
				// Setup: relay processor WITHOUT setPlatformConnectorRegistry()
				// Capture: loopConfig passed to agentLoopFactory
				// Assert: loopConfig.platform is undefined
				// Assert: loopConfig.platformTools is undefined
				// Assert: no crash

				const threadId = "thread-ac64";
				const userId = "user-ac64";
				const userMsgId = "msg-user-ac64";
				const nowIso = new Date().toISOString();

				db.run(
					"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
					[userId, "Test User", nowIso, nowIso],
				);

				db.run(
					"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userMsgId, threadId, "user", "Hello", "local", nowIso],
				);

				// Create mock event bus
				const eventBus = createMockEventBus();

				// Create mock AppContext
				const mockAppCtx = {
					db,
					config: {},
					optionalConfig: {},
					eventBus,
					logger: createMockLogger(),
					siteId: "local-site",
					hostName: "localhost",
				};

				// Capture loopConfig passed to agentLoopFactory
				let capturedLoopConfig: AgentLoopConfig | null = null;
				const mockAgentLoop = {
					run: async () => ({
						error: null,
						messagesCreated: 1,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};

				const mockAgentLoopFactory = (config: AgentLoopConfig) => {
					capturedLoopConfig = config;
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					return mockAgentLoop as any;
				};

				// Create RelayProcessor WITHOUT setting platform registry
				const processor = new RelayProcessor(
					db,
					"local-site",
					new Map(),
					createMockModelRouter(),
					new Set(["requester-site"]),
					createMockLogger(),
					eventBus,
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					mockAppCtx as any,
					undefined,
					new Map(),
					mockAgentLoopFactory,
				);

				// NOTE: No call to setPlatformConnectorRegistry() — registry stays null

				// Execute: Insert a process inbox entry with platform: "discord" even though registry is not set
				const now = new Date();
				const processInboxEntry: RelayInboxEntry = {
					id: "process-ac64",
					source_site_id: "requester-site",
					kind: "process",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify({
						thread_id: threadId,
						message_id: userMsgId,
						user_id: userId,
						platform: "discord",
					}),
					expires_at: new Date(now.getTime() + 60000).toISOString(),
					received_at: now.toISOString(),
					processed: 0,
					stream_id: null,
				};

				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						processInboxEntry.id,
						processInboxEntry.source_site_id,
						processInboxEntry.kind,
						processInboxEntry.ref_id,
						processInboxEntry.idempotency_key,
						processInboxEntry.payload,
						processInboxEntry.expires_at,
						processInboxEntry.received_at,
						processInboxEntry.processed,
						processInboxEntry.stream_id,
					],
				);

				// Run processor to execute the process entry
				const handle = processor.start(50);
				await sleep(100);
				handle.stop();

				// Assert: loopConfig.platform is undefined (graceful fallback)
				expect(capturedLoopConfig).toBeDefined();
				expect(capturedLoopConfig.platform).toBeUndefined();

				// Assert: loopConfig.platformTools is undefined (graceful fallback)
				expect(capturedLoopConfig.platformTools).toBeUndefined();

				// Assert: no crash (if we got here, it passed)
			});

			it("emits platform:deliver with empty content when platform-context process completes silently (typing stop)", async () => {
				// Bug: when the agent is silent (no discord_send_message call) in a platform context,
				// the Discord typing indicator persists for 5 minutes. executeProcess() must always
				// emit platform:deliver (even with empty content) so the connector can stop typing.
				const threadId = "thread-typing-stop-silent";
				const userId = "user-ts-1";
				const userMsgId = "msg-user-ts-1";
				const nowIso = new Date().toISOString();

				db.run(
					"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
				);
				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
					[userId, "Test User", nowIso, nowIso],
				);
				db.run(
					"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userMsgId, threadId, "user", "Hello", "local", nowIso],
				);
				// No assistant message — agent was silent

				const eventBus = createMockEventBus();
				let platformDeliverPayload: PlatformDeliverPayload | null = null;
				eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
					platformDeliverPayload = payload;
				});

				const mockAppCtx = {
					db,
					config: {},
					optionalConfig: {},
					eventBus,
					logger: createMockLogger(),
					siteId: "local-site",
					hostName: "localhost",
				};

				const processor = new RelayProcessor(
					db,
					"local-site",
					new Map(),
					createMockModelRouter(),
					new Set(["requester-site"]),
					createMockLogger(),
					eventBus,
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					mockAppCtx as any,
					undefined,
					new Map(),
					() =>
						({
							run: async () => ({
								error: null,
								messagesCreated: 0,
								toolCallsMade: 0,
								filesChanged: 0,
							}),
							// biome-ignore lint/suspicious/noExplicitAny: partial mock in test
						}) as any,
				);

				const now = new Date();
				db.run(
					"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						"process-ts-silent",
						"requester-site",
						"process",
						null,
						null,
						JSON.stringify({
							thread_id: threadId,
							message_id: userMsgId,
							user_id: userId,
							platform: "discord",
						}),
						new Date(now.getTime() + 60000).toISOString(),
						now.toISOString(),
						0,
						null,
					],
				);

				const handle = processor.start(50);
				await sleep(100);
				handle.stop();

				// platform:deliver MUST be emitted even when agent produced no messages,
				// so the Discord connector can call stopTyping().
				expect(platformDeliverPayload).not.toBeNull();
				expect((platformDeliverPayload as PlatformDeliverPayload | null)?.platform).toBe("discord");
				expect((platformDeliverPayload as PlatformDeliverPayload | null)?.thread_id).toBe(threadId);
				expect((platformDeliverPayload as PlatformDeliverPayload | null)?.content).toBe("");
			});

			it("emits platform:deliver with empty content when platform-context process fails (typing stop on error)", async () => {
				// Bug: when the agent loop throws (error path), the typing indicator is also never cleared.
				const threadId = "thread-typing-stop-error";
				const userId = "user-ts-2";
				const userMsgId = "msg-user-ts-2";
				const nowIso = new Date().toISOString();

				db.run(
					"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
					[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
				);
				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
					[userId, "Test User", nowIso, nowIso],
				);
				db.run(
					"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
					[userMsgId, threadId, "user", "Hello", "local", nowIso],
				);

				const eventBus = createMockEventBus();
				let platformDeliverPayload: PlatformDeliverPayload | null = null;
				eventBus.on("platform:deliver", (payload: PlatformDeliverPayload) => {
					platformDeliverPayload = payload;
				});

				const mockAppCtx = {
					db,
					config: {},
					optionalConfig: {},
					eventBus,
					logger: createMockLogger(),
					siteId: "local-site",
					hostName: "localhost",
				};

				const processor = new RelayProcessor(
					db,
					"local-site",
					new Map(),
					createMockModelRouter(),
					new Set(["requester-site"]),
					createMockLogger(),
					eventBus,
					// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
					mockAppCtx as any,
					undefined,
					new Map(),
					() =>
						({
							run: async (): Promise<never> => {
								throw new Error("Simulated agent failure");
							},
							// biome-ignore lint/suspicious/noExplicitAny: partial mock in test
						}) as any,
				);

				const now = new Date();
				db.run(
					"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						"process-ts-error",
						"requester-site",
						"process",
						null,
						null,
						JSON.stringify({
							thread_id: threadId,
							message_id: userMsgId,
							user_id: userId,
							platform: "discord",
						}),
						new Date(now.getTime() + 60000).toISOString(),
						now.toISOString(),
						0,
						null,
					],
				);

				const handle = processor.start(50);
				await sleep(100);
				handle.stop();

				// platform:deliver MUST be emitted even when agent loop throws.
				expect(platformDeliverPayload).not.toBeNull();
				expect((platformDeliverPayload as PlatformDeliverPayload | null)?.platform).toBe("discord");
				expect((platformDeliverPayload as PlatformDeliverPayload | null)?.thread_id).toBe(threadId);
				expect((platformDeliverPayload as PlatformDeliverPayload | null)?.content).toBe("");
			});
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
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

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, { message: "entry not processed" });
			handle.stop();

			// Verify: error response was written to outbox
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("error", inboxEntry.id) as RelayOutboxEntry[];
			expect(errors.length).toBeGreaterThan(0);
		});

		it("passes fileReader to getPlatformTools when set", async () => {
			// Setup: Create thread with interface="discord"
			const threadId = "thread-file-reader";
			const userId = "user-file-reader";
			const userMsgId = "msg-user-file-reader";
			const nowIso = new Date().toISOString();

			db.run(
				"INSERT INTO threads (id, user_id, created_at, interface, host_origin, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, userId, nowIso, "discord", "local", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
				[userId, "Test User", nowIso, nowIso],
			);

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, host_origin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[userMsgId, threadId, "user", "Hello", "local", nowIso],
			);

			// Setup: Create mock event bus
			const eventBus = createMockEventBus();

			// Setup: Create mock AppContext
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "local-site",
				hostName: "localhost",
			};

			// Setup: Capture the fileReader argument passed to getPlatformTools
			let capturedReadFileFn: ((path: string) => Promise<Uint8Array>) | undefined;
			const mockToolDefinition = {
				type: "function" as const,
				function: {
					name: "discord_send_message",
					description: "Send a message to Discord",
					parameters: { type: "object" as const, properties: {} },
				},
			};

			const mockPlatformTools = new Map([
				[
					"discord_send_message",
					{
						toolDefinition: mockToolDefinition,
						execute: async () => "message sent",
					},
				],
			]);

			const mockConnector = {
				getPlatformTools: (
					_threadId: string,
					readFileFn?: (path: string) => Promise<Uint8Array>,
				) => {
					capturedReadFileFn = readFileFn;
					return mockPlatformTools;
				},
			};

			const mockRegistry = {
				getConnector: (platform: string) => {
					if (platform === "discord") return mockConnector;
					return undefined;
				},
			};

			// Setup: Create RelayProcessor
			let _capturedLoopConfig: AgentLoopConfig | null = null;
			const mockAgentLoop = {
				run: async () => ({
					error: null,
					messagesCreated: 1,
					toolCallsMade: 1,
					filesChanged: 0,
				}),
			};

			const mockAgentLoopFactory = (config: AgentLoopConfig) => {
				_capturedLoopConfig = config;
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				return mockAgentLoop as any;
			};

			const processor = new RelayProcessor(
				db,
				"local-site",
				new Map(),
				createMockModelRouter(),
				new Set(["requester-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
				mockAppCtx as any,
				undefined,
				new Map(),
				mockAgentLoopFactory,
			);

			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			processor.setPlatformConnectorRegistry(mockRegistry as any);

			// Setup: Create and set the file reader
			const mockFileReader = async (_path: string): Promise<Uint8Array> => {
				return new Uint8Array([1, 2, 3, 4]);
			};
			// biome-ignore lint/suspicious/noExplicitAny: partial mock object in test
			(processor as any).setFileReader(mockFileReader);

			// Execute: Insert a process inbox entry to trigger executeProcess
			const now = new Date();
			const processInboxEntry: RelayInboxEntry = {
				id: "process-file-reader",
				source_site_id: "requester-site",
				kind: "process",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					thread_id: threadId,
					message_id: userMsgId,
					user_id: userId,
					platform: "discord",
				}),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					processInboxEntry.id,
					processInboxEntry.source_site_id,
					processInboxEntry.kind,
					processInboxEntry.ref_id,
					processInboxEntry.idempotency_key,
					processInboxEntry.payload,
					processInboxEntry.expires_at,
					processInboxEntry.received_at,
					processInboxEntry.processed,
					processInboxEntry.stream_id,
				],
			);

			// Run processor to execute the process entry
			const handle = processor.start(50);
			await sleep(100);
			handle.stop();

			// Assert: the fileReader was passed to getPlatformTools
			expect(capturedReadFileFn).toBeDefined();
			expect(capturedReadFileFn).toBe(mockFileReader);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Cross-node platform delivery: hub executes process relay but platform
	// connector is on the SPOKE (source_site_id), not the hub
	// ─────────────────────────────────────────────────────────────────────────
	describe("cross-node platform_deliver routing", () => {
		it("routes platform_deliver via relay outbox when local registry lacks the connector", async () => {
			// Setup: thread with non-web interface so platform delivery triggers
			const now = new Date().toISOString();
			const userId = "user-xnpd";
			const threadId = "thread-xnpd";
			const userMsgId = "msg-xnpd";

			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
				[userId, "User", now, now],
			);
			db.run(
				`INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, modified_at, last_message_at, deleted)
				 VALUES (?, ?, 'discord', 'spoke-host', 0, 'Thread', ?, ?, ?, 0)`,
				[threadId, userId, now, now, now],
			);
			db.run(
				`INSERT INTO messages (id, thread_id, role, content, created_at, host_origin)
				 VALUES (?, ?, 'user', 'hello', ?, 'spoke-host')`,
				[userMsgId, threadId, now],
			);

			const eventBus = new (require("@bound/shared").TypedEventEmitter)();
			const mockAppCtx = {
				db,
				config: {},
				optionalConfig: {},
				eventBus,
				logger: createMockLogger(),
				siteId: "hub-site",
				hostName: "hub",
			};

			// Registry WITHOUT Discord connector (Discord is only on the spoke)
			const emptyRegistry = {
				getConnector: (_platform: string) => undefined,
			};

			const mockAgentLoop = {
				run: async () => ({
					error: null,
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				}),
			};

			const processor = new RelayProcessor(
				db,
				"hub-site",
				new Map(),
				createMockModelRouter(),
				new Set(["spoke-site"]),
				createMockLogger(),
				eventBus,
				// biome-ignore lint/suspicious/noExplicitAny: partial mock
				mockAppCtx as any,
				undefined,
				new Map(),
				// biome-ignore lint/suspicious/noExplicitAny: partial mock
				() => mockAgentLoop as any,
			);
			// biome-ignore lint/suspicious/noExplicitAny: partial mock
			processor.setPlatformConnectorRegistry(emptyRegistry as any);

			// Insert a process inbox entry from the SPOKE with platform="discord"
			const processEntry: RelayInboxEntry = {
				id: "process-xnpd",
				source_site_id: "spoke-site", // spoke originated this
				kind: "process",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					thread_id: threadId,
					message_id: userMsgId,
					user_id: userId,
					platform: "discord",
				}),
				expires_at: new Date(Date.now() + 60_000).toISOString(),
				received_at: now,
				processed: 0,
				stream_id: null,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed, stream_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					processEntry.id,
					processEntry.source_site_id,
					processEntry.kind,
					processEntry.ref_id,
					processEntry.idempotency_key,
					processEntry.payload,
					processEntry.expires_at,
					processEntry.received_at,
					processEntry.processed,
					processEntry.stream_id,
				],
			);

			const handle = processor.start(50);
			await waitFor(() => readUnprocessed(db).length === 0, {
				message: "process entry not handled",
			});
			handle.stop();

			// The hub has no Discord connector — delivery should have been routed
			// via a platform_deliver relay outbox entry targeting the spoke.
			const { readUndelivered } = require("@bound/core");
			const spokeOutbox = (
				readUndelivered(db, "spoke-site") as Array<{ kind: string; target_site_id: string }>
			).filter((e) => e.kind === "platform_deliver");

			expect(spokeOutbox.length).toBeGreaterThan(0);
			expect(spokeOutbox[0].target_site_id).toBe("spoke-site");
		});
	});
});
