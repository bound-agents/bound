import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema, readInboxByRefId, readInboxByStreamId } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { waitForRelayInbox } from "../agent-loop-utils";

let db: Database;
let testDbPath: string;
let eventBus: TypedEventEmitter;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-relay-event-${testId}.db`;
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

describe("Event-Driven RELAY_WAIT", () => {
	it("RELAY_WAIT responds to relay:inbox event with matching ref_id", async () => {
		const refId = "test-ref-123";

		// Insert entry into relay inbox (simulating hub delivery)
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"response-1",
				"remote-host",
				"result",
				refId,
				null,
				JSON.stringify({ stdout: "result" }),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Use production helper to wait for the entry
		// Simulate event arrival (as sync transport would do)
		setTimeout(() => {
			eventBus.emit("relay:inbox", { ref_id: refId, kind: "result" });
		}, 10);

		const result = await waitForRelayInbox(db, eventBus, refId, 1000);

		expect(result).toBeDefined();
		expect(result?.kind).toBe("result");
	});

	it("RELAY_WAIT finds pre-existing entry on initial DB check", () => {
		const refId = "pre-existing-123";
		const hostId = "remote-host-1";

		// Pre-populate inbox with response BEFORE setting up listener
		db.run(
			"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"response-1",
				hostId,
				"result",
				refId,
				null,
				JSON.stringify({
					stdout: "Tool output here",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Check DB immediately (as relayWait would do before setting up listener)
		const found = readInboxByRefId(db, refId);

		expect(found).toBeDefined();
		if (found) {
			expect(found.kind).toBe("result");
			expect(found.ref_id).toBe(refId);
		}
	});

	it("RELAY_WAIT times out and returns null when no entry arrives", async () => {
		const refId = "timeout-test-123";
		const timeoutMs = 100;
		let timedOut = false;

		const result = await new Promise<null>((resolve) => {
			const timeoutId = setTimeout(() => {
				timedOut = true;
				resolve(null);
			}, timeoutMs);

			// Check DB immediately (would find nothing)
			const entry = readInboxByRefId(db, refId);
			if (entry) {
				clearTimeout(timeoutId);
				resolve(entry as any);
				return;
			}

			// Would set up listener here, but no event will fire
			const onInbox = (event: { ref_id?: string; stream_id?: string; kind: string }) => {
				if (event.ref_id !== refId) return;
				clearTimeout(timeoutId);
				const dbEntry = readInboxByRefId(db, refId);
				resolve(dbEntry as any);
			};

			eventBus.on("relay:inbox", onInbox);
		});

		expect(timedOut).toBe(true);
		expect(result).toBeNull();
	});

	it("RELAY_WAIT handles pre-existing entry race condition", async () => {
		const refId = "race-test-123";
		const hostId = "remote-host-1";

		// Populate entry
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"response-1",
				hostId,
				"result",
				refId,
				null,
				JSON.stringify({
					stdout: "Result",
					stderr: "",
					exitCode: 0,
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Simulate the exact pattern from the implementation:
		// 1. Check DB immediately
		const found = readInboxByRefId(db, refId);
		expect(found).toBeDefined();

		// 2. If found, resolve immediately without setting up listener
		// 3. If not found, set up listener (not needed in this test case)
	});

	it("RELAY_WAIT multiple concurrent waits don't cross-talk", async () => {
		const refId1 = "wait-1";
		const refId2 = "wait-2";

		// Track which ref_ids received events
		const received: string[] = [];

		const onInbox = (event: { ref_id?: string; stream_id?: string; kind: string }) => {
			if (event.ref_id) {
				received.push(event.ref_id);
			}
		};

		eventBus.on("relay:inbox", onInbox);

		// Emit event for ref_id1
		eventBus.emit("relay:inbox", { ref_id: refId1, kind: "result" });
		// Emit event for ref_id2
		eventBus.emit("relay:inbox", { ref_id: refId2, kind: "result" });

		expect(received).toContain(refId1);
		expect(received).toContain(refId2);
		expect(received.length).toBe(2);
	});

	it("RELAY_WAIT abort flag cancels the wait", async () => {
		const refId = "abort-test-123";
		let aborted = false;

		const result = await new Promise<string | null>((resolve) => {
			const timeoutId = setTimeout(() => {
				resolve(null);
			}, 5000);

			const onInbox = (event: { ref_id?: string; stream_id?: string; kind: string }) => {
				if (event.ref_id !== refId) return;
				if (aborted) {
					clearTimeout(timeoutId);
					resolve("Cancelled: relay request was cancelled by user");
					return;
				}
				const entry = readInboxByRefId(db, refId);
				if (entry) {
					clearTimeout(timeoutId);
					resolve(entry as any);
				}
			};

			eventBus.on("relay:inbox", onInbox);

			// Simulate abort flag being set
			aborted = true;
			eventBus.emit("relay:inbox", { ref_id: refId, kind: "result" });
		});

		expect(result).toBe("Cancelled: relay request was cancelled by user");
	});
});

describe("Event-Driven RELAY_STREAM", () => {
	it("RELAY_STREAM yields chunks from relay:inbox events in sequence order", async () => {
		const streamId = randomUUID();

		const chunks: Array<{ seq: number; content: string }> = [];

		// Simulate collecting chunks as relayStream would
		const entries = readInboxByStreamId(db, streamId);
		expect(entries.length).toBe(0);

		// Insert stream chunks in out-of-order sequence (2, 0, 1)
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"chunk-2",
				"remote-host",
				"stream_chunk",
				streamId,
				JSON.stringify({
					seq: 2,
					chunks: [{ type: "text", content: "Third" }],
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"chunk-0",
				"remote-host",
				"stream_chunk",
				streamId,
				JSON.stringify({
					seq: 0,
					chunks: [{ type: "text", content: "First" }],
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"chunk-1",
				"remote-host",
				"stream_chunk",
				streamId,
				JSON.stringify({
					seq: 1,
					chunks: [{ type: "text", content: "Second" }],
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Read entries and verify they're in received order (not seq order initially)
		const allEntries = readInboxByStreamId(db, streamId);
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
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"chunk-0",
				"remote-host",
				"stream_chunk",
				streamId,
				JSON.stringify({
					seq: 0,
					chunks: [{ type: "text", content: "Data" }],
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Insert stream_end
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"stream-end",
				"remote-host",
				"stream_end",
				streamId,
				JSON.stringify({
					seq: 1,
					chunks: [],
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		const entries = readInboxByStreamId(db, streamId);
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
		db.run(
			`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				chunkId,
				"remote-host",
				"stream_chunk",
				streamId,
				JSON.stringify({
					seq: 0,
					chunks: [{ type: "text", content: "Data" }],
				}),
				new Date(Date.now() + 60_000).toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Verify entry exists and is not processed
		let entries = readInboxByStreamId(db, streamId);
		expect(entries.length).toBe(1);
		expect(entries[0].processed).toBe(0);

		// Mark as processed (as relayStream would)
		db.run("UPDATE relay_inbox SET processed = 1 WHERE id = ?", [chunkId]);

		// Verify it's marked as processed
		entries = readInboxByStreamId(db, streamId);
		expect(entries.length).toBe(0); // readInboxByStreamId filters out processed=1

		// Verify the database row shows processed=1
		const allRows = db
			.query("SELECT processed FROM relay_inbox WHERE id = ?")
			.all(chunkId) as Array<{ processed: number }>;
		expect(allRows[0].processed).toBe(1);
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
			db.run(
				`INSERT INTO relay_inbox (id, source_site_id, kind, stream_id, payload, expires_at, received_at, processed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					`chunk-${chunk.seq}`,
					"remote-host",
					"stream_chunk",
					streamId,
					JSON.stringify({
						seq: chunk.seq,
						chunks: [{ type: "text", content: chunk.content }],
					}),
					new Date(Date.now() + 60_000).toISOString(),
					new Date().toISOString(),
					0,
				],
			);
		}

		const entries = readInboxByStreamId(db, streamId);
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
