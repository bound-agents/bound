import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { Logger, RelayInboxEntry, RelayOutboxEntry } from "@bound/shared";
import { RelayProcessor } from "../relay-processor";

class MockBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	setTextResponse(text: string) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: text };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});
	}

	async *chat() {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
			yield { type: "done" as const, usage: { input_tokens: 0, output_tokens: 0 } };
		}
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: false,
			system_prompt: false,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

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

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-processor-inference-${testId}.db`;
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

describe("RelayProcessor - executeInference", () => {
	it("AC3.1: executes inference, writes stream_chunk and stream_end with monotonic seq", async () => {
		const mockBackend = new MockBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "x".repeat(5000) };
			yield { type: "text" as const, content: "final response" };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user" as const, content: "Hello" }],
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				inboxEntry.id,
				inboxEntry.source_site_id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.processed,
			],
		);

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		handle.stop();

		const chunks = db
			.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_chunk") as RelayOutboxEntry[];
		const ends = db
			.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_end") as RelayOutboxEntry[];

		expect(chunks.length).toBeGreaterThan(0);
		expect(ends.length).toBeGreaterThan(0);

		const allChunkPayloads = [...chunks, ...ends].map(
			(e) =>
				JSON.parse(e.payload) as {
					chunks: StreamChunk[];
					seq: number;
				},
		);

		const seqs = allChunkPayloads.map((p) => p.seq);
		expect(seqs[0]).toBe(0);
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBe(seqs[i - 1] + 1);
		}

		// AC4.3: Verify relay_cycles recorded for inference, stream_chunk, stream_end
		const cycles = db
			.query(
				"SELECT kind FROM relay_cycles WHERE kind IN ('inference', 'stream_chunk', 'stream_end')",
			)
			.all() as Array<{ kind: string }>;
		const cycleKinds = new Set(cycles.map((c) => c.kind));
		expect(cycleKinds.has("inference")).toBe(true);
		expect(cycleKinds.has("stream_chunk")).toBe(true);
		expect(cycleKinds.has("stream_end")).toBe(true);
	});

	it("AC3.2a: flushes at 200ms timer with pending chunks", async () => {
		const mockBackend = new MockBackend();

		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "small" };
			await new Promise((resolve) => setTimeout(resolve, 250));
			yield { type: "text" as const, content: "delayed" };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user" as const, content: "Hello" }],
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				inboxEntry.id,
				inboxEntry.source_site_id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.processed,
			],
		);

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 2500));
		handle.stop();

		const chunks = db
			.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_chunk") as RelayOutboxEntry[];

		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});

	it("AC3.2b: flushes when buffer reaches 4KB threshold", async () => {
		const mockBackend = new MockBackend();
		const largeContent = "x".repeat(4100);

		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: largeContent };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user" as const, content: "Hello" }],
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				inboxEntry.id,
				inboxEntry.source_site_id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.processed,
			],
		);

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		handle.stop();

		const chunks = db
			.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_chunk") as RelayOutboxEntry[];

		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});

	it("AC3.3: stream_end contains done chunk with usage stats", async () => {
		const mockBackend = new MockBackend();
		mockBackend.setTextResponse("Final response");

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user" as const, content: "Hello" }],
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				inboxEntry.id,
				inboxEntry.source_site_id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.processed,
			],
		);

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		handle.stop();

		const ends = db
			.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_end") as RelayOutboxEntry[];

		expect(ends.length).toBeGreaterThan(0);

		const endPayload = JSON.parse(ends[0].payload) as { chunks: StreamChunk[]; seq: number };
		const doneChunk = endPayload.chunks.find((c) => c.type === "done");

		expect(doneChunk).toBeDefined();
		if (doneChunk && doneChunk.type === "done") {
			expect(doneChunk.usage).toBeDefined();
			expect(doneChunk.usage.input_tokens).toBeGreaterThanOrEqual(0);
			expect(doneChunk.usage.output_tokens).toBeGreaterThanOrEqual(0);
		}
	});

	it("AC3.4: cancel aborts stream and writes error response", async () => {
		const mockBackend = new MockBackend();

		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "chunk1" };
			await new Promise((resolve) => setTimeout(resolve, 500));
			yield { type: "text" as const, content: "chunk2" };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 10 } };
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user" as const, content: "Hello" }],
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				inboxEntry.id,
				inboxEntry.source_site_id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.processed,
			],
		);

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const cancelEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "cancel",
			ref_id: inboxEntry.id,
			idempotency_key: null,
			stream_id: null,
			payload: JSON.stringify({}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				cancelEntry.id,
				cancelEntry.source_site_id,
				cancelEntry.kind,
				cancelEntry.ref_id,
				cancelEntry.idempotency_key,
				cancelEntry.stream_id,
				cancelEntry.payload,
				cancelEntry.expires_at,
				cancelEntry.received_at,
				cancelEntry.processed,
			],
		);

		await new Promise((resolve) => setTimeout(resolve, 1000));
		handle.stop();

		const errorResponses = db
			.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
			.all("error", inboxEntry.id) as RelayOutboxEntry[];

		expect(errorResponses.length).toBeGreaterThan(0);
		const errorPayload = JSON.parse(errorResponses[0].payload);
		expect(errorPayload.error).toContain("cancelled by requester");
	});

	it("AC3.5: expired inference entry is discarded without execution", async () => {
		const mockBackend = new MockBackend();
		mockBackend.setTextResponse("Should not appear");

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry: RelayInboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				model: "test-model",
				messages: [{ role: "user" as const, content: "Hello" }],
				timeout_ms: 5000,
			}),
			expires_at: new Date(0).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				inboxEntry.id,
				inboxEntry.source_site_id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.processed,
			],
		);

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		handle.stop();

		const chunks = db
			.query(
				"SELECT * FROM relay_outbox WHERE stream_id = ? AND kind IN ('stream_chunk', 'stream_end')",
			)
			.all(streamId) as RelayOutboxEntry[];

		expect(chunks.length).toBe(0);

		const unprocessed = db
			.query("SELECT * FROM relay_inbox WHERE id = ? AND processed = 0")
			.get(inboxEntry.id);
		expect(unprocessed).toBeNull();
	});

	it("AC3.6: concurrent inference streams execute simultaneously", async () => {
		const mockBackend1 = new MockBackend();
		mockBackend1.pushResponse(async function* () {
			yield { type: "text" as const, content: "A".repeat(5000) };
			yield { type: "text" as const, content: "Response 1" };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});

		const mockBackend2 = new MockBackend();
		mockBackend2.pushResponse(async function* () {
			yield { type: "text" as const, content: "B".repeat(5000) };
			yield { type: "text" as const, content: "Response 2" };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});

		const mockBackend3 = new MockBackend();
		mockBackend3.pushResponse(async function* () {
			yield { type: "text" as const, content: "C".repeat(5000) };
			yield { type: "text" as const, content: "Response 3" };
			yield { type: "done" as const, usage: { input_tokens: 10, output_tokens: 5 } };
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("model-1", mockBackend1);
		backends.set("model-2", mockBackend2);
		backends.set("model-3", mockBackend3);
		const mockRouter = new ModelRouter(backends, "model-1");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			new Set(["requester-site"]),
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamIds = [randomUUID(), randomUUID(), randomUUID()];
		const inferenceIds = [randomUUID(), randomUUID(), randomUUID()];

		for (let i = 0; i < 3; i++) {
			const inboxEntry: RelayInboxEntry = {
				id: inferenceIds[i],
				source_site_id: "requester-site",
				kind: "inference",
				ref_id: null,
				idempotency_key: null,
				stream_id: streamIds[i],
				payload: JSON.stringify({
					model: `model-${i + 1}`,
					messages: [{ role: "user" as const, content: `Hello ${i + 1}` }],
					timeout_ms: 5000,
				}),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					inboxEntry.id,
					inboxEntry.source_site_id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key,
					inboxEntry.stream_id,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.processed,
				],
			);
		}

		const handle = processor.start(50);
		await new Promise((resolve) => setTimeout(resolve, 2500));
		handle.stop();

		for (let i = 0; i < 3; i++) {
			const chunks = db
				.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
				.all(streamIds[i], "stream_chunk") as RelayOutboxEntry[];
			const ends = db
				.query("SELECT * FROM relay_outbox WHERE stream_id = ? AND kind = ?")
				.all(streamIds[i], "stream_end") as RelayOutboxEntry[];

			expect(chunks.length).toBeGreaterThan(0);
			expect(ends.length).toBeGreaterThan(0);

			const allEntries = [...chunks, ...ends];
			for (const entry of allEntries) {
				expect(entry.stream_id).toBe(streamIds[i]);
			}
		}
	});
});
