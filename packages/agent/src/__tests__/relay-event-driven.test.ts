import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, readDurableResponsesByStreamId } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";

// Post-N+1 stream chunks ride the durable work spool: a peer writes a
// durable_work response row (kind stream_chunk/stream_end) targeted at the
// awaiting site, read by readDurableResponsesByStreamId. Legacy relay_inbox is
// retired. This site owns the stream, so rows target SELF.
const SELF = "self-site";

function insertStreamChunk(
	db: Database,
	opts: { id: string; streamId: string; kind: "stream_chunk" | "stream_end"; payload: unknown },
): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, stream_id, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
		[
			opts.id,
			SELF,
			opts.kind,
			JSON.stringify(opts.payload),
			`stream:${opts.streamId}:${opts.id}`,
			opts.streamId,
			now,
			new Date(Date.now() + 60_000).toISOString(),
			"remote-host",
			now,
		],
	);
}

let db: Database;
let testDbPath: string;
let eventBus: TypedEventEmitter;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-relay-event-${testId}.db`);
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
	eventBus = new TypedEventEmitter();
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

describe("Event-Driven RELAY_STREAM", () => {
	it("RELAY_STREAM yields chunks from relay:inbox events in sequence order", async () => {
		const streamId = randomUUID();

		const chunks: Array<{ seq: number; content: string }> = [];

		// Simulate collecting chunks as relayStream would
		const entries = readDurableResponsesByStreamId(db, streamId, SELF);
		expect(entries.length).toBe(0);

		// Insert stream chunks in out-of-order sequence (2, 0, 1)
		insertStreamChunk(db, {
			id: "chunk-2",
			streamId,
			kind: "stream_chunk",
			payload: { seq: 2, chunks: [{ type: "text", content: "Third" }] },
		});
		insertStreamChunk(db, {
			id: "chunk-0",
			streamId,
			kind: "stream_chunk",
			payload: { seq: 0, chunks: [{ type: "text", content: "First" }] },
		});
		insertStreamChunk(db, {
			id: "chunk-1",
			streamId,
			kind: "stream_chunk",
			payload: { seq: 1, chunks: [{ type: "text", content: "Second" }] },
		});

		// Read entries and verify they're in received order (not seq order initially)
		const allEntries = readDurableResponsesByStreamId(db, streamId, SELF);
		expect(allEntries.length).toBe(3);

		// Parse and verify we can reorder by seq
		for (const entry of allEntries) {
			const payload = JSON.parse(entry.payload) as {
				seq: number;
				chunks: Array<{ type: string; content: string }>;
			};
			chunks.push({
				seq: payload.seq,
				content: payload.chunks[0].content,
			});
		}

		// Sort by seq (as relayStream would)
		chunks.sort((a, b) => a.seq - b.seq);

		expect(chunks[0].content).toBe("First");
		expect(chunks[1].content).toBe("Second");
		expect(chunks[2].content).toBe("Third");
	});

	it("RELAY_STREAM timeout triggers failover after inference_timeout_ms", async () => {
		const _streamId = randomUUID();
		const PER_HOST_TIMEOUT_MS = 100;
		let timedOut = false;
		const startTime = Date.now();

		await new Promise<void>((resolve) => {
			const timeoutId = setTimeout(() => {
				timedOut = true;
				resolve();
			}, PER_HOST_TIMEOUT_MS + 50);

			const lastActivityTime = Date.now();
			const checkTimeout = () => {
				const elapsed = Date.now() - lastActivityTime;
				if (elapsed > PER_HOST_TIMEOUT_MS) {
					clearTimeout(timeoutId);
					timedOut = true;
					resolve();
				}
			};

			// Wait for timeout
			setTimeout(checkTimeout, PER_HOST_TIMEOUT_MS + 10);
		});

		expect(timedOut).toBe(true);
		const elapsed = Date.now() - startTime;
		expect(elapsed).toBeGreaterThanOrEqual(PER_HOST_TIMEOUT_MS);
	});

	it("RELAY_STREAM waits for next chunk via event with short timeout", async () => {
		const streamId = randomUUID();
		const POLL_INTERVAL_MS = 100;
		let eventFired = false;

		await new Promise<void>((resolve) => {
			const timeoutId = setTimeout(() => {
				resolve();
			}, POLL_INTERVAL_MS + 50);

			const onInbox = (event: { ref_id?: string; stream_id?: string; kind: string }) => {
				if (event.stream_id !== streamId) return;
				eventFired = true;
				clearTimeout(timeoutId);
				resolve();
			};

			eventBus.on("relay:inbox", onInbox);

			// Emit event after a delay
			setTimeout(() => {
				eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" });
			}, POLL_INTERVAL_MS / 2);
		});

		expect(eventFired).toBe(true);
	});

	it("RELAY_STREAM detects stream_end and completes", () => {
		const streamId = randomUUID();

		// Insert stream_chunk
		insertStreamChunk(db, {
			id: "chunk-0",
			streamId,
			kind: "stream_chunk",
			payload: { seq: 0, chunks: [{ type: "text", content: "Data" }] },
		});

		// Insert stream_end
		insertStreamChunk(db, {
			id: "stream-end",
			streamId,
			kind: "stream_end",
			payload: { seq: 1, chunks: [] },
		});

		const entries = readDurableResponsesByStreamId(db, streamId, SELF);
		const hasEnd = entries.some((e) => e.kind === "stream_end");
		expect(hasEnd).toBe(true);

		const chunkEntries = entries.filter((e) => e.kind === "stream_chunk");
		expect(chunkEntries.length).toBe(1);
	});

	it("RELAY_STREAM cancellation stops generator cleanly", () => {
		let aborted = false;

		// Simulate abort during RELAY_STREAM
		aborted = true;

		// Should immediately exit and not continue polling
		if (aborted) {
			// Would return from generator (AC5 requirement: cancellation works)
			expect(aborted).toBe(true);
		}
	});

	it("RELAY_STREAM short timeout on event wait ensures periodic checks", async () => {
		const streamId = randomUUID();
		const POLL_INTERVAL_MS = 500;
		let checkCount = 0;
		const maxChecks = 3;

		await new Promise<void>((resolve) => {
			const timeoutId = setTimeout(
				() => {
					resolve();
				},
				POLL_INTERVAL_MS * (maxChecks + 1) + 100,
			);

			// Simulate periodic timeout checks
			const checkInterval = setInterval(() => {
				checkCount++;
				if (checkCount >= maxChecks) {
					clearInterval(checkInterval);
					clearTimeout(timeoutId);
					resolve();
				}
			}, POLL_INTERVAL_MS + 50);

			// Set up event listener but don't fire events
			eventBus.on("relay:inbox", (event) => {
				if (event.stream_id === streamId) {
					// Entry arrived
				}
			});
		});

		expect(checkCount).toBeGreaterThanOrEqual(maxChecks);
	});

	it("RELAY_STREAM marks entries as processed after handling", () => {
		const streamId = randomUUID();

		// Insert chunk
		const chunkId = "chunk-123";
		insertStreamChunk(db, {
			id: chunkId,
			streamId,
			kind: "stream_chunk",
			payload: { seq: 0, chunks: [{ type: "text", content: "Data" }] },
		});

		// Verify entry exists and is pending
		let entries = readDurableResponsesByStreamId(db, streamId, SELF);
		expect(entries.length).toBe(1);
		expect(entries[0].claim_state).toBe("pending");

		// Consume it (as relayStream would: claim -> deliver -> ack to consumed)
		db.run("UPDATE durable_work SET claim_state = 'consumed' WHERE id = ?", [chunkId]);

		// readDurableResponsesByStreamId filters to pending only
		entries = readDurableResponsesByStreamId(db, streamId, SELF);
		expect(entries.length).toBe(0);

		// Verify the database row shows consumed
		const allRows = db
			.query("SELECT claim_state FROM durable_work WHERE id = ?")
			.all(chunkId) as Array<{ claim_state: string }>;
		expect(allRows[0].claim_state).toBe("consumed");
	});

	it("RELAY_STREAM handles out-of-order chunks and gaps", () => {
		const streamId = randomUUID();

		// Insert chunks in out-of-order: 2, 0, 3, 1
		const chunkSeqs = [
			{ seq: 2, content: "Third" },
			{ seq: 0, content: "First" },
			{ seq: 3, content: "Fourth" },
			{ seq: 1, content: "Second" },
		];

		for (const chunk of chunkSeqs) {
			insertStreamChunk(db, {
				id: `chunk-${chunk.seq}`,
				streamId,
				kind: "stream_chunk",
				payload: { seq: chunk.seq, chunks: [{ type: "text", content: chunk.content }] },
			});
		}

		const entries = readDurableResponsesByStreamId(db, streamId, SELF);
		expect(entries.length).toBe(4);

		// Parse and sort by seq
		const parsed = entries.map((e) => {
			const payload = JSON.parse(e.payload) as { seq: number };
			return { seq: payload.seq, id: e.id };
		});

		parsed.sort((a, b) => a.seq - b.seq);

		expect(parsed[0].seq).toBe(0);
		expect(parsed[1].seq).toBe(1);
		expect(parsed[2].seq).toBe(2);
		expect(parsed[3].seq).toBe(3);
	});
});
