import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, claimLocalDurableWork, getDurableWork, insertDurableWork } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { Logger } from "@bound/shared";
type DurableRow = {
	id: string;
	kind: string;
	payload: string;
	ref_id: string | null;
	stream_id: string | null;
	claim_state: string;
};
import { splitInferenceRequest } from "../inference-request-parts";
import { RelayProcessor } from "../relay-processor";
import { waitFor } from "./helpers";
class MockBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;
	/** Parameters captured from each chat() invocation — used by tests that
	 * assert the relay-processor's clamping / aliasing behaviour. */
	public capturedParams: ChatParams[] = [];

	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	setTextResponse(text: string) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: text };
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
		});
	}

	async *chat(params: ChatParams) {
		this.capturedParams.push(params);
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
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

const _createTrackedEventBus = (): {
	eventBus: TypedEventEmitter;
	emitted: Array<{ event: string; args: unknown }>;
} => {
	const eventBus = createMockEventBus();
	const emitted: Array<{ event: string; args: unknown }> = [];
	const originalEmit = eventBus.emit.bind(eventBus);
	eventBus.emit = ((event: string, ...args: unknown[]) => {
		emitted.push({ event, args: args[0] });
		return originalEmit(event, ...args);
	}) as typeof eventBus.emit;
	return { eventBus, emitted };
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
	testDbPath = join(tmpdir(), `test-relay-processor-inference-${testId}.db`);
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

// Post-N+1 the relay processor is durable-only. An inference request rides a
// self-loopback durable_work row (source_site = the processor's own site) so its
// stream_chunk/stream_end responses ride the LOCAL_WORK_TARGET lane and land as
// durable_work rows keyed by stream_id.
function insertDurableInference(entry: {
	id: string;
	streamId: string;
	payload: string;
	expiresAt?: string;
}): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, stream_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, 'target-site', 'inference', ?, ?, ?, 'pending', 0, ?, ?, 'target-site', ?)`,
		[
			entry.id,
			entry.payload,
			entry.id,
			entry.streamId,
			now,
			entry.expiresAt ?? new Date(Date.now() + 60000).toISOString(),
			now,
		],
	);
}

describe("RelayProcessor - executeInference", () => {
	it("AC3.1: executes inference, writes stream_chunk and stream_end with monotonic seq", async () => {
		const mockBackend = new MockBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "x".repeat(5000) };
			yield { type: "text" as const, content: "final response" };
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
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const streamId = randomUUID();
		insertDurableInference({
			id: randomUUID(),
			streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
		});

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "AC3.1: stream_end not written" },
		);
		handle.stop();
		expect(mockBackend.capturedParams[0]?.threadId).toBe("thread-123");

		const chunks = db
			.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_chunk") as DurableRow[];
		const ends = db
			.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_end") as DurableRow[];

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

	// Objection 1 (#253): a durable multipart inference reassembles through the REAL
	// processPendingDurableWork claim lifecycle. processPendingDurableWork claims each
	// inference_part (pending→processing) BEFORE dispatching handleInferencePart, so the
	// part currently being handled sits in 'processing'. readDurablePartsByStreamId must
	// therefore include claim_state IN ('pending','processing') — mirroring the OLD
	// relay_inbox reader's processed=0 contract (every not-yet-consumed part) — or the
	// row is invisible to itself and reassembly can never see the full set. The parts
	// below are inserted as pending durable_work rows and driven ONLY through
	// processor.start() (the real loop), never hand-claimed, so this exercises the actual
	// claim→dispatch→reassemble path. Asserts the backend fires exactly once with the
	// fully reassembled payload.
	it("reassembles out-of-order inference parts and invokes the backend exactly once", async () => {
		const backend = new MockBackend();
		backend.setTextResponse("multipart-ok");
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const requestId = randomUUID();
		const streamId = randomUUID();
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const serialized = JSON.stringify({
			model: "test-model",
			segments: [{ kind: "inline", message: { role: "user", content: "電".repeat(2000) } }],
			nowMs: 0,
			timeout_ms: 5000,
		});
		const parts = splitInferenceRequest(serialized, requestId, 512).reverse();
		const insert = db.prepare(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', 'inference_part', ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
		);
		for (const part of [...parts, parts[0]]) {
			const nowIso = new Date().toISOString();
			insert.run(
				randomUUID(),
				requestId,
				`part-${requestId}-${part.index}-${randomUUID()}`,
				streamId,
				JSON.stringify(part),
				expiresAt,
				nowIso,
				nowIso,
			);
		}
		const handle = processor.start(10);
		await waitFor(() => backend.capturedParams.length === 1, {
			message: "multipart inference did not invoke backend",
		});
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number }
				).n === 1,
			{ message: "multipart inference did not complete" },
		);
		handle.stop();
		expect(backend.capturedParams).toHaveLength(1);
		expect(backend.capturedParams[0]?.threadId).toBe(`legacy-relay-${streamId}`);
		expect((backend.capturedParams[0].messages[0].content as string).length).toBe(2000);
	});

	// Objection 1 round-3 (#253): multipart reassembly must be CRASH-IDEMPOTENT.
	// The old design recorded completion only in the in-process completedInferenceParts
	// Set and acked parts one-by-one on later ticks. A crash after handleInference
	// launched but before every sibling part acked left the full part set recoverable →
	// boot recovery re-pends → the empty in-process Set no longer short-circuits →
	// the backend executes the LOGICAL request TWICE. The (kind,idempotency_key) fence
	// only stops duplicate row INSERTION, not duplicate execution. The fix consumes ALL
	// sibling part rows atomically BEFORE launching inference (claim-all-then-execute),
	// so a crash after consumption leaves NO recoverable parts.
	function seedMultipartInference(streamId: string, requestId: string): { partCount: number } {
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const serialized = JSON.stringify({
			threadId: "thread-123",
			model: "test-model",
			segments: [{ kind: "inline", message: { role: "user", content: "電".repeat(2000) } }],
			nowMs: 0,
			timeout_ms: 5000,
		});
		const parts = splitInferenceRequest(serialized, requestId, 512);
		const insert = db.prepare(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', 'inference_part', ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
		);
		for (const part of parts) {
			const nowIso = new Date().toISOString();
			insert.run(
				randomUUID(),
				requestId,
				`part-${requestId}-${part.index}`,
				streamId,
				JSON.stringify(part),
				expiresAt,
				nowIso,
				nowIso,
			);
		}
		return { partCount: parts.length };
	}

	it("consumes ALL sibling inference_part rows after reassembly — none leak for boot recovery", async () => {
		const backend = new MockBackend();
		backend.setTextResponse("multipart-ok");
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const requestId = randomUUID();
		const streamId = randomUUID();
		const { partCount } = seedMultipartInference(streamId, requestId);
		expect(partCount).toBeGreaterThan(1);

		const handle = processor.start(10);
		await waitFor(() => backend.capturedParams.length === 1, {
			message: "multipart inference did not invoke backend",
		});
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number }
				).n === 1,
			{ message: "multipart inference did not complete" },
		);
		// Let the lane run a few more ticks so any un-consumed sibling would be claimed.
		await new Promise((r) => setTimeout(r, 60));
		handle.stop();

		// Every inference_part row for this stream must be 'consumed' — no 'pending'
		// or 'processing' row survives for boot recovery to re-pend and re-assemble.
		const leaked = db
			.query(
				"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'inference_part' AND claim_state IN ('pending','processing')",
			)
			.get(streamId) as { n: number };
		expect(leaked.n).toBe(0);
		const consumed = db
			.query(
				"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'inference_part' AND claim_state = 'consumed'",
			)
			.get(streamId) as { n: number };
		expect(consumed.n).toBe(partCount);
	});

	// Objection 1 round-4 (#253): the claim-and-consume must be ONE atomic transaction.
	// Round-3 split it across two transactions — claimDurableWorkByIds committed its
	// sibling claims, THEN a separate BEGIN IMMEDIATE acked the set. On a concurrent-claim
	// shortfall the ack rollback undid only the acks; the freshly-committed sibling claims
	// were NOT undone, stranding those siblings in `processing` under the lane's tokens,
	// and the outer lane then acked the CURRENT part into `consumed` (handleInferencePart
	// returned null) — permanently shortening the part set. The fix runs sibling selection,
	// pending→processing claims, cardinality validation, and processing→consumed acks in
	// ONE BEGIN IMMEDIATE: on ANY shortfall the whole transaction rolls back (nothing
	// claimed, nothing consumed) and the current part is RELEASED back to pending so a
	// future reassembly can complete the set — never consumed while the set is short.
	it("concurrent-claim contention aborts atomically — nothing consumed, nothing stranded, current part recoverable", async () => {
		const backend = new MockBackend();
		backend.setTextResponse("multipart-ok");
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const requestId = randomUUID();
		const streamId = randomUUID();
		const { partCount } = seedMultipartInference(streamId, requestId);
		expect(partCount).toBeGreaterThan(1);

		// A concurrent claimant (another tick / a different node in a live cluster) has
		// already claimed ONE sibling under its OWN token before this lane assembles the
		// set. That sibling is `processing` under a FOREIGN token — visible for assembly
		// (readDurablePartsByStreamId includes pending+processing) but NOT ackable by this
		// lane. consumeInferenceParts must therefore fail to claim/ack it and roll the whole
		// transaction back.
		const foreignToken = randomUUID();
		const siblingRows = db
			.query(
				"SELECT id FROM durable_work WHERE stream_id = ? AND kind = 'inference_part' ORDER BY id",
			)
			.all(streamId) as Array<{ id: string }>;
		expect(siblingRows.length).toBe(partCount);
		const foreignSiblingId = siblingRows[0].id;
		db.run(
			"UPDATE durable_work SET claim_state = 'processing', claim_token = ?, claimed_at = ? WHERE id = ?",
			[foreignToken, new Date().toISOString(), foreignSiblingId],
		);

		const handle = processor.start(10);
		// Give the lane several ticks to claim every claimable part and reach the assembling
		// tick where consumeInferenceParts runs against the contended set.
		await new Promise((r) => setTimeout(r, 120));
		handle.stop();

		// The reassembly aborted: the backend never fired.
		expect(backend.capturedParams).toHaveLength(0);

		// NOTHING was consumed — the transaction rolled back atomically.
		const consumed = db
			.query(
				"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'inference_part' AND claim_state = 'consumed'",
			)
			.get(streamId) as { n: number };
		expect(consumed.n).toBe(0);

		// The pre-claimed sibling still belongs to its FOREIGN owner — the lane did not
		// reclaim or disturb it.
		const foreignRow = db
			.query("SELECT claim_state, claim_token FROM durable_work WHERE id = ?")
			.get(foreignSiblingId) as { claim_state: string; claim_token: string | null };
		expect(foreignRow.claim_state).toBe("processing");
		expect(foreignRow.claim_token).toBe(foreignToken);

		// No part is stranded `processing` under one of THIS lane's tokens: every part is
		// either `pending` (the current part released, the siblings the lane claimed then
		// rolled back) or `processing` under the foreign token. The lane holds no live claim.
		const laneStranded = db
			.query(
				"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'inference_part' AND claim_state = 'processing' AND claim_token IS NOT ?",
			)
			.get(streamId, foreignToken) as { n: number };
		expect(laneStranded.n).toBe(0);

		// The full part set is still recoverable: partCount-1 rows `pending` + the 1 foreign
		// `processing`. Nothing is permanently lost, so a future reassembly can complete.
		const recoverable = db
			.query(
				"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'inference_part' AND claim_state IN ('pending','processing')",
			)
			.get(streamId) as { n: number };
		expect(recoverable.n).toBe(partCount);
	});

	it("re-pending consumed parts (boot recovery) does NOT execute the backend twice", async () => {
		const backend = new MockBackend();
		backend.setTextResponse("multipart-ok");
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const requestId = randomUUID();
		const streamId = randomUUID();
		seedMultipartInference(streamId, requestId);

		const handle = processor.start(10);
		await waitFor(() => backend.capturedParams.length === 1, {
			message: "multipart inference did not invoke backend",
		});
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number }
				).n === 1,
			{ message: "multipart inference did not complete" },
		);
		handle.stop();
		expect(backend.capturedParams).toHaveLength(1);

		// Simulate boot recovery: a NEW processor instance (empty in-process
		// completedInferenceParts Set) with the SAME durable rows. Because the fix
		// consumed every sibling atomically before executing, there is nothing left
		// pending to re-pend, so a second lane pass must NOT re-assemble or re-execute.
		const backend2Router = new ModelRouter(
			new Map([["test-model", backend as LLMBackend]]),
			"test-model",
		);
		const processor2 = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			backend2Router,
			createMockLogger(),
			createMockEventBus(),
		);
		const handle2 = processor2.start(10);
		await new Promise((r) => setTimeout(r, 120));
		handle2.stop();

		// Exactly one execution across the original run AND the recovery run.
		expect(backend.capturedParams).toHaveLength(1);
	});

	// Objection 2 round-3 (#253): STREAMING routing errors must not be a silent-consume
	// path. handleInference fire-and-forgets executeInference and returns null, so the
	// durable lane acks the request immediately; a RelayResponseRoutingError thrown from a
	// later stream write lands in the fire-and-forget .catch logger, never the typed
	// dead-letter catch in processPendingDurableWork. The fix PRE-FLIGHTS the response
	// route before launch: a non-capable response target throws synchronously so the typed
	// catch dead-letters the request BEFORE execution.
	function setHostCapability(siteId: string, capable: boolean): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
			 VALUES (?, ?, '0', ?, ?, ?, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = excluded.work_spool_capable, deleted = 0`,
			[siteId, siteId, now, now, capable ? 1 : 0],
		);
	}

	function insertPeerInference(entry: {
		id: string;
		streamId: string;
		payload: string;
		sourceSite: string;
	}): void {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, stream_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
			 VALUES (?, 'target-site', 'inference', ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
			[
				entry.id,
				entry.payload,
				entry.id,
				entry.streamId,
				now,
				new Date(Date.now() + 60000).toISOString(),
				entry.sourceSite,
				now,
			],
		);
	}

	it("dead-letters an inference request whose response target is non-capable, BEFORE executing", async () => {
		const backend = new MockBackend();
		backend.setTextResponse("should-not-run");
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		// The response target (source_site of the request) is a peer that does NOT
		// advertise work_spool_capable — the response could never be routed back.
		setHostCapability("requester-peer", false);
		const requestId = randomUUID();
		const streamId = randomUUID();
		insertPeerInference({
			id: requestId,
			streamId,
			sourceSite: "requester-peer",
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ kind: "inline", message: { role: "user", content: "hi" } }],
				nowMs: 0,
				timeout_ms: 5000,
			}),
		});

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(requestId) as {
						claim_state: string;
					} | null
				)?.claim_state === "dead_letter",
			{ message: "inference request was not dead-lettered for unroutable response target" },
		);
		handle.stop();

		const row = db
			.query("SELECT claim_state, last_error FROM durable_work WHERE id = ?")
			.get(requestId) as { claim_state: string; last_error: string | null };
		expect(row.claim_state).toBe("dead_letter");
		expect(row.last_error ?? "").toContain("work_spool_capable");
		// The backend must NOT have been invoked — dead-lettered before execution.
		expect(backend.capturedParams).toHaveLength(0);
	});

	it("surfaces a mid-stream routing failure via logger.error rather than swallowing it", async () => {
		// A capability flip AFTER pre-flight cannot be caught before ack. executeInference
		// attempts a routed error response; if THAT also fails to route, the final fallback
		// must be a structured logger.error with stream/request identifiers, not a swallowed
		// promise. Drive: response target capable at pre-flight, then retract capability so
		// the first stream chunk write throws RelayResponseRoutingError mid-stream.
		const errorRecords: Array<{ msg: string; meta: Record<string, unknown> }> = [];
		const capturingLogger: Logger = {
			info: () => {},
			warn: () => {},
			debug: () => {},
			error: (msg: string, meta?: Record<string, unknown>) => {
				errorRecords.push({ msg, meta: meta ?? {} });
			},
		};
		// A backend that blocks after the first chunk until the test releases it, so the
		// capability retraction lands BEFORE any flush reaches writeStreamChunk — making the
		// mid-stream routing failure deterministic rather than racing the flush timer.
		let releaseStream: () => void = () => {};
		const streamGate = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		const backend = new MockBackend();
		backend.pushResponse(async function* () {
			await streamGate;
			yield { type: "text" as const, content: "x".repeat(5000) };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			capturingLogger,
			createMockEventBus(),
		);
		// Capable at pre-flight so execution launches.
		setHostCapability("requester-peer", true);
		const requestId = randomUUID();
		const streamId = randomUUID();
		insertPeerInference({
			id: requestId,
			streamId,
			sourceSite: "requester-peer",
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ kind: "inline", message: { role: "user", content: "hi" } }],
				nowMs: 0,
				timeout_ms: 5000,
			}),
		});

		const handle = processor.start(10);
		// The backend has been entered (chat() called) and is now parked on streamGate.
		await waitFor(() => backend.capturedParams.length === 1, {
			message: "inference did not launch",
		});
		// Retract capability, THEN release the stream so every flush routes to error.
		setHostCapability("requester-peer", false);
		releaseStream();
		await waitFor(
			() =>
				errorRecords.some((r) => JSON.stringify(r).includes(streamId)) ||
				errorRecords.some((r) => JSON.stringify(r).includes(requestId)),
			{ message: "mid-stream routing failure was not surfaced via logger.error" },
		);
		handle.stop();

		// The failure surfaced with a stream or request identifier — not silent.
		const surfaced = errorRecords.some(
			(r) => JSON.stringify(r).includes(streamId) || JSON.stringify(r).includes(requestId),
		);
		expect(surfaced).toBe(true);
	});

	it("AC3.2a: flushes at 200ms timer with pending chunks", async () => {
		const mockBackend = new MockBackend();

		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "small" };
			// Must be > 200ms to trigger the 200ms flush timer before next chunk arrives
			await new Promise((resolve) => setTimeout(resolve, 250));
			yield { type: "text" as const, content: "delayed" };
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
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_chunk'",
						)
						.get(streamId) as { n: number } | null
				)?.n >= 1,
			{ message: "AC3.2a: stream_chunk not flushed by 200ms timer" },
		);
		handle.stop();

		const chunks = db
			.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_chunk") as DurableRow[];

		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});

	it("AC3.2b: flushes when buffer reaches 4KB threshold", async () => {
		const mockBackend = new MockBackend();
		const largeContent = "x".repeat(4100);

		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: largeContent };
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
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_chunk'",
						)
						.get(streamId) as { n: number } | null
				)?.n >= 1,
			{ message: "AC3.2b: stream_chunk not flushed at 4KB" },
		);
		handle.stop();

		const chunks = db
			.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_chunk") as DurableRow[];

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
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "AC3.3: stream_end not written" },
		);
		handle.stop();

		const ends = db
			.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
			.all(streamId, "stream_end") as DurableRow[];

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
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield { type: "text" as const, content: "chunk2" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		// Wait for the inference entry to be dispatched (fire-and-forget) before inserting cancel
		await waitFor(() => getDurableWork(db, inboxEntry.id)?.claim_state === "consumed", {
			message: "AC3.4: inference entry not dispatched",
		});

		const cancelEntry = {
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
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', 'cancel', ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				cancelEntry.id,
				cancelEntry.ref_id,
				cancelEntry.id,
				cancelEntry.stream_id,
				cancelEntry.payload,
				cancelEntry.expires_at,
				cancelEntry.received_at,
				cancelEntry.received_at,
			],
		);

		await waitFor(
			() =>
				(
					db
						.query("SELECT COUNT(*) as n FROM durable_work WHERE kind = 'error' AND ref_id = ?")
						.get(inboxEntry.id) as { n: number } | null
				)?.n > 0,
			{ message: "AC3.4: error response not written after cancel" },
		);
		handle.stop();

		const errorResponses = db
			.query("SELECT * FROM durable_work WHERE kind = ? AND ref_id = ?")
			.all("error", inboxEntry.id) as DurableRow[];

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
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "target-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(0).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		// Wait for the expired entry to be claimed and discarded without execution.
		// The durable lane acks the expired row as consumed (relay-processor's expiry
		// check returns before dispatch); no stream_chunk/stream_end is written.
		await waitFor(() => getDurableWork(db, inboxEntry.id)?.claim_state === "consumed", {
			message: "AC3.5: expired entry not discarded (consumed)",
		});
		handle.stop();

		const chunks = db
			.query(
				"SELECT * FROM durable_work WHERE stream_id = ? AND kind IN ('stream_chunk', 'stream_end')",
			)
			.all(streamId) as DurableRow[];

		expect(chunks.length).toBe(0);

		// Expired requests are discarded by the expiry check, never dispatched:
		// no pending row survives.
		const stillPending = db
			.query("SELECT id FROM durable_work WHERE id = ? AND claim_state = 'pending'")
			.get(inboxEntry.id);
		expect(stillPending).toBeNull();
	});

	it("AC3.6: concurrent inference streams execute simultaneously", async () => {
		const mockBackend1 = new MockBackend();
		mockBackend1.pushResponse(async function* () {
			yield { type: "text" as const, content: "A".repeat(5000) };
			yield { type: "text" as const, content: "Response 1" };
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
		});

		const mockBackend2 = new MockBackend();
		mockBackend2.pushResponse(async function* () {
			yield { type: "text" as const, content: "B".repeat(5000) };
			yield { type: "text" as const, content: "Response 2" };
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
		});

		const mockBackend3 = new MockBackend();
		mockBackend3.pushResponse(async function* () {
			yield { type: "text" as const, content: "C".repeat(5000) };
			yield { type: "text" as const, content: "Response 3" };
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
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamIds = [randomUUID(), randomUUID(), randomUUID()];
		const inferenceIds = [randomUUID(), randomUUID(), randomUUID()];

		for (let i = 0; i < 3; i++) {
			const inboxEntry = {
				id: inferenceIds[i],
				source_site_id: "requester-site",
				kind: "inference",
				ref_id: null,
				idempotency_key: null,
				stream_id: streamIds[i],
				payload: JSON.stringify({
					threadId: "thread-123",
					model: `model-${i + 1}`,
					segments: [{ role: "user" as const, content: `Hello ${i + 1}` }].map((m) => ({
						kind: "inline" as const,
						message: m,
					})),
					nowMs: 0,
					timeout_ms: 5000,
				}),
				expires_at: new Date(now.getTime() + 60000).toISOString(),
				received_at: now.toISOString(),
				processed: 0,
			};

			db.run(
				`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
				 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
				[
					inboxEntry.id,
					inboxEntry.kind,
					inboxEntry.ref_id,
					inboxEntry.idempotency_key ?? inboxEntry.id,
					inboxEntry.stream_id,
					inboxEntry.payload,
					inboxEntry.expires_at,
					inboxEntry.received_at,
					inboxEntry.received_at,
				],
			);
		}

		const handle = processor.start(10);
		await waitFor(
			() =>
				streamIds.every(
					(sid) =>
						(
							db
								.query(
									"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
								)
								.get(sid) as { n: number } | null
						)?.n > 0,
				),
			{ message: "AC3.6: not all stream_ends written" },
		);
		handle.stop();

		for (let i = 0; i < 3; i++) {
			const chunks = db
				.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
				.all(streamIds[i], "stream_chunk") as DurableRow[];
			const ends = db
				.query("SELECT * FROM durable_work WHERE stream_id = ? AND kind = ?")
				.all(streamIds[i], "stream_end") as DurableRow[];

			expect(chunks.length).toBeGreaterThan(0);
			expect(ends.length).toBeGreaterThan(0);

			const allEntries = [...chunks, ...ends];
			for (const entry of allEntries) {
				expect(entry.stream_id).toBe(streamIds[i]);
			}
		}
	});

	it("forwards thinking chunks through the relay stream", async () => {
		const mockBackend = new MockBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "thinking" as const, content: "Let me analyze this..." };
			yield { type: "thinking" as const, content: " Reasoning complete." };
			yield { type: "text" as const, content: "Here is my answer." };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Think about this" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				thinking: { type: "enabled", budget_tokens: 10000 },
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written for thinking test" },
		);
		handle.stop();

		// Verify thinking chunks are included in the outbox (stream_chunk or stream_end)
		const chunkRows = db
			.query(
				"SELECT payload FROM durable_work WHERE stream_id = ? AND kind IN ('stream_chunk', 'stream_end') ORDER BY created_at",
			)
			.all(streamId) as Array<{ payload: string }>;

		// Collect all chunks from all payloads
		const allChunks: StreamChunk[] = [];
		for (const row of chunkRows) {
			const parsed = JSON.parse(row.payload);
			if (parsed.chunks) {
				allChunks.push(...parsed.chunks);
			}
		}

		// Should have thinking chunks
		const thinkingChunks = allChunks.filter((c) => c.type === "thinking");
		expect(thinkingChunks.length).toBe(2);

		// Should have text chunks
		const textChunks = allChunks.filter((c) => c.type === "text");
		expect(textChunks.length).toBeGreaterThan(0);
	});

	it("clamps payload.max_tokens to the local backend's maxOutputTokens cap", async () => {
		// Defense-in-depth: a stale requester binary (or a hub routing
		// decision made against a peer's old capability record) can still
		// send an explicit max_tokens (e.g. 16_384 from a pre-fix build)
		// for a model whose provider rejects it with "max_tokens exceeds
		// model limit of N". The receiver-side clamp takes
		// min(payload.max_tokens, localCap) so Nova Pro's 10_000 ceiling
		// is honored regardless of what the requester sent.
		const mockBackend = new MockBackend();
		mockBackend.setTextResponse("ok");

		const backends = new Map<string, LLMBackend>();
		backends.set("nova-pro", mockBackend);
		const backendConfigs = new Map<string, import("@bound/llm").BackendConfig>();
		backendConfigs.set("nova-pro", {
			id: "nova-pro",
			provider: "bedrock",
			model: "us.amazon.nova-pro-v1:0",
			maxOutputTokens: 8192,
		});
		const mockRouter = new ModelRouter(backends, "nova-pro", undefined, undefined, backendConfigs);

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "nova-pro",
				segments: [{ role: "user" as const, content: "hi" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				max_tokens: 16384, // Default from a pre-fix requester
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written for clamp test" },
		);
		handle.stop();

		expect(mockBackend.capturedParams).toHaveLength(1);
		expect(mockBackend.capturedParams[0].max_tokens).toBe(8192);
	});

	it("leaves payload.max_tokens untouched when no local cap is configured", async () => {
		const mockBackend = new MockBackend();
		mockBackend.setTextResponse("ok");

		const backends = new Map<string, LLMBackend>();
		backends.set("opus", mockBackend);
		const mockRouter = new ModelRouter(backends, "opus");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "opus",
				segments: [{ role: "user" as const, content: "hi" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				max_tokens: 16384,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written for no-cap test" },
		);
		handle.stop();

		expect(mockBackend.capturedParams).toHaveLength(1);
		expect(mockBackend.capturedParams[0].max_tokens).toBe(16384);
	});

	it("stamps hub-computed cost_usd onto the final done chunk", async () => {
		// Hub holds the authoritative pricing; spokes that delegate may run
		// hub-only mode (empty backends) and would otherwise compute 0.
		// The hub computes cost from its own model_backends config and stamps
		// it on the done StreamChunk so the spoke records an accurate row.
		const mockBackend = new MockBackend();
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "priced response" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_write_tokens: 200,
					cache_read_tokens: 800,
					estimated: false,
				},
			};
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("priced-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "priced-model");

		// Stub appCtx with the same pricing the router knows about. The
		// relay-processor reads pricing from appCtx.config.modelBackends.backends
		// because that's the raw shared-config shape (price_per_m_*).
		const appCtxStub = {
			config: {
				modelBackends: {
					default: "priced-model",
					backends: [
						{
							id: "priced-model",
							provider: "anthropic",
							model: "priced-model",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 3.0,
							price_per_m_output: 15.0,
							price_per_m_cache_read: 0.3,
							price_per_m_cache_write: 3.75,
						},
					],
				},
			},
		} as unknown as Parameters<typeof RelayProcessor>[7];

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
			appCtxStub,
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "priced-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written for cost-stamping test" },
		);
		handle.stop();

		// The done chunk lives in the final stream_end payload, not in any
		// stream_chunk — chunkBuffer is flushed exactly once with isFinal=true
		// at the end of runInferenceWithTracing.
		const ends = db
			.query("SELECT payload FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'")
			.all(streamId) as Array<{ payload: string }>;
		expect(ends.length).toBe(1);

		const endPayload = JSON.parse(ends[0].payload) as {
			chunks: StreamChunk[];
			seq: number;
		};
		const doneChunk = endPayload.chunks.find((c) => c.type === "done");
		expect(doneChunk).toBeDefined();

		// Expected cost:
		// input:       1000 * 3.0  / 1M = 0.003000
		// output:       500 * 15.0 / 1M = 0.007500
		// cache_read:   800 * 0.3  / 1M = 0.000240
		// cache_write:  200 * 3.75 / 1M = 0.000750
		// Total:                          0.011490
		if (doneChunk?.type === "done") {
			expect(doneChunk.cost_usd).toBeDefined();
			expect(doneChunk.cost_usd).toBeCloseTo(0.01149, 8);
		}
	});

	it("stamps cost_usd = 0 when hub has no backend pricing for the model", async () => {
		// Defensive: when the hub's appCtx is missing or the model isn't in
		// its backends list, calculateTurnCost returns 0 and we still stamp.
		// This keeps the wire format consistent and lets the spoke fall back
		// to its own local calc on the spoke side (cost_usd=0 from the hub
		// is preserved by the ?? operator only when undefined; explicit 0
		// overrides). This test pins the wire-format guarantee — the
		// happy-path fallback to local calc is covered by agent-loop tests.
		const mockBackend = new MockBackend();
		mockBackend.setTextResponse("ok");

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
			// No appCtx stub — exercises the `?? []` fallback
		);

		const now = new Date();
		const streamId = randomUUID();
		const inboxEntry = {
			id: randomUUID(),
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};

		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) as n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number } | null
				)?.n > 0,
			{ message: "stream_end not written" },
		);
		handle.stop();

		const ends = db
			.query("SELECT payload FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'")
			.all(streamId) as Array<{ payload: string }>;
		const endPayload = JSON.parse(ends[0].payload) as {
			chunks: StreamChunk[];
			seq: number;
		};
		const doneChunk = endPayload.chunks.find((c) => c.type === "done");
		if (doneChunk?.type === "done") {
			expect(doneChunk.cost_usd).toBe(0);
		}
	});

	it("drops duplicate inference relay delivery before the processor executes a second stream", async () => {
		const backend = new MockBackend();
		backend.setTextResponse("deduplicated inference");
		const router = new ModelRouter(new Map([["test-model", backend as LLMBackend]]), "test-model");
		const processor = new RelayProcessor(
			db,
			"target-site",
			new Map(),
			router,
			createMockLogger(),
			createMockEventBus(),
		);
		const streamId = randomUUID();
		const now = new Date();
		const makeEntry = (id: string) => ({
			id,
			target_site_id: "target-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: `inference-stream:${streamId}`,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ kind: "inline", message: { role: "user", content: "Hello" } }],
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60_000).toISOString(),
			received_at: now.toISOString(),
			source_site: "target-site",
		});

		// The (kind, idempotency_key) unique index dedupes: the first insert lands,
		// the second with the same key is suppressed (insertDurableWork returns false).
		expect(insertDurableWork(db, makeEntry("inbox-inference-dedup-1"))).toBe(true);
		expect(insertDurableWork(db, makeEntry("inbox-inference-dedup-2"))).toBe(false);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM durable_work WHERE stream_id = ? AND kind = 'stream_end'",
						)
						.get(streamId) as { n: number }
				).n === 1,
			{ message: "inference stream did not complete exactly once" },
		);
		handle.stop();

		expect(backend.capturedParams).toHaveLength(1);
		expect(
			(
				db.query("SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'inference'").get() as {
					n: number;
				}
			).n,
		).toBe(1);
	});

	// 4D-D circle: a DURABLE cancel (arriving as a durable_work row post-spool-
	// transfer) must abort a running inference stream. The legacy AC3.4 test above
	// drives the same abort via a relay_inbox cancel row; this drives it through
	// the 4D-A durable lane (durable row -> claimLocalDurableWork -> handler ->
	// AbortController.abort()). Toggle hygiene is mandatory: two prior gate
	// failures were cross-file BOUND_DURABLE_RELAY leaks, so the flag is set in
	// this test and restored on the surrounding afterEach.
	it("4D-D: a durable cancel row aborts a running inference stream and writes a cancel error", async () => {
		const mockBackend = new MockBackend();
		// A stream that hangs long enough for the durable cancel to catch it
		// mid-flight: first chunk lands, then a long delay before the next.
		mockBackend.pushResponse(async function* () {
			yield { type: "text" as const, content: "chunk1" };
			await new Promise((resolve) => setTimeout(resolve, 2000));
			yield { type: "text" as const, content: "chunk2" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});

		const backends = new Map<string, LLMBackend>();
		backends.set("test-model", mockBackend);
		const mockRouter = new ModelRouter(backends, "test-model");

		const SELF = "target-site";
		const processor = new RelayProcessor(
			db,
			SELF,
			new Map(),
			mockRouter,
			createMockLogger(),
			createMockEventBus(),
		);

		const now = new Date();
		const streamId = randomUUID();
		const inferenceId = randomUUID();
		// The inference request arrives on the legacy relay_inbox path (the stream
		// itself is unchanged by 4D-D; only its cancel flips durable). This starts
		// the stream and registers its AbortController under `inferenceId`.
		const inboxEntry = {
			id: inferenceId,
			source_site_id: "requester-site",
			kind: "inference",
			ref_id: null,
			idempotency_key: null,
			stream_id: streamId,
			payload: JSON.stringify({
				threadId: "thread-123",
				model: "test-model",
				segments: [{ role: "user" as const, content: "Hello" }].map((m) => ({
					kind: "inline" as const,
					message: m,
				})),
				nowMs: 0,
				timeout_ms: 5000,
			}),
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
		};
		db.run(
			`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, source_site, received_at, claim_state, attempt_count, created_at)
			 VALUES (?, 'target-site', ?, ?, ?, ?, ?, ?, 'target-site', ?, 'pending', 0, ?)`,
			[
				inboxEntry.id,
				inboxEntry.kind,
				inboxEntry.ref_id,
				inboxEntry.idempotency_key ?? inboxEntry.id,
				inboxEntry.stream_id,
				inboxEntry.payload,
				inboxEntry.expires_at,
				inboxEntry.received_at,
				inboxEntry.received_at,
			],
		);

		const handle = processor.start(10);
		// Wait for the inference entry to be dispatched (fire-and-forget) so the
		// stream is running and its AbortController is registered before the cancel.
		await waitFor(() => getDurableWork(db, inboxEntry.id)?.claim_state === "consumed", {
			message: "4D-D: inference entry not dispatched",
		});

		// The DURABLE cancel row, shaped as it would arrive on the target after the
		// 4D-C producer flip + spool transfer: pending, self-targeted, kind cancel,
		// ref_id pointing at the running inference request, production key
		// construction (cancel:<rowId> when the producer minted no legacy key).
		const cancelRowId = randomUUID();
		insertDurableWork(db, {
			id: cancelRowId,
			target_site_id: SELF,
			kind: "cancel",
			payload: JSON.stringify({}),
			idempotency_key: `cancel:${cancelRowId}`,
			ref_id: inferenceId,
			source_site: "requester-site",
			expires_at: new Date(now.getTime() + 60000).toISOString(),
			received_at: now.toISOString(),
		});

		// The 4D-A lane must claim + dispatch the durable cancel, firing the
		// registered AbortController. The stream then terminates as cancelled and
		// writes the same "cancelled by requester" error the legacy path writes.
		await waitFor(
			() =>
				(
					db
						.query("SELECT COUNT(*) as n FROM durable_work WHERE kind = 'error' AND ref_id = ?")
						.get(inferenceId) as { n: number } | null
				)?.n > 0,
			{ message: "4D-D: cancel error not written after durable cancel" },
		);
		handle.stop();

		// (1) The running stream terminated as cancelled — same assertion strength
		// as the legacy AC3.4 test.
		const errorResponses = db
			.query("SELECT * FROM durable_work WHERE kind = ? AND ref_id = ?")
			.all("error", inferenceId) as DurableRow[];
		expect(errorResponses.length).toBeGreaterThan(0);
		expect(JSON.parse(errorResponses[0].payload).error).toContain("cancelled by requester");

		// (2) The durable cancel row was consumed (token-fenced ack), not left
		// pending/processing and not dead-lettered.
		const cancelRow = db
			.query("SELECT claim_state FROM durable_work WHERE id = ?")
			.get(cancelRowId) as { claim_state: string } | null;
		expect(cancelRow?.claim_state).toBe("consumed");

		// (3) No further durable cancel remains claimable for this target.
		expect(claimLocalDurableWork(db, SELF, "cancel")).toBeNull();

		// (4) The stream did not also complete normally — no stream_end slipped
		// through alongside the cancel.
		const streamEnds = db
			.query("SELECT COUNT(*) as n FROM durable_work WHERE kind = 'stream_end' AND stream_id = ?")
			.get(streamId) as { n: number };
		expect(streamEnds.n).toBe(0);
	});
});
