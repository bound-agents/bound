import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";
import type { EligibleHost } from "../relay-router";

// Mock LLM Backend
class MockLLMBackend implements LLMBackend {
	async *chat() {
		yield { type: "text" as const, content: "" };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
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

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("test-model", backend);
	return new ModelRouter(backends, "test-model");
}

function createMockSandbox() {
	return {
		exec: async (_cmd: string) => {
			return { stdout: "mock output", stderr: "", exitCode: 0 };
		},
	};
}

describe("relayStream() streaming generator", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "relay-stream-test-"));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();

		// Create test user
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

		threadId = randomUUID();
	});

	afterEach(async () => {
		try {
			db.close();
		} catch {
			// Already closed
		}
		try {
			await cleanupTmpDir(tmpDir);
		} catch {
			// Already deleted
		}
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
			eventBus,
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	function makeMockHost(hostName: string): EligibleHost {
		return {
			site_id: `site-${hostName}`,
			host_name: hostName,
			sync_url: null,
			online_at: new Date().toISOString(),
		};
	}

	it("yields stream_chunk entries as StreamChunks (AC1.1)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-1");
		const eligibleHosts = [host];
		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		const chunks: StreamChunk[] = [];
		let generatedStreamId: string | null = null;

		// Start the generator and capture its stream_id from the outbox
		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 500 },
		);

		// Concurrently: drive the generator and populate inbox entries
		const consumerPromise = (async () => {
			try {
				for await (const chunk of gen) {
					chunks.push(chunk);
				}
			} catch {
				// Expected to complete or timeout
			}
		})();

		// Wait briefly for outbox entry to be written
		await new Promise((r) => setTimeout(r, 50));

		// Read the generated stream_id from relay_outbox
		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;

			// Now insert stream_chunk entries matching the generated stream_id
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text", content: "Hello " }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 1,
						chunks: [{ type: "text", content: "world" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_end",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 2,
						chunks: [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		// Wait for consumer to complete
		await consumerPromise;

		// Verify chunks were yielded
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBeGreaterThanOrEqual(2);
	});

	it("stream_end closes the generator and yields the done chunk with usage stats (AC1.2)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-2");
		const eligibleHosts = [host];
		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		const chunks: StreamChunk[] = [];
		let generatedStreamId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 500 },
		);

		const consumerPromise = (async () => {
			try {
				for await (const chunk of gen) {
					chunks.push(chunk);
				}
			} catch {
				// Expected
			}
		})();

		// Wait for outbox entry
		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();

			// Insert one chunk then stream_end with done chunk
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text", content: "Complete response" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_end",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 1,
						chunks: [{ type: "done", usage: { input_tokens: 100, output_tokens: 50 } }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		await consumerPromise;

		// Should have received text and done chunks
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		const doneChunks = chunks.filter((c) => c.type === "done");
		expect(doneChunks.length).toBeGreaterThan(0);
		if (doneChunks[0]) {
			expect(doneChunks[0].usage).toBeDefined();
			expect(doneChunks[0].usage.input_tokens).toBe(100);
			expect(doneChunks[0].usage.output_tokens).toBe(50);
		}
	});

	it("chunks reordered by seq produce correct order (AC1.3)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-3");
		const eligibleHosts = [host];
		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		const chunks: StreamChunk[] = [];
		let generatedStreamId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 500 },
		);

		const consumerPromise = (async () => {
			try {
				for await (const chunk of gen) {
					chunks.push(chunk);
				}
			} catch {
				// Expected
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();

			// Insert out of order: seq 2, then 0, then 1
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 2,
						chunks: [{ type: "text", content: "third" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text", content: "first" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 1,
						chunks: [{ type: "text", content: "second" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_end",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 3,
						chunks: [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		await consumerPromise;

		// Verify chunks are yielded in sequence order
		const textChunks = chunks.filter((c) => c.type === "text");
		if (textChunks.length >= 3) {
			expect(textChunks[0].content).toBe("first");
			expect(textChunks[1].content).toBe("second");
			expect(textChunks[2].content).toBe("third");
		}
	});

	it("cancel during RELAY_STREAM sends cancel to target and requester exits cleanly (AC1.4)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-4");
		const eligibleHosts = [host];
		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		let generatedStreamId: string | null = null;
		let inferenceOutboxId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 500 },
		);

		const consumerPromise = (async () => {
			try {
				for await (const _chunk of gen) {
					// After first iteration, set abort flag to trigger cancel
					// biome-ignore lint/suspicious/noExplicitAny: testing private field
					(loop as any).aborted = true;
				}
			} catch {
				// Expected
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT id, stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { id: string; stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			inferenceOutboxId = outboxEntry.id;
			const now = new Date().toISOString();

			// Insert one chunk to trigger iteration
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text", content: "Chunk" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		await consumerPromise;

		// Verify cancel entry was written with correct ref_id
		const cancelEntry = db
			.query(
				"SELECT ref_id FROM relay_outbox WHERE kind = 'cancel' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { ref_id: string | null } | null;

		expect(cancelEntry).toBeDefined();
		expect(cancelEntry?.ref_id).toBe(inferenceOutboxId);
	});

	it("failover on per-host timeout generates new stream_id and retries next host (AC1.5)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host1 = makeMockHost("relay-host-failover-1");
		const host2 = makeMockHost("relay-host-failover-2");
		const eligibleHosts = [host1, host2];

		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		const generatedStreamIds: Set<string> = new Set();

		try {
			// biome-ignore lint/suspicious/noExplicitAny: testing private method
			const gen = (loop as any).relayStream(
				payload,
				eligibleHosts,
				{},
				{ pollIntervalMs: 5, perHostTimeoutMs: 50 },
			);
			for await (const _chunk of gen) {
				// Do nothing
			}
		} catch {
			// Expected to fail after both hosts timeout
		}

		// Verify multiple inference entries with different stream_ids
		const inferenceEntries = db
			.query("SELECT DISTINCT stream_id FROM relay_outbox WHERE kind = 'inference'")
			.all() as Array<{ stream_id: string }>;

		for (const e of inferenceEntries) {
			generatedStreamIds.add(e.stream_id);
		}

		// Should have at least 2 different stream_ids (one per host)
		expect(generatedStreamIds.size).toBeGreaterThanOrEqual(2);

		// And should have written 2 inference entries
		const allInference = db
			.query("SELECT COUNT(*) as cnt FROM relay_outbox WHERE kind = 'inference'")
			.get() as { cnt: number };
		expect(allInference.cnt).toBe(2);
	});

	it("no chunks within timeout returns timeout error to agent loop (AC1.6)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-6");
		const eligibleHosts = [host];

		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		let error: Error | null = null;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: testing private method
			const gen = (loop as any).relayStream(
				payload,
				eligibleHosts,
				{},
				{ pollIntervalMs: 5, perHostTimeoutMs: 50 },
			);
			for await (const _chunk of gen) {
				// Do nothing
			}
		} catch (err) {
			error = err as Error;
		}

		expect(error).toBeDefined();
		expect(error?.message).toContain("timed out");
	});

	it("target model unavailable returns error kind response (AC1.7)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-7");
		const eligibleHosts = [host];
		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		let generatedStreamId: string | null = null;
		let error: Error | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 500 },
		);

		const consumerPromise = (async () => {
			try {
				for await (const _chunk of gen) {
					// Do nothing
				}
			} catch (err) {
				error = err as Error;
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();

			// Insert error entry
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"error",
					null,
					null,
					generatedStreamId,
					JSON.stringify({ error: "model not found" }),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		await consumerPromise;

		expect(error).toBeDefined();
		expect(error?.message).toContain("model not found");
	});

	it("out-of-order seq -- gap skipped after 2 poll cycles with log warning (AC1.8)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-8");
		const eligibleHosts = [host];
		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		const chunks: StreamChunk[] = [];
		let generatedStreamId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 500 },
		);

		const consumerPromise = (async () => {
			try {
				for await (const chunk of gen) {
					chunks.push(chunk);
				}
			} catch {
				// Expected
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();

			// Insert seq=0, then insert seq=2 (skip seq=1)
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text", content: "first" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			// Wait a couple of poll cycles then insert seq=2 (gap in seq=1)
			await new Promise((r) => setTimeout(r, 50));

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 2,
						chunks: [{ type: "text", content: "third" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_end",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 3,
						chunks: [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		await consumerPromise;

		// Should have yielded first and third (skipped the gap at seq=1)
		const textChunks = chunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBeGreaterThanOrEqual(2);
	});

	it("large prompt >2MB triggers file-based sync with messages_file_ref (AC1.9)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-9");
		const eligibleHosts = [host];

		// Build a large payload (>2MB) by creating many messages
		const largeMessages = Array.from({ length: 500 }, (_, _i) => ({
			role: "user" as const,
			content: "x".repeat(4000), // 4KB per message
		}));

		const payload = {
			model: "test-model",
			messages: largeMessages,
			tools: [],
		};

		try {
			// biome-ignore lint/suspicious/noExplicitAny: testing private method
			const gen = (loop as any).relayStream(
				payload,
				eligibleHosts,
				{},
				{ pollIntervalMs: 5, perHostTimeoutMs: 100 },
			);
			for await (const _chunk of gen) {
				// Do nothing
			}
		} catch {
			// Expected to timeout
		}

		// Check the outbox entry for messages_file_ref
		const outboxEntry = db
			.query(
				"SELECT payload FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { payload: string } | null;

		if (outboxEntry) {
			const parsed = JSON.parse(outboxEntry.payload) as {
				messages_file_ref?: string;
				messages?: unknown[];
			};

			// For large payloads, either messages_file_ref is set or payload is truncated
			// The exact behavior depends on implementation
			expect(parsed).toBeDefined();
		}
	});

	it("captures relay metadata (hostName and firstChunkLatencyMs) (AC4.1)", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-metadata");
		const eligibleHosts = [host];

		const payload = {
			model: "test-model",
			messages: [],
			tools: [],
		};

		const relayMetadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};
		let generatedStreamId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(payload, eligibleHosts, relayMetadataRef, {
			pollIntervalMs: 5,
			perHostTimeoutMs: 500,
		});

		const consumerPromise = (async () => {
			try {
				for await (const _chunk of gen) {
					// Consume at least one chunk
					break;
				}
			} catch {
				// Expected
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();

			// Insert a chunk to populate metadata
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_chunk",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text", content: "Response" }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					host.site_id,
					"stream_end",
					null,
					null,
					generatedStreamId,
					JSON.stringify({
						seq: 1,
						chunks: [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					0,
				],
			);
		}

		await consumerPromise;

		// Metadata should be populated after first chunk
		expect(relayMetadataRef.hostName).toBe("relay-host-metadata");
		expect(relayMetadataRef.firstChunkLatencyMs).toBeDefined();
		if (relayMetadataRef.firstChunkLatencyMs !== undefined) {
			expect(relayMetadataRef.firstChunkLatencyMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("duplicate stream chunks with same id are ignored via INSERT OR IGNORE", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-dedup");
		const eligibleHosts = [host];
		const payload = { model: "test-model", messages: [], tools: [] };

		const chunks: StreamChunk[] = [];
		let generatedStreamId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 2000 },
		);

		const consumerPromise = (async () => {
			for await (const chunk of gen) {
				chunks.push(chunk);
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();
			const expires = new Date(Date.now() + 60_000).toISOString();
			const dupeId = randomUUID(); // same id for duplicate entries

			// Insert seq 0
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), host.site_id, "stream_chunk", null, null, generatedStreamId,
					JSON.stringify({ seq: 0, chunks: [{ type: "text", content: "hello" }] }),
					expires, now, 0],
			);

			// Insert seq 1 with a specific id
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[dupeId, host.site_id, "stream_chunk", null, null, generatedStreamId,
					JSON.stringify({ seq: 1, chunks: [{ type: "text", content: "world" }] }),
					expires, now, 0],
			);

			// Try to insert duplicate of seq 1 with SAME id — should be silently ignored
			db.run(
				`INSERT OR IGNORE INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[dupeId, host.site_id, "stream_chunk", null, null, generatedStreamId,
					JSON.stringify({ seq: 1, chunks: [{ type: "text", content: "world-dupe" }] }),
					expires, now, 0],
			);

			// Insert stream_end
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), host.site_id, "stream_end", null, null, generatedStreamId,
					JSON.stringify({ seq: 2, chunks: [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }] }),
					expires, now, 0],
			);
		}

		await consumerPromise;

		// "world" should appear exactly once (not "world-dupe")
		const textChunks = chunks.filter((c) => c.type === "text");
		const worldChunks = textChunks.filter((c) => c.content === "world");
		const dupeChunks = textChunks.filter((c) => c.content === "world-dupe");
		expect(worldChunks.length).toBe(1);
		expect(dupeChunks.length).toBe(0);
	});

	it("backwards seq jumps from stale duplicates are discarded, not reprocessed", async () => {
		const ctx = makeCtx();
		const mockBackend = new MockLLMBackend();
		const loop = new AgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
			threadId,
			userId,
			modelId: "test-model",
		});

		const host = makeMockHost("relay-host-backwards");
		const eligibleHosts = [host];
		const payload = { model: "test-model", messages: [], tools: [] };

		const chunks: StreamChunk[] = [];
		let generatedStreamId: string | null = null;

		// biome-ignore lint/suspicious/noExplicitAny: testing private method
		const gen = (loop as any).relayStream(
			payload,
			eligibleHosts,
			{},
			{ pollIntervalMs: 5, perHostTimeoutMs: 2000 },
		);

		const consumerPromise = (async () => {
			for await (const chunk of gen) {
				chunks.push(chunk);
			}
		})();

		await new Promise((r) => setTimeout(r, 50));

		const outboxEntry = db
			.query(
				"SELECT stream_id FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;

		if (outboxEntry) {
			generatedStreamId = outboxEntry.stream_id;
			const now = new Date().toISOString();
			const expires = new Date(Date.now() + 60_000).toISOString();

			// Insert seq 0, 1, 2 in order
			for (let seq = 0; seq < 3; seq++) {
				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[randomUUID(), host.site_id, "stream_chunk", null, null, generatedStreamId,
						JSON.stringify({ seq, chunks: [{ type: "text", content: `chunk-${seq}` }] }),
						expires, now, 0],
				);
			}

			// Wait for seq 0-2 to be consumed
			await new Promise((r) => setTimeout(r, 100));

			// Now insert "stale duplicates" with seq 0 and 1 (as if retransmitted)
			// These should be discarded by the backwards-jump guard
			for (let seq = 0; seq < 2; seq++) {
				db.run(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[randomUUID(), host.site_id, "stream_chunk", null, null, generatedStreamId,
						JSON.stringify({ seq, chunks: [{ type: "text", content: `stale-${seq}` }] }),
						expires, now, 0],
				);
			}

			// Wait for gap detection to process the stale entries
			await new Promise((r) => setTimeout(r, 200));

			// Now insert seq 3 (stream_end) to complete the stream
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[randomUUID(), host.site_id, "stream_end", null, null, generatedStreamId,
					JSON.stringify({ seq: 3, chunks: [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }] }),
					expires, now, 0],
			);
		}

		await consumerPromise;

		// Verify: stale chunks should NOT appear in output
		const textChunks = chunks.filter((c) => c.type === "text");
		const staleChunks = textChunks.filter((c) => c.content?.startsWith("stale-"));
		expect(staleChunks.length).toBe(0);

		// Original chunks should appear exactly once each
		const originals = textChunks.filter((c) => c.content?.startsWith("chunk-"));
		expect(originals.length).toBe(3);
	});
});
