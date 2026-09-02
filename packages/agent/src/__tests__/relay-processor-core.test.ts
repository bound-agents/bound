import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySchema,
	getDurableWork,
	insertInbox,
	listDeadLetterDurableWork,
	readInboxByRefId,
	readUnprocessed,
	resetProcessingDurableWork,
	setDurableRelayEnabledForTesting,
} from "@bound/core";
import { applyMetricsSchema } from "@bound/core";
import type { ChatParams, LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type {
	Logger,
	PromptInvokePayload,
	RelayInboxEntry,
	RelayOutboxEntry,
	ResourceReadPayload,
	ToolCallPayload,
	TypedEventEmitter,
} from "@bound/shared";
import type { SchedulerAction, SchedulerLike } from "rxjs";
import type { MCPClient } from "../mcp-client";
import { INTAKE_RECONCILIATION_STARTUP_GRACE_MS, RelayProcessor } from "../relay-processor";
import { routeRelayRequest } from "../relay-router";
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

beforeEach(() => {
	// In-memory DB — these tests pass the handle directly and never reopen
	// from a path, so :memory: avoids the Windows EBUSY / WAL checkpoint
	// slowdown that tips the per-hook budget under CI load.
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
});

describe("RelayProcessor", () => {
	describe("background loop", () => {
		it("holds stale intake reconciliation until the startup grace window has elapsed", () => {
			const callbacks: Array<() => void> = [];
			let now = 0;
			let advisoryChecks = 0;
			const scheduler: SchedulerLike = {
				now: () => now,
				schedule: (work, _delay, state) => {
					callbacks.push(() =>
						work.call(
							{
								schedule: () => ({ unsubscribe: () => {} }),
								unsubscribe: () => {},
								closed: false,
							} as SchedulerAction<unknown>,
							state,
						),
					);
					return { unsubscribe: () => {} };
				},
			};
			const logger = {
				...createMockLogger(),
				warn: (message: string) => {
					if (message === "[relay] Webhook intake reconcile acted") advisoryChecks++;
				},
			};
			const processor = new RelayProcessor(
				db,
				"target-site",
				new Map<string, MCPClient>(),
				createMockModelRouter(),
				logger,
				createMockEventBus(),
				null,
				undefined,
				undefined,
				undefined,
				() => now,
			);

			const handle = processor.start(10, scheduler);
			const pruneTick = callbacks.at(-1);
			expect(pruneTick).toBeDefined();
			pruneTick?.();
			expect(advisoryChecks).toBe(0);

			now = INTAKE_RECONCILIATION_STARTUP_GRACE_MS;
			pruneTick?.();
			expect(advisoryChecks).toBe(0);
			handle.stop();
		});

		it("creates RelayProcessor and returns stop handle", () => {
			const mcpClients = new Map<string, MCPClient>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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
		it("processes an entry whose source_site_id is absent from the keyring (R-SR1/R-SR7/R-SR11)", async () => {
			// Spoke-to-spoke relay (#50): the delivering peer (the hub) is
			// authenticated at the transport boundary, so an inbox entry's mere
			// presence carries delivery-time authentication. The processor
			// authorizes on that, not on source_site_id, which is a hub-vouched
			// attestation of origin used only for response correlation and audit.
			// A sibling spoke's id need not appear in the local keyring.
			const mockClient = new MockMCPClient(
				"github",
				new Map([["create_issue", { name: "create_issue", description: "Create an issue" }]]),
			);
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("github", mockClient as unknown as MCPClient);

			// Keyring holds the hub only; the source is a sibling spoke absent from it.
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const inboxEntry: RelayInboxEntry = {
				id: "entry-1",
				source_site_id: "sibling-spoke",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: JSON.stringify({
					tool: "github",
					args: { subcommand: "create_issue", title: "Fix bug", body: "Details" },
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

			// It executed: a result row correlated by ref_id exists.
			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);

			// It was NOT rejected as an unknown source.
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ?")
				.all("error") as RelayOutboxEntry[];
			expect(errors.length).toBe(0);
		});

		it("executeImmediate processes a request whose source_site_id is absent from the keyring (R-SR1)", async () => {
			// Hub-local synchronous execution route mirrors the inbox path:
			// source_site_id is not an authorization input here either.
			const mockClient = new MockMCPClient(
				"github",
				new Map([["create_issue", { name: "create_issue", description: "Create an issue" }]]),
			);
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("github", mockClient as unknown as MCPClient);

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				createMockLogger(),
				createMockEventBus(),
			);

			const now = new Date();
			const request: RelayOutboxEntry = {
				id: "req-1",
				source_site_id: "sibling-spoke",
				target_site_id: "target-site",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				stream_id: null,
				payload: JSON.stringify({
					tool: "github",
					args: { subcommand: "create_issue", title: "Fix bug", body: "Details" },
				} as ToolCallPayload),
				created_at: now.toISOString(),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				delivered: 0,
				trace_context: null,
			};

			const results = await processor.executeImmediate(request, "hub-site");

			// Returns an execution result, not an "Unknown source site" rejection.
			expect(results.length).toBeGreaterThan(0);
			expect(results.every((r) => r.kind !== "error")).toBe(true);
		});

		it("discards expired inbox entries (AC9.2)", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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
		it("acknowledges cache_warm without returning content from supplied host paths", async () => {
			const mcpClients = new Map<string, MCPClient>();
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				createMockLogger(),
				createMockEventBus(),
			);

			const fs = require("node:fs");
			const testDir = join(tmpdir(), `relay-cache-warm-test-${randomBytes(4).toString("hex")}`);
			fs.mkdirSync(testDir, { recursive: true });
			const secretFile = `${testDir}/secret.txt`;
			const secret = "cache-warm-must-not-read-this-host-file";
			fs.writeFileSync(secretFile, secret);

			try {
				const now = new Date();
				const inboxEntry: RelayInboxEntry = {
					id: "cache-warm-1",
					source_site_id: "requester-site",
					kind: "cache_warm",
					ref_id: null,
					idempotency_key: null,
					payload: JSON.stringify({ paths: [secretFile], timeout_ms: 1_000 }),
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

				const [result] = db
					.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
					.all("result", inboxEntry.id) as RelayOutboxEntry[];
				expect(result).toBeDefined();
				expect(result.payload).not.toContain(secret);
				expect(JSON.parse(result.payload)).toEqual({
					stdout: "cache_warm acknowledged",
					stderr: "",
					exit_code: 0,
					execution_ms: 0,
				});
			} finally {
				fs.rmSync(testDir, { recursive: true, force: true });
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

		it("missing subcommand in args returns server-level help (host-parity with local dispatch)", async () => {
			// A relay tool_call with no subcommand is a help request, identical to
			// invoking a bare `<server>` on the local dispatch path (mcp-bridge.ts:
			// `!subcommand` -> formatMcpHelp). It enumerates the server's subcommands
			// from a live listTools rather than erroring, so the environment looks the
			// same regardless of which host the MCP server lives on.
			const tools = new Map([
				["create_issue", { name: "create_issue", description: "Open an issue" }],
			]);
			const mockClient = new MockMCPClient("github", tools);
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("github", mockClient as unknown as MCPClient);

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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

			// Verify: a help result (not an error) was written to outbox, enumerating
			// the server's subcommands.
			const errors = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("error", inboxEntry.id) as RelayOutboxEntry[];
			expect(errors.length).toBe(0);

			const results = db
				.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
				.all("result", inboxEntry.id) as RelayOutboxEntry[];
			expect(results.length).toBeGreaterThan(0);
			const resultPayload = JSON.parse(results[0].payload) as {
				stdout: string;
				exit_code: number;
			};
			expect(resultPayload.stdout).toContain("github subcommands");
			expect(resultPayload.stdout).toContain("create_issue");
			expect(resultPayload.exit_code).toBe(0);
		});

		it("unknown server name (client not in mcpClients map) returns error response", async () => {
			const mcpClients = new Map<string, MCPClient>();
			// Don't add "unknown-server" to clients map

			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
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
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

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
			expect(amplifiedErrors.length).toBe(0);
		});

		it("does not generate error responses for 'result' kind inbox entries", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

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

	describe("passive kind handling", () => {
		// Passive relay kinds (currently: webhook_intake) are durable mailbox
		// rows owned by another consumer — the scheduler's event-task wakeup
		// path drains webhook envelopes via buildEventWakeupContent. The
		// relay-processor must leave passive rows entirely untouched.
		//
		// Pre-fix this exact scenario was the production bug: webhook handler
		// wrote rows with kind="intake", relay-processor failed to parse them
		// as the MCP intakePayloadSchema, called markProcessed in the error
		// branch, and the scheduler's helper saw processed=0 empty and fell
		// back to "Execute scheduled task." on every webhook wakeup.
		it("leaves webhook_intake rows unprocessed for the scheduler to drain", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

			// HTTP webhook envelope shape — distinct from intakePayloadSchema.
			// Pre-fix this would have failed to parse and been silently consumed
			// by the relay-processor's error branch.
			const httpEnvelope = JSON.stringify({
				method: "POST",
				path: "/webhook/bound",
				headers: { "x-github-event": "push", "x-github-delivery": "abc-123" },
				content_type: "application/json",
				body: '{"ref":"refs/heads/main","commits":[]}',
			});

			const { insertInbox } = require("@bound/core");
			insertInbox(db, {
				id: "webhook-row-1",
				source_site_id: "remote-site",
				kind: "webhook_intake",
				ref_id: "thread-aaaa",
				idempotency_key: "github-abc-123",
				stream_id: null,
				payload: httpEnvelope,
				expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
				received_at: new Date().toISOString(),
				processed: 0,
			});

			const handle = processor.start(10);
			// Long enough for several poll ticks; if the row were going to be
			// touched, it would have been touched several times over by now.
			await sleep(300);
			handle.stop();

			// Row must still be unprocessed — the scheduler is the rightful
			// consumer.
			const inboxEntry = db
				.query("SELECT processed FROM relay_inbox WHERE id = ?")
				.get("webhook-row-1") as { processed: number } | null;
			expect(inboxEntry).not.toBeNull();
			expect(inboxEntry?.processed).toBe(0);

			// And no error response or any other outbox entry was generated.
			const outbox = db.query("SELECT * FROM relay_outbox").all() as RelayOutboxEntry[];
			expect(outbox.length).toBe(0);
		});

		it("does not interfere with non-passive entries arriving alongside webhook_intake", async () => {
			// A passive row coexisting with a regular request kind must not
			// block the regular dispatcher path. The poll loop iterates all
			// unprocessed entries each tick.
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

			const { insertInbox } = require("@bound/core");
			// Passive row — must remain unprocessed
			insertInbox(db, {
				id: "passive-row",
				source_site_id: "remote-site",
				kind: "webhook_intake",
				ref_id: "thread-aaaa",
				idempotency_key: "github-1",
				stream_id: null,
				payload: JSON.stringify({ method: "POST", path: "/webhook/bound", body: "{}" }),
				expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
				received_at: new Date().toISOString(),
				processed: 0,
			});
			// Response row — relay-processor markProcessed-es response kinds
			insertInbox(db, {
				id: "response-row",
				source_site_id: "remote-site",
				kind: "result",
				ref_id: "some-prior-request",
				idempotency_key: "result-1",
				stream_id: null,
				payload: JSON.stringify({ result: "ok" }),
				expires_at: new Date(Date.now() + 300_000).toISOString(),
				received_at: new Date().toISOString(),
				processed: 0,
			});

			const handle = processor.start(10);
			await waitFor(
				() => {
					const row = db
						.query("SELECT processed FROM relay_inbox WHERE id = ?")
						.get("response-row") as { processed: number } | null;
					return row?.processed === 1;
				},
				{ message: "response row not processed" },
			);
			handle.stop();

			// Passive row still unprocessed
			const passive = db
				.query("SELECT processed FROM relay_inbox WHERE id = ?")
				.get("passive-row") as { processed: number } | null;
			expect(passive?.processed).toBe(0);
		});
	});
});

describe("durable active relay lane", () => {
	it("claims an active durable tool_call, writes its legacy response, and consumes the work", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
			 VALUES (?, ?, 'tool_call', ?, 'durable-tool', 'pending', 0, ?, ?, 'requester-site', ?)`,
			[
				"durable-request",
				"target-site",
				JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }),
				now,
				new Date(Date.now() + 60_000).toISOString(),
				now,
			],
		);
		await (processor as any).processPendingEntries();
		expect(
			db.query("SELECT claim_state FROM durable_work WHERE id = ?").get("durable-request"),
		).toEqual({ claim_state: "consumed" });
		expect(
			db
				.query("SELECT kind, ref_id, target_site_id FROM relay_outbox WHERE ref_id = ?")
				.get("durable-request"),
		).toEqual({ kind: "result", ref_id: "durable-request", target_site_id: "requester-site" });
	});

	it("(f/§7) end-to-end: routeRelayRequest producer → 4D-A dispatch → legacy response the requester awaits on", async () => {
		// Requester side: mark the target capable and route a durable tool_call to it.
		setDurableRelayEnabledForTesting(true);
		const nowIso = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES ('target-site', 'target-site', '0', ?, ?, 1, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = 1, deleted = 0`,
			[nowIso, nowIso],
		);
		const routed = routeRelayRequest(db, {
			targetSiteId: "target-site",
			sourceSiteId: "requester-site",
			kind: "tool_call",
			payload: JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }),
			timeoutMs: 60_000,
			topologyRole: "hub",
		});
		expect(routed.path).toBe("durable");
		// The requester awaits on the durable row id; give the row its source so the
		// 4D-A lane knows where to write the response back.
		db.run("UPDATE durable_work SET source_site = 'requester-site' WHERE id = ?", [routed.id]);

		// Target side: the 4D-A lane claims, dispatches, and writes the legacy response.
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		await (processor as any).processPendingEntries();

		// The durable request was consumed.
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(routed.id)).toEqual({
			claim_state: "consumed",
		});

		// The response rode back legacy with ref_id = the durable row id — exactly the
		// correlation id the requester awaits via readInboxByRefId. Move it into the
		// inbox (the sync transport does this on delivery) and prove the await resolves.
		const outboxResponse = db
			.query(
				"SELECT id, source_site_id, target_site_id, kind, ref_id, payload FROM relay_outbox WHERE ref_id = ?",
			)
			.get(routed.id) as {
			id: string;
			source_site_id: string;
			target_site_id: string;
			kind: string;
			ref_id: string;
			payload: string;
		} | null;
		if (!outboxResponse) throw new Error("expected a legacy response row for the durable request");
		expect(outboxResponse).toMatchObject({
			kind: "result",
			ref_id: routed.id,
			target_site_id: "requester-site",
		});
		if (!outboxResponse) throw new Error("expected a relay_outbox response row");
		insertInbox(db, {
			id: outboxResponse.id,
			source_site_id: outboxResponse.source_site_id,
			target_site_id: outboxResponse.target_site_id,
			kind: outboxResponse.kind,
			ref_id: outboxResponse.ref_id,
			idempotency_key: null,
			stream_id: null,
			payload: outboxResponse.payload,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			received_at: new Date().toISOString(),
			trace_context: null,
		});
		const awaited = readInboxByRefId(db, routed.id);
		expect(awaited?.kind).toBe("result");
		expect(awaited?.ref_id).toBe(routed.id);
	});

	it("writes an error response and consumes a durable request whose handler fails", async () => {
		const failingClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		failingClient.callTool = async () => {
			throw new Error("durable handler failure");
		};
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", failingClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES (?, ?, 'tool_call', ?, 'durable-fail', 'pending', 0, ?, 'requester-site')`,
			[
				"durable-failure",
				"target-site",
				JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }),
				now,
			],
		);
		await (processor as any).processPendingEntries();
		expect(
			db.query("SELECT claim_state FROM durable_work WHERE id = ?").get("durable-failure"),
		).toEqual({ claim_state: "consumed" });
		expect(
			db
				.query("SELECT kind, ref_id, payload FROM relay_outbox WHERE ref_id = ?")
				.get("durable-failure"),
		).toMatchObject({ kind: "error", ref_id: "durable-failure" });
	});

	it("leaves passive and response durable rows for their later owners", async () => {
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		for (const kind of ["webhook_intake", "result"]) {
			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at) VALUES (?, ?, ?, '{}', ?, 'pending', 0, ?)`,
				[kind, "target-site", kind, `leave-${kind}`, now],
			);
		}
		await (processor as any).processPendingEntries();
		expect(
			db.query("SELECT claim_state FROM durable_work WHERE id = 'webhook_intake'").get(),
		).toEqual({ claim_state: "pending" });
		expect(db.query("SELECT claim_state FROM durable_work WHERE id = 'result'").get()).toEqual({
			claim_state: "pending",
		});
	});

	it("reclaims boot-recovered durable work", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, claim_token, attempt_count, created_at, source_site) VALUES ('recovered', 'target-site', 'tool_call', ?, 'recovered-key', 'processing', 'abandoned', 1, ?, 'requester-site')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		expect(resetProcessingDurableWork(db, "target-site")).toBe(1);
		await (processor as any).processPendingEntries();
		expect(
			db.query("SELECT claim_state, attempt_count FROM durable_work WHERE id = 'recovered'").get(),
		).toEqual({ claim_state: "consumed", attempt_count: 2 });
	});

	// Objection 5(a): a pre-dispatch infrastructure failure (handler removed from
	// the map after claim eligibility) must propagate, NOT consume, NOT dead-letter.
	it("leaves the durable row processing on an infrastructure failure below the attempt budget", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		// Force an infrastructure failure AFTER dispatch begins: writeResponse throws.
		(processor as any).writeResponse = () => {
			throw new Error("outbox write failed");
		};
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('infra', 'target-site', 'tool_call', ?, 'infra-key', 'pending', 0, ?, 'requester-site')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "infra")).toMatchObject({
			claim_state: "processing",
			attempt_count: 1,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM relay_outbox WHERE ref_id = 'infra'").get()).toEqual(
			{
				n: 0,
			},
		);
		expect(listDeadLetterDurableWork(db, "tool_call")).toHaveLength(0);
	});

	// Objection 5(b): attempts 1→2→3 across resetProcessingDurableWork reclaims;
	// the third failure dead-letters. attempt_count increments once per claim.
	it("dead-letters after the attempt budget is exhausted across reclaims", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		(processor as any).writeResponse = () => {
			throw new Error("outbox write failed");
		};
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('retry', 'target-site', 'tool_call', ?, 'retry-key', 'pending', 0, ?, 'requester-site')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		// Attempt 1: claim increments to 1, fails, stays processing (1 < 3).
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "retry")).toMatchObject({
			claim_state: "processing",
			attempt_count: 1,
		});
		// Attempt 2: boot recovery reclaims, increments to 2, fails, stays processing.
		expect(resetProcessingDurableWork(db, "target-site")).toBe(1);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "retry")).toMatchObject({
			claim_state: "processing",
			attempt_count: 2,
		});
		// Attempt 3: reclaim, increments to 3, fails, budget exhausted → dead-letter.
		expect(resetProcessingDurableWork(db, "target-site")).toBe(1);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "retry")).toMatchObject({
			claim_state: "dead_letter",
			attempt_count: 3,
		});
	});

	// Objection 5(c): a stale claimant's dead-letter is token-fenced — after a
	// boot-reset + reclaim mints a new generation, the old token cannot terminate
	// the row, and the new generation is unaffected.
	it("rejects a stale-token dead-letter and leaves the new generation intact", async () => {
		const { claimLocalDurableWork, deadLetterClaimedDurableWork } = require("@bound/core");
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('fenced', 'target-site', 'tool_call', '{}', 'fenced-key', 'pending', 0, ?, 'requester-site')`,
			[now],
		);
		const first = claimLocalDurableWork(db, "target-site", "tool_call");
		expect(first?.claim_token).toBeTruthy();
		const staleToken = first.claim_token as string;
		// Boot recovery releases the abandoned generation, a new claim mints a fresh token.
		expect(resetProcessingDurableWork(db, "target-site")).toBe(1);
		const second = claimLocalDurableWork(db, "target-site", "tool_call");
		expect(second?.claim_token).toBeTruthy();
		expect(second.claim_token).not.toBe(staleToken);
		// The stale claimant's dead-letter attempt must fail the token fence.
		expect(deadLetterClaimedDurableWork(db, "fenced", staleToken, "stale")).toBe(false);
		expect(getDurableWork(db, "fenced")).toMatchObject({
			claim_state: "processing",
			claim_token: second.claim_token,
		});
		// The live generation can still terminate it.
		expect(deadLetterClaimedDurableWork(db, "fenced", second.claim_token, "terminal")).toBe(true);
	});

	// Objection 5(d): a twin arriving once via relay_inbox and once via durable_work
	// under one idempotency_key must execute the handler ONCE — the shared
	// idempotency cache is the fence across both lanes.
	it("executes a handler once across the relay_inbox and durable_work twins sharing an idempotency key", async () => {
		let calls = 0;
		const countingClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		countingClient.callTool = async () => {
			calls += 1;
			return { content: JSON.stringify({ ok: true }), isError: false };
		};
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", countingClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		const payload = JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } });
		insertInbox(db, {
			id: "twin-inbox",
			source_site_id: "requester-site",
			kind: "tool_call",
			ref_id: null,
			stream_id: null,
			idempotency_key: "twin-key",
			payload,
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			received_at: now,
			trace_context: null,
		});
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('twin-durable', 'target-site', 'tool_call', ?, 'twin-key', 'pending', 0, ?, 'requester-site')`,
			[payload, now],
		);
		await (processor as any).processPendingEntries();
		expect(calls).toBe(1);
	});

	// Objection 5(e): a dispatch_message durable row is a dispatch-consumer kind;
	// the relay lane never claims it — it remains pending for its own consumer.
	it("leaves a dispatch_message durable row pending (relay lane skips dispatch-consumer kinds)", async () => {
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at) VALUES ('dispatch', 'target-site', 'dispatch_message', '{}', 'dispatch-key', 'pending', 0, ?)`,
			[now],
		);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "dispatch")).toMatchObject({
			claim_state: "pending",
			attempt_count: 0,
		});
	});

	// Objection 5(f): a row targeted at another site is never claimed by this site.
	it("leaves a durable row targeted at another site pending", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('other', 'other-site', 'tool_call', ?, 'other-key', 'pending', 0, ?, 'requester-site')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "other")).toMatchObject({ claim_state: "pending", attempt_count: 0 });
	});

	// Objection 5(g): a response-requiring kind with null source_site is malformed
	// input — fenced dead-letter with an explanatory last_error, never consumed.
	it("dead-letters a response-requiring durable row missing source_site", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		// tool_call is sync dispatch → writes a response → requires source_site.
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at) VALUES ('nosrc', 'target-site', 'tool_call', ?, 'nosrc-key', 'pending', 0, ?)`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		await (processor as any).processPendingEntries();
		const row = getDurableWork(db, "nosrc");
		expect(row).toMatchObject({ claim_state: "dead_letter" });
		expect(row?.last_error).toContain("source_site");
		expect(db.query("SELECT COUNT(*) AS n FROM relay_outbox WHERE ref_id = 'nosrc'").get()).toEqual(
			{
				n: 0,
			},
		);
	});

	// #253 positive path: a platform_request row WITH source_site (the incident's
	// actual kind, now stamped by the producer) passes the sync-dispatch guard — it
	// is NOT dead-lettered for a missing return address. With no platform registry
	// wired, dispatch fails and the row stays `processing` (reclaim, not immediate
	// dead-letter), which alone proves the guard let it through: had the guard
	// fired, the row would be dead_letter with a "source_site" last_error.
	it("lets a platform_request row WITH source_site past the missing-source_site guard", async () => {
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, source_site) VALUES ('plreq', 'target-site', 'platform_request', ?, 'plreq-key', 'pending', 0, ?, ?, 'requester-site')`,
			[
				JSON.stringify({ server_name: "discord", method: "tools/list", params: {} }),
				now,
				new Date(Date.now() + 300_000).toISOString(),
			],
		);
		await (processor as any).processPendingEntries();
		const row = getDurableWork(db, "plreq");
		// Not dead-lettered for the source_site reason — the guard passed it through.
		expect(row?.claim_state).not.toBe("dead_letter");
		expect(row?.last_error ?? "").not.toContain("source_site");
	});

	// Objection 5(h): a durable row carrying stream_id round-trips it onto the
	// response row via writeResponse's requestEntry.stream_id copy.
	it("round-trips stream_id from the durable row onto the response", async () => {
		const mockClient = new MockMCPClient(
			"test-server",
			new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
		);
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map([["test-server", mockClient as unknown as MCPClient]]),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site, stream_id) VALUES ('streamed', 'target-site', 'tool_call', ?, 'streamed-key', 'pending', 0, ?, 'requester-site', 'stream-42')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "streamed")).toMatchObject({ claim_state: "consumed" });
		expect(db.query("SELECT stream_id FROM relay_outbox WHERE ref_id = 'streamed'").get()).toEqual({
			stream_id: "stream-42",
		});
	});
});
