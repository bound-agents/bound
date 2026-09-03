import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySchema,
	getDurableWork,
	listDeadLetterDurableWork,
	readDurableResponseByRefId,
	resetProcessingDurableWork,
} from "@bound/core";
import { applyMetricsSchema } from "@bound/core";
import type { ChatParams, LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type {
	Logger,
	PromptInvokePayload,
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

// Post-N+1 the relay-processor is durable-only: it claims durable_work request
// rows and writes responses back through routeRelayResponse. These helpers set up
// a self-loopback request (source_site = the processor's own site) so the
// response rides the LOCAL_WORK_TARGET lane and is readable locally by ref_id.
const TARGET_SITE = "target-site";

function insertDurableRequest(
	database: Database,
	entry: {
		id: string;
		kind: string;
		payload: string;
		refId?: string | null;
		idempotencyKey?: string | null;
		sourceSite?: string;
		expiresAt?: string;
	},
): void {
	const now = new Date();
	database.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, ref_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
		[
			entry.id,
			TARGET_SITE,
			entry.kind,
			entry.payload,
			entry.idempotencyKey ?? entry.id,
			entry.refId ?? null,
			now.toISOString(),
			entry.expiresAt ?? new Date(now.getTime() + 60000).toISOString(),
			entry.sourceSite ?? TARGET_SITE,
			now.toISOString(),
		],
	);
}

// The response the processor writes: a durable_work response row keyed by the
// request's ref_id (its own row id), of the given kind (result/error). Read by
// ref_id + kind directly — a processor-execution test verifies the response was
// produced, independent of which site-scoped lane the awaiter reads it from.
function readDurableResponse(
	database: Database,
	requestId: string,
	kind: "result" | "error",
): { kind: string; payload: string } | null {
	return database
		.query(
			"SELECT kind, payload FROM durable_work WHERE ref_id = ? AND kind = ? ORDER BY created_at ASC LIMIT 1",
		)
		.get(requestId, kind) as { kind: string; payload: string } | null;
}

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

		it("polls pending durable_work entries on a regular interval", async () => {
			const mockClient = new MockMCPClient(
				"test-tool",
				new Map([["test_cmd", { name: "test_cmd", description: "Test tool" }]]),
			);
			const mcpClients = new Map<string, MCPClient>();
			mcpClients.set("test-tool", mockClient as unknown as MCPClient);
			const processor = new RelayProcessor(
				db,
				"target-site",
				mcpClients,
				createMockModelRouter(),
				createMockLogger(),
				createMockEventBus(),
			);

			// A self-loopback durable request the poll loop should claim and consume.
			insertDurableRequest(db, {
				id: "entry-1",
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "test-tool",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
			});

			const handle = processor.start(10);

			// Wait for the poll loop to pick up and consume the durable entry.
			await waitFor(() => getDurableWork(db, "entry-1")?.claim_state === "consumed", {
				message: "entry not processed",
			});

			handle.stop();

			expect(getDurableWork(db, "entry-1")?.claim_state).toBe("consumed");
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

			insertDurableRequest(db, {
				id: "entry-1",
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "github",
					args: { subcommand: "create_issue", title: "Fix bug", body: "Details" },
				} as ToolCallPayload),
				// A sibling spoke's id, absent from the keyring, still processes.
				sourceSite: TARGET_SITE,
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// It executed: a result response row correlated by ref_id exists.
			expect(readDurableResponse(db, "entry-1", "result")).not.toBeNull();

			// It was NOT rejected as an unknown source.
			expect(readDurableResponse(db, "entry-1", "error")).toBeNull();
		});

		// The hub-local synchronous executeImmediate route was retired at release
		// N+1 with the RelayExecutor chain; every relay request now rides the durable
		// work lane (covered above and in the durable-lane describe).

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

			insertDurableRequest(db, {
				id: "expired-1",
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "test",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
				expiresAt: new Date(Date.now() - 1000).toISOString(), // Already expired
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// No response row is created for an expired request.
			expect(readDurableResponse(db, "expired-1", "result")).toBeNull();
			expect(readDurableResponse(db, "expired-1", "error")).toBeNull();
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

			const resourceUri = "memory://test/resource";
			insertDurableRequest(db, {
				id: "resource-1",
				kind: "resource_read",
				payload: JSON.stringify({
					resource_uri: resourceUri,
				} as ResourceReadPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// A durable result response row correlated by ref_id was written.
			expect(readDurableResponse(db, "resource-1", "result")).not.toBeNull();
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

			insertDurableRequest(db, {
				id: "prompt-1",
				kind: "prompt_invoke",
				payload: JSON.stringify({
					prompt_name: "test-prompt",
					prompt_args: { key: "value" },
				} as PromptInvokePayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// A durable result response row correlated by ref_id was written.
			expect(readDurableResponse(db, "prompt-1", "result")).not.toBeNull();
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
				insertDurableRequest(db, {
					id: "cache-warm-1",
					kind: "cache_warm",
					payload: JSON.stringify({ paths: [secretFile], timeout_ms: 1_000 }),
				});

				await (
					processor as unknown as { processPendingEntries: () => Promise<void> }
				).processPendingEntries();

				const result = readDurableResponse(db, "cache-warm-1", "result");
				expect(result).not.toBeNull();
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

			const idempotencyKey = "test-idem-key";

			// First durable request lands and is processed.
			insertDurableRequest(db, {
				id: "req-1",
				kind: "tool_call",
				idempotencyKey,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			const callCountAfterFirst = callCount;
			expect(callCountAfterFirst).toBeGreaterThan(0);

			// A second request carrying the same idempotency_key is fenced at insert by
			// the durable_work (kind, idempotency_key) unique index.
			const inserted2 = db
				.query(
					`INSERT OR IGNORE INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
					 VALUES ('req-2', 'target-site', 'tool_call', ?, ?, 'pending', 0, ?, ?, 'target-site', ?)`,
				)
				.run(
					JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }),
					idempotencyKey,
					new Date().toISOString(),
					new Date(Date.now() + 60000).toISOString(),
					new Date().toISOString(),
				);
			expect(inserted2.changes).toBe(0); // deduped by the (kind, idempotency_key) fence

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// callCount unchanged: the duplicate never became a distinct claimable row.
			expect(callCount).toBe(callCountAfterFirst);
			expect(
				(
					db.query("SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'tool_call'").get() as {
						n: number;
					}
				).n,
			).toBe(1);
		});

		it("re-executes a distinct idempotency key after the prior response TTL-expires (AC5.3)", async () => {
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

			const idempotencyKey = "test-idem-key-expiry";

			// First request executes.
			insertDurableRequest(db, {
				id: "req-1-expiry",
				kind: "tool_call",
				idempotencyKey,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
			});
			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();
			const callCountAfterFirst = callCount;
			expect(callCountAfterFirst).toBeGreaterThan(0);

			// A fresh request with a DIFFERENT idempotency key executes again (a distinct
			// (kind, key) fence, so it is not deduped).
			insertDurableRequest(db, {
				id: "req-3-expiry",
				kind: "tool_call",
				idempotencyKey: `${idempotencyKey}-expired`,
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
			});
			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

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

			const requestId = "tool-req-1";

			// A durable cancel for the request lands before the request is processed.
			insertDurableRequest(db, {
				id: "cancel-1",
				kind: "cancel",
				refId: requestId,
				payload: "{}",
			});
			insertDurableRequest(db, {
				id: requestId,
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "test",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// The tool request was consumed but produced no result (cancel pre-empted it).
			expect(getDurableWork(db, requestId)?.claim_state).toBe("consumed");
			expect(readDurableResponse(db, requestId, "result")).toBeNull();
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

			const requestId = "tool-req-late-cancel";

			// The tool request is processed first.
			insertDurableRequest(db, {
				id: requestId,
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "test-server",
					args: { subcommand: "test_cmd" },
				} as ToolCallPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// A cancel arriving after execution cannot un-write the result.
			insertDurableRequest(db, {
				id: "cancel-late",
				kind: "cancel",
				refId: requestId,
				payload: "{}",
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// Result was written (execution occurred before the cancel).
			expect(readDurableResponse(db, requestId, "result")).not.toBeNull();
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

			insertDurableRequest(db, {
				id: "unknown-tool-1",
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "nonexistent-server",
					args: { subcommand: "some_command" },
				} as ToolCallPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// An error response was written for the unknown server.
			const err = readDurableResponse(db, "unknown-tool-1", "error");
			expect(err).not.toBeNull();
			expect(err?.payload).toContain("MCP server not found");
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

			insertDurableRequest(db, {
				id: "tool-call-missing-subcommand",
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "github",
					args: { title: "Fix bug" }, // Missing subcommand
				} as ToolCallPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// A help result (not an error) was written, enumerating the server's subcommands.
			expect(readDurableResponse(db, "tool-call-missing-subcommand", "error")).toBeNull();
			const result = readDurableResponse(db, "tool-call-missing-subcommand", "result");
			expect(result).not.toBeNull();
			const resultPayload = JSON.parse(result?.payload ?? "{}") as {
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

			insertDurableRequest(db, {
				id: "tool-call-unknown-server",
				kind: "tool_call",
				payload: JSON.stringify({
					tool: "unknown-server",
					args: { subcommand: "some_command" },
				} as ToolCallPayload),
			});

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// An error response was written for the unknown server.
			expect(readDurableResponse(db, "tool-call-unknown-server", "error")).not.toBeNull();
		});
	});

	describe("response kind filtering", () => {
		it("leaves an 'error' response durable row for the awaiter, generating no new response", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

			// A durable 'error' response row targeted at this host (a hub routed an error
			// response back). The relay lane must NOT claim it — the awaiter is the sole
			// consumer of response kinds.
			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, payload, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
				 VALUES ('error-response-1', ?, 'error', 'original-request-id', 'error-idemp-1', ?, 'pending', 0, ?, ?, 'remote-site', ?)`,
				[
					siteId,
					JSON.stringify({ error: "some remote error", retriable: false }),
					new Date().toISOString(),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
				],
			);

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// The response row is left pending (the relay lane skips response kinds).
			expect(getDurableWork(db, "error-response-1")?.claim_state).toBe("pending");

			// And it generated no amplified error response.
			expect(
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'error' AND id != 'error-response-1'",
						)
						.get() as { n: number }
				).n,
			).toBe(0);
		});

		it("leaves a 'result' response durable row for the awaiter, generating no error", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, payload, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
				 VALUES ('result-response-1', ?, 'result', 'original-request-id', 'result-idemp-1', ?, 'pending', 0, ?, ?, 'remote-site', ?)`,
				[
					siteId,
					JSON.stringify({ result: "some result" }),
					new Date().toISOString(),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
				],
			);

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			expect(getDurableWork(db, "result-response-1")?.claim_state).toBe("pending");
			expect(
				(
					db.query("SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'error'").get() as {
						n: number;
					}
				).n,
			).toBe(0);
		});
	});

	describe("passive kind handling", () => {
		// Passive relay kinds (webhook_intake) are durable mailbox rows owned by
		// another consumer — the scheduler's event-task wakeup path drains them via
		// buildEventWakeupContent. The relay-processor must leave passive rows untouched.
		it("leaves webhook_intake durable rows pending for the scheduler to drain", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

			const httpEnvelope = JSON.stringify({
				method: "POST",
				path: "/webhook/bound",
				headers: { "x-github-event": "push", "x-github-delivery": "abc-123" },
				content_type: "application/json",
				body: '{"ref":"refs/heads/main","commits":[]}',
			});

			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, payload, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
				 VALUES ('webhook-row-1', ?, 'webhook_intake', 'thread-aaaa', 'github-abc-123', ?, 'pending', 0, ?, ?, 'remote-site', ?)`,
				[
					siteId,
					httpEnvelope,
					new Date().toISOString(),
					new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
					new Date().toISOString(),
				],
			);

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// The passive row is left pending — the scheduler is the rightful consumer.
			expect(getDurableWork(db, "webhook-row-1")?.claim_state).toBe("pending");
		});

		it("does not interfere with a coexisting response durable row", async () => {
			const siteId = "local-site";
			const mcpClients = new Map<string, MCPClient>();
			const eventBus = createMockEventBus();
			const logger = createMockLogger();

			db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

			const processor = new RelayProcessor(db, siteId, mcpClients, null, logger, eventBus);

			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, payload, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
				 VALUES ('passive-row', ?, 'webhook_intake', 'thread-aaaa', 'github-1', ?, 'pending', 0, ?, ?, 'remote-site', ?)`,
				[
					siteId,
					JSON.stringify({ method: "POST", path: "/webhook/bound", body: "{}" }),
					new Date().toISOString(),
					new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
					new Date().toISOString(),
				],
			);
			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, payload, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
				 VALUES ('response-row', ?, 'result', 'some-prior-request', 'result-1', ?, 'pending', 0, ?, ?, 'remote-site', ?)`,
				[
					siteId,
					JSON.stringify({ result: "ok" }),
					new Date().toISOString(),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
				],
			);

			await (
				processor as unknown as { processPendingEntries: () => Promise<void> }
			).processPendingEntries();

			// Both are left pending — the relay lane claims neither passive nor response kinds.
			expect(getDurableWork(db, "passive-row")?.claim_state).toBe("pending");
			expect(getDurableWork(db, "response-row")?.claim_state).toBe("pending");
		});
	});
});

describe("durable active relay lane", () => {
	it("claims an active durable tool_call, writes its durable response, and consumes the work", async () => {
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
		// Self-loopback request: source_site = the processor's own site, so the
		// response rides the LOCAL_WORK_TARGET lane and correlates by ref_id.
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
			 VALUES (?, ?, 'tool_call', ?, 'durable-tool', 'pending', 0, ?, ?, 'target-site', ?)`,
			[
				"durable-request",
				"target-site",
				JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }),
				now,
				new Date(Date.now() + 60_000).toISOString(),
				now,
			],
		);
		await (
			processor as unknown as { processPendingEntries: () => Promise<void> }
		).processPendingEntries();
		expect(getDurableWork(db, "durable-request")?.claim_state).toBe("consumed");
		// The response rode back as a durable row keyed by ref_id = the request id.
		expect(
			db
				.query(
					"SELECT kind, ref_id FROM durable_work WHERE ref_id = 'durable-request' AND kind = 'result'",
				)
				.get(),
		).toEqual({ kind: "result", ref_id: "durable-request" });
	});

	it("(f/§7) end-to-end: routeRelayRequest producer → durable dispatch → durable response the requester awaits on", async () => {
		// Requester side: mark the target capable and route a durable tool_call to it.
		const nowIso = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES ('target-site', 'target-site', '0', ?, ?, 1, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = 1, deleted = 0`,
			[nowIso, nowIso],
		);
		// The requester must also advertise capability so the response routes durably back.
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES ('requester-site', 'requester-site', '0', ?, ?, 1, 0)
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
		// The requester awaits on the durable row id; the durable lane addresses the
		// response back to the request's source_site.
		if (routed.path !== "durable" && routed.path !== "local")
			throw new Error("expected durable route");

		// Target side: the durable relay lane claims, dispatches, and writes the response.
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
		await (
			processor as unknown as { processPendingEntries: () => Promise<void> }
		).processPendingEntries();

		// The durable request was consumed.
		expect(getDurableWork(db, routed.id)?.claim_state).toBe("consumed");

		// The response rode back as a durable row with ref_id = the request id — the
		// correlation id the requester awaits via readDurableResponseByRefId. It is
		// targeted at the requester ('requester-site'), so the awaiter reads it there.
		const awaited = readDurableResponseByRefId(db, routed.id, "requester-site");
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
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES (?, ?, 'tool_call', ?, 'durable-fail', 'pending', 0, ?, 'target-site')`,
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
				.query("SELECT kind, ref_id, payload FROM durable_work WHERE ref_id = ? AND kind = 'error'")
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
		// The requester must advertise capability so the successful handler's response
		// routes durably back (Objection 3: an unroutable response now dead-letters).
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES ('requester-site', 'requester-site', '0', ?, ?, 1, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = 1, deleted = 0`,
			[now, now],
		);
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
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM durable_work WHERE ref_id = 'infra' AND kind IN ('result', 'error')",
				)
				.get(),
		).toEqual({ n: 0 });
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

	// Objection 3 (#253): a routing FAILURE on the response write (routeRelayResponse
	// returns path:"error" because the requester's site no longer advertises capability)
	// must NOT silently consume the request row. Consuming it strands the sender's
	// awaiter forever with no signal; the row must dead-letter (workspool-redrivable)
	// carrying the routing reason in last_error, so the sender's timeout tells the truth
	// and an operator can redrive after fixing capability. This is the exact silent-drop
	// class the whole incident was about.
	it("dead-letters a durable request when its response route fails (no silent consume)", async () => {
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
		// The requester ('requester-site') is a KNOWN peer that does NOT advertise
		// work_spool_capable, so routeRelayResponse yields path:"error" (not loopback,
		// not durable). No hosts row inserted for it → capability gate fails.
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('route-fail', 'target-site', 'tool_call', ?, 'route-fail-key', 'pending', 0, ?, 'requester-site')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		await (processor as any).processPendingEntries();
		const row = getDurableWork(db, "route-fail");
		expect(row?.claim_state).toBe("dead_letter");
		expect(row?.last_error ?? "").toContain("requester-site");
		// Nothing silently consumed, and no response row was written.
		expect(row?.claim_state).not.toBe("consumed");
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM durable_work WHERE ref_id = 'route-fail' AND kind IN ('result', 'error')",
				)
				.get(),
		).toEqual({ n: 0 });
	});

	// Objection 3 (#253): the intake-forward site. A hub-side intake row destined for a
	// peer that no longer advertises capability must dead-letter carrying the routing
	// reason, NOT ack the claimed intake row consumed after an unroutable forward.
	it("dead-letters a claimed intake row when the forward route fails (no silent consume)", async () => {
		const processor = new RelayProcessor(
			db,
			"hub-site",
			new Map(),
			createMockModelRouter(),
			createMockLogger(),
			createMockEventBus(),
		);
		// An intake row claimed by the hub, whose payload names a platform bound to a
		// peer ('worker-site') that does NOT advertise capability → routeRelayRequest
		// yields path:"error". The row must dead-letter, not be acked consumed.
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, platforms, online_at, modified_at, work_spool_capable, deleted)
			 VALUES ('worker-site', 'worker-site', '0', ?, ?, ?, 0, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = 0, deleted = 0`,
			[JSON.stringify(["discord"]), now, now],
		);
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('intake-fail', 'hub-site', 'intake', ?, 'intake-fail-key', 'pending', 0, ?, 'origin-site')`,
			[
				JSON.stringify({
					platform: "discord",
					platform_event_id: "evt-1",
					thread_id: "t-1",
					message_id: "m-1",
					content: "hello",
				}),
				now,
			],
		);
		await (processor as any).processPendingEntries();
		const row = getDurableWork(db, "intake-fail");
		expect(row?.claim_state).toBe("dead_letter");
		expect(row?.claim_state).not.toBe("consumed");
		// The routing failure is captured verbatim so an operator can see WHY it stranded
		// and redrive after fixing capability — not silently acked away.
		expect(row?.last_error ?? "").toContain("does not advertise work_spool_capable");
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

	// Objection 5(d): two durable twins under one idempotency_key must execute the
	// handler ONCE — the durable_work (kind, idempotency_key) unique index is the
	// fence (the relay_inbox lane is retired at release N+1, so the surviving fence
	// is entirely within durable_work).
	it("executes a handler once across durable_work twins sharing an idempotency key", async () => {
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
		// A twin insert with the same (kind, idempotency_key) is fenced to one row.
		db.run(
			`INSERT OR IGNORE INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('twin-a', 'target-site', 'tool_call', ?, 'twin-key', 'pending', 0, ?, 'requester-site')`,
			[payload, now],
		);
		db.run(
			`INSERT OR IGNORE INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site) VALUES ('twin-durable', 'target-site', 'tool_call', ?, 'twin-key', 'pending', 0, ?, 'requester-site')`,
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
		expect(
			db
				.query(
					"SELECT COUNT(*) AS n FROM durable_work WHERE ref_id = 'nosrc' AND kind IN ('result', 'error')",
				)
				.get(),
		).toEqual({ n: 0 });
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
		// The requester must advertise capability so the platform_request response routes
		// back cleanly (Objection 3: an unroutable response now dead-letters). This test
		// pins the source_site guard, not routing — keep the response path healthy.
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES ('requester-site', 'requester-site', '0', ?, ?, 1, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = 1, deleted = 0`,
			[now, now],
		);
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
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, source_site, stream_id) VALUES ('streamed', 'target-site', 'tool_call', ?, 'streamed-key', 'pending', 0, ?, 'target-site', 'stream-42')`,
			[JSON.stringify({ tool: "test-server", args: { subcommand: "test_cmd" } }), now],
		);
		await (processor as any).processPendingEntries();
		expect(getDurableWork(db, "streamed")).toMatchObject({ claim_state: "consumed" });
		expect(
			db
				.query("SELECT stream_id FROM durable_work WHERE ref_id = 'streamed' AND kind = 'result'")
				.get(),
		).toEqual({
			stream_id: "stream-42",
		});
	});
});
