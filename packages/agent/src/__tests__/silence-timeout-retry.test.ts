import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import {
	AgentLoop,
	MAX_FIRST_CHUNK_RETRIES,
	MAX_SILENCE_RETRIES,
	SILENCE_TIMEOUT_MS,
} from "../agent-loop";

/**
 * LLM backend that throws silence timeout errors N times, then succeeds.
 */
class SilenceTimeoutBackend implements LLMBackend {
	private callCount = 0;
	constructor(private failCount: number) {}

	getCallCount() {
		return this.callCount;
	}

	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		if (this.callCount <= this.failCount) {
			// Simulate what withSilenceTimeout throws
			throw new Error(`LLM silence timeout: no chunk received for ${SILENCE_TIMEOUT_MS}ms`);
		}
		yield { type: "text" as const, content: "Success after retries!" };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
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
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

function createMockSandbox() {
	return {
		exec: async (_cmd: string) => ({
			stdout: "mock output",
			stderr: "",
			exitCode: 0,
		}),
	};
}

describe("Silence timeout retry", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "timeout-retry-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	it("should export SILENCE_TIMEOUT_MS as 60000", () => {
		expect(SILENCE_TIMEOUT_MS).toBe(60_000);
	});

	it("should export MAX_SILENCE_RETRIES as 10", () => {
		expect(MAX_SILENCE_RETRIES).toBe(10);
	});

	it("should retry on silence timeout and succeed if next attempt works", async () => {
		// Fail once, then succeed on second call
		const backend = new SilenceTimeoutBackend(1);

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		// Should succeed — no error
		expect(result.error).toBeUndefined();
		// Backend was called twice: one failure + one success
		expect(backend.getCallCount()).toBe(2);

		// Should have persisted the successful response
		const msgs = db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'assistant'")
			.all(threadId) as Array<{ role: string; content: string }>;
		expect(msgs.length).toBe(1);
		expect(msgs[0].content).toBe("Success after retries!");

		// No alert should have been persisted (retry succeeded)
		const alerts = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ content: string }>;
		expect(alerts.length).toBe(0);
	});

	it("should retry up to MAX_FIRST_CHUNK_RETRIES before succeeding", async () => {
		// Fail MAX_FIRST_CHUNK_RETRIES times (within first-chunk cap), then succeed
		const backend = new SilenceTimeoutBackend(MAX_FIRST_CHUNK_RETRIES);

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.getCallCount()).toBe(MAX_FIRST_CHUNK_RETRIES + 1); // failures + 1 success
	});

	it("should fail after exhausting first-chunk retries", async () => {
		// Fail more than MAX_FIRST_CHUNK_RETRIES times (all first-chunk timeouts)
		const backend = new SilenceTimeoutBackend(MAX_FIRST_CHUNK_RETRIES + 2);

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		// Should have an error
		expect(result.error).toBeDefined();
		expect(result.error).toContain("silence timeout");

		// Backend was called MAX_FIRST_CHUNK_RETRIES + 1 times (initial + capped retries)
		expect(backend.getCallCount()).toBe(MAX_FIRST_CHUNK_RETRIES + 1);

		// Alert should be persisted
		const alerts = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ content: string }>;
		expect(alerts.length).toBe(1);
		expect(alerts[0].content).toContain("silence timeout");
	});

	it("should export MAX_FIRST_CHUNK_RETRIES as 2", () => {
		expect(MAX_FIRST_CHUNK_RETRIES).toBe(2);
	});

	it("should cap retries at MAX_FIRST_CHUNK_RETRIES when no chunks were received", async () => {
		// SilenceTimeoutBackend throws before yielding any chunks (first-chunk timeout).
		// With MAX_FIRST_CHUNK_RETRIES = 2, it should only try 3 times total (1 initial + 2 retries).
		const backend = new SilenceTimeoutBackend(MAX_FIRST_CHUNK_RETRIES + 2); // more fails than retries allow
		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		expect(result.error).toBeDefined();
		expect(result.error).toContain("silence timeout");
		// Should only call backend MAX_FIRST_CHUNK_RETRIES + 1 times (initial + capped retries)
		expect(backend.getCallCount()).toBe(MAX_FIRST_CHUNK_RETRIES + 1);
	});

	it("should not retry on non-transient errors", async () => {
		const backend: LLMBackend = {
			// biome-ignore lint/correctness/useYield: throws before yield
			async *chat() {
				throw new Error("A conversation must start with a user message");
			},
			capabilities() {
				return {
					streaming: true,
					tool_use: true,
					system_prompt: true,
					prompt_caching: false,
					vision: false,
					max_context: 8000,
				};
			},
		};

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		// Should fail immediately without retry
		expect(result.error).toBeDefined();
		expect(result.error).toContain("must start with a user message");

		// Alert persisted
		const alerts = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ content: string }>;
		expect(alerts.length).toBe(1);
	});
});

/**
 * LLM backend that throws transport errors N times, then succeeds.
 */
class TransportErrorBackend implements LLMBackend {
	private callCount = 0;
	constructor(private failCount: number) {}

	getCallCount() {
		return this.callCount;
	}

	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		if (this.callCount <= this.failCount) {
			throw new Error(
				"Bedrock request failed: Unexpected error: http2 request did not get a response",
			);
		}
		yield { type: "text" as const, content: "Success after transport retry!" };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
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

describe("Transport error retry", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "transport-retry-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus: { on: () => {}, off: () => {}, emit: () => {} },
			hostName: "test-host",
			siteId: "test-site-id",
		} as unknown as AppContext;
	}

	it("should retry on http2 transport errors and succeed", async () => {
		// Fail once with transport error, then succeed
		const backend = new TransportErrorBackend(1);

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		expect(result.error).toBeUndefined();
		expect(backend.getCallCount()).toBe(2);

		// No alert should exist (retry succeeded)
		const alerts = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ content: string }>;
		expect(alerts.length).toBe(0);
	});

	it("should fail after exhausting transport retries", async () => {
		// Fail more times than MAX_SILENCE_RETRIES
		const backend = new TransportErrorBackend(MAX_SILENCE_RETRIES + 1);

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		expect(result.error).toBeDefined();
		expect(result.error).toContain("http2");

		const alerts = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'alert'")
			.all(threadId) as Array<{ content: string }>;
		expect(alerts.length).toBe(1);
	});

	it("should NOT retry on 'not valid JSON' Bedrock errors (client 400, not transient)", async () => {
		// "not valid JSON" is a 400 client error — the request body is malformed.
		// Retrying the same malformed body is pointless.
		const backend = new InvalidJsonErrorBackend(1);

		const loop = new AgentLoop(makeCtx(), createMockSandbox(), createMockRouter(backend), {
			threadId,
			userId: "test-user",
		});

		const result = await loop.run();

		expect(result.error).toBeDefined();
		expect(result.error).toContain("not valid JSON");
		expect(backend.getCallCount()).toBe(1); // NOT retried
	});
});

/**
 * LLM backend that throws "not valid JSON" errors N times, then succeeds.
 * Used to verify non-transient errors are NOT retried.
 */
class InvalidJsonErrorBackend implements LLMBackend {
	private callCount = 0;
	constructor(private failCount: number) {}

	getCallCount() {
		return this.callCount;
	}

	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		if (this.callCount <= this.failCount) {
			throw new Error(
				"Bedrock request failed: The model returned the following errors: The request body is not valid JSON.",
			);
		}
		yield { type: "text" as const, content: "Success after body corruption retry!" };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
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
