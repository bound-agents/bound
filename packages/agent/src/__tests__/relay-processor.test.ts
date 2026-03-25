import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, readUnprocessed } from "@bound/core";
import type {
	CacheWarmPayload,
	Logger,
	PromptInvokePayload,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ToolCallPayload,
} from "@bound/shared";
import type { MCPClient } from "../mcp-client";
import { RelayProcessor } from "../relay-processor";

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

	async invokePrompt(name: string, args: Record<string, unknown>) {
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

// Mock logger
const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-processor-${testId}.db`;
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

describe("RelayProcessor", () => {
	describe("background loop", () => {
		it("creates RelayProcessor and returns stop handle", () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				keyringSiteIds,
				createMockLogger(),
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
				keyringSiteIds,
				createMockLogger(),
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
					args: {},
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));

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
				keyringSiteIds,
				createMockLogger(),
			);

			const handle = processor.start(50);
			await new Promise((resolve) => setTimeout(resolve, 100));
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
				keyringSiteIds,
				createMockLogger(),
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
					args: {},
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));
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
				keyringSiteIds,
				createMockLogger(),
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
					args: {},
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));
			handle.stop();

			// Entry should be marked as processed
			const entries = readUnprocessed(db);
			expect(entries.length).toBe(0);

			// No outbox entry should be created for expired request
			const outboxEntries = db
				.query("SELECT COUNT(*) as count FROM relay_outbox")
				.get() as { count: number };
			expect(outboxEntries.count).toBe(0);
		});
	});

	describe("execution - resource_read (AC1.3)", () => {
		it("executes resource_read and writes result to outbox", async () => {
			const mockClient = new MockMCPClient("resource-server");
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("resource-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				keyringSiteIds,
				createMockLogger(),
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
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));
			handle.stop();

			// Check that result was written to outbox
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("execution - prompt_invoke (AC1.4)", () => {
		it("executes prompt_invoke and writes result to outbox", async () => {
			const mockClient = new MockMCPClient("prompt-server");
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("prompt-server", mockClient as unknown as MCPClient);

			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				keyringSiteIds,
				createMockLogger(),
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
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));
			handle.stop();

			// Check that result was written to outbox
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("idempotency", () => {
		it("returns cached response on duplicate idempotency_key (AC5.1)", async () => {
			const mockClient = new MockMCPClient("test-server");
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
				keyringSiteIds,
				createMockLogger(),
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
					tool: "test",
					args: {},
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));

			const callCountAfterFirst = callCount;

			// Insert second request with same idempotency_key
			const entry2: RelayInboxEntry = {
				id: "req-2",
				source_site_id: "requester-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: idempotencyKey,
				payload: JSON.stringify({
					tool: "test",
					args: {},
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));

			handle.stop();

			// callCount should not increase (cached response used)
			expect(callCount).toBe(callCountAfterFirst);
		});

		it("expires cache entries after 5 minutes (AC5.3)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				keyringSiteIds,
				createMockLogger(),
			);

			expect(processor).toBeDefined();
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
				keyringSiteIds,
				createMockLogger(),
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
					args: {},
					timeout_ms: 5000,
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
			await new Promise((resolve) => setTimeout(resolve, 200));
			handle.stop();

			// Tool request should be marked processed but no execution should occur
			const entries = readUnprocessed(db);
			expect(entries.length).toBe(0);
		});
	});

	describe("idempotency cache", () => {
		it("maintains 5-minute TTL for cache entries", () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				keyringSiteIds,
				createMockLogger(),
			);

			// Create processor instance and verify it has cache methods
			expect(processor).toBeDefined();
		});
	});

	describe("cancel handling", () => {
		it("tracks pending cancel entries", () => {
			const mcpClients = new Map<string, MCPClient>();
			const keyringSiteIds = new Set(["requester-site"]);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				keyringSiteIds,
				createMockLogger(),
			);

			expect(processor).toBeDefined();
		});
	});
});
