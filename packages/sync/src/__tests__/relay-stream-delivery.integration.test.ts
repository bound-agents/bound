/**
 * Relay stream delivery integration tests.
 *
 * Exercises the full spoke→hub→spoke relay path for inference stream chunks
 * with failure scenarios that reproduce production bugs:
 *
 * 1. Retransmission dedup: spoke retransmits chunks after a failed sync response,
 *    hub deduplicates via INSERT OR IGNORE on the original outbox entry ID.
 *
 * 2. Concurrent sync cycles: multiple sync:trigger events fire while a cycle is
 *    in-flight, coalescing into a single follow-up instead of racing.
 *
 * 3. Chunk delivery ordering: chunks flushed in rapid succession arrive in the
 *    correct seq order despite being split across sync cycles.
 *
 * Uses real HTTP servers, real Ed25519 auth, and real SQLite — no mocking.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readUndelivered, writeOutbox } from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { createTestInstance } from "./test-harness.js";
import type { TestInstance } from "./test-harness.js";

describe("relay stream delivery", () => {
	let hub: TestInstance;
	let spoke: TestInstance;
	let testRunId: string;
	let keyring: KeyringConfig;

	beforeEach(async () => {
		testRunId = randomBytes(4).toString("hex");
		const hubPort = 10000 + Math.floor(Math.random() * 40000);
		const spokePort = hubPort + 1;

		const hubKeypair = await ensureKeypair(`/tmp/bound-relay-stream-hub-${testRunId}`);
		const spokeKeypair = await ensureKeypair(`/tmp/bound-relay-stream-spoke-${testRunId}`);

		keyring = {
			hosts: {
				[hubKeypair.siteId]: {
					public_key: await exportPublicKey(hubKeypair.publicKey),
					url: `http://localhost:${hubPort}`,
				},
				[spokeKeypair.siteId]: {
					public_key: await exportPublicKey(spokeKeypair.publicKey),
					url: `http://localhost:${spokePort}`,
				},
			},
		};

		hub = await createTestInstance({
			name: "hub",
			port: hubPort,
			dbPath: `/tmp/bound-relay-stream-hub-${testRunId}/bound.db`,
			role: "hub",
			keyring,
			keypairPath: `/tmp/bound-relay-stream-hub-${testRunId}`,
		});

		spoke = await createTestInstance({
			name: "spoke",
			port: spokePort,
			dbPath: `/tmp/bound-relay-stream-spoke-${testRunId}/bound.db`,
			role: "spoke",
			hubPort,
			keyring,
			keypairPath: `/tmp/bound-relay-stream-spoke-${testRunId}`,
		});
	});

	afterEach(async () => {
		await hub.cleanup();
		await spoke.cleanup();
	});

	/**
	 * Helper: write stream chunks to spoke's relay_outbox targeting the hub.
	 * Returns the outbox entry IDs for verification.
	 */
	function writeStreamChunks(
		streamId: string,
		seqs: number[],
		isFinal: number | null = null,
	): string[] {
		const now = new Date();
		const ids: string[] = [];
		for (const seq of seqs) {
			const id = randomUUID();
			ids.push(id);
			const kind = seq === isFinal ? "stream_end" : "stream_chunk";
			const chunks =
				kind === "stream_end"
					? [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }]
					: [{ type: "text", content: `chunk-${seq}` }];
			writeOutbox(spoke.db, {
				id,
				source_site_id: spoke.siteId,
				target_site_id: hub.siteId,
				kind,
				ref_id: null,
				idempotency_key: null,
				stream_id: streamId,
				payload: JSON.stringify({ seq, chunks }),
				created_at: new Date(now.getTime() + seq).toISOString(),
				expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
			});
		}
		return ids;
	}

	/**
	 * Helper: count unprocessed relay_inbox entries on hub for a given stream_id.
	 */
	function hubInboxCount(streamId: string): number {
		const row = hub.db
			.query("SELECT count(*) as cnt FROM relay_inbox WHERE stream_id = ? AND processed = 0")
			.get(streamId) as { cnt: number };
		return row.cnt;
	}

	/**
	 * Helper: count ALL relay_inbox entries on hub for a given stream_id (including processed).
	 */
	function hubInboxTotal(streamId: string): number {
		const row = hub.db
			.query("SELECT count(*) as cnt FROM relay_inbox WHERE stream_id = ?")
			.get(streamId) as { cnt: number };
		return row.cnt;
	}

	/**
	 * Helper: get seq numbers from hub's relay_inbox for a stream.
	 */
	function hubInboxSeqs(streamId: string): number[] {
		const rows = hub.db
			.query("SELECT payload FROM relay_inbox WHERE stream_id = ? ORDER BY received_at")
			.all(streamId) as Array<{ payload: string }>;
		return rows.map((r) => JSON.parse(r.payload).seq);
	}

	it("delivers all stream chunks from spoke to hub via single sync cycle", async () => {
		const streamId = randomUUID();
		writeStreamChunks(streamId, [0, 1, 2, 3], 3);

		// Sync: spoke pushes to hub
		const result = await spoke.syncClient!.syncCycle();
		expect(result.ok).toBe(true);

		// All 4 entries should be in hub's relay_inbox
		expect(hubInboxTotal(streamId)).toBe(4);
		expect(hubInboxSeqs(streamId)).toEqual([0, 1, 2, 3]);
	});

	it("deduplicates retransmitted stream chunks on second sync cycle", async () => {
		const streamId = randomUUID();
		const outboxIds = writeStreamChunks(streamId, [0, 1, 2], 2);

		// First sync: all chunks delivered
		const result1 = await spoke.syncClient!.syncCycle();
		expect(result1.ok).toBe(true);
		expect(hubInboxTotal(streamId)).toBe(3);

		// Simulate retransmission: un-mark as delivered on spoke (as if response was lost)
		spoke.db.run(
			`UPDATE relay_outbox SET delivered = 0 WHERE id IN (${outboxIds.map(() => "?").join(",")})`,
			outboxIds,
		);

		// Second sync: same chunks retransmitted
		const result2 = await spoke.syncClient!.syncCycle();
		expect(result2.ok).toBe(true);

		// Hub should still have exactly 3 entries (no duplicates)
		expect(hubInboxTotal(streamId)).toBe(3);
	});

	it("handles interleaved chunks from multiple concurrent streams", async () => {
		const streamA = randomUUID();
		const streamB = randomUUID();

		// Write interleaved chunks: A0, B0, A1, B1, A2(end), B2(end)
		const now = new Date();
		const entries = [
			{ stream: streamA, seq: 0, kind: "stream_chunk" },
			{ stream: streamB, seq: 0, kind: "stream_chunk" },
			{ stream: streamA, seq: 1, kind: "stream_chunk" },
			{ stream: streamB, seq: 1, kind: "stream_chunk" },
			{ stream: streamA, seq: 2, kind: "stream_end" },
			{ stream: streamB, seq: 2, kind: "stream_end" },
		];

		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const chunks =
				e.kind === "stream_end"
					? [{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } }]
					: [{ type: "text", content: `${e.stream === streamA ? "A" : "B"}-${e.seq}` }];
			writeOutbox(spoke.db, {
				id: randomUUID(),
				source_site_id: spoke.siteId,
				target_site_id: hub.siteId,
				kind: e.kind,
				ref_id: null,
				idempotency_key: null,
				stream_id: e.stream,
				payload: JSON.stringify({ seq: e.seq, chunks }),
				created_at: new Date(now.getTime() + i).toISOString(),
				expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
			});
		}

		// Single sync delivers all
		const result = await spoke.syncClient!.syncCycle();
		expect(result.ok).toBe(true);

		// Each stream has exactly 3 entries, no cross-contamination
		expect(hubInboxTotal(streamA)).toBe(3);
		expect(hubInboxTotal(streamB)).toBe(3);
		expect(hubInboxSeqs(streamA)).toEqual([0, 1, 2]);
		expect(hubInboxSeqs(streamB)).toEqual([0, 1, 2]);
	});

	it("chunks split across multiple sync cycles all arrive at hub", async () => {
		const streamId = randomUUID();

		// First batch: seq 0-1
		writeStreamChunks(streamId, [0, 1]);
		const result1 = await spoke.syncClient!.syncCycle();
		expect(result1.ok).toBe(true);
		expect(hubInboxTotal(streamId)).toBe(2);

		// Second batch: seq 2-3 (stream_end)
		writeStreamChunks(streamId, [2, 3], 3);
		const result2 = await spoke.syncClient!.syncCycle();
		expect(result2.ok).toBe(true);

		// All 4 entries present, in order
		expect(hubInboxTotal(streamId)).toBe(4);
		expect(hubInboxSeqs(streamId)).toEqual([0, 1, 2, 3]);
	});

	it("retransmission of partial delivery doesn't create duplicates", async () => {
		const streamId = randomUUID();
		const outboxIds = writeStreamChunks(streamId, [0, 1, 2, 3], 3);

		// First sync: delivers all 4
		const result1 = await spoke.syncClient!.syncCycle();
		expect(result1.ok).toBe(true);
		expect(hubInboxTotal(streamId)).toBe(4);

		// Simulate: spoke thinks only seq 0 and 1 were delivered (2 and 3 lost in response)
		spoke.db.run("UPDATE relay_outbox SET delivered = 0 WHERE id IN (?, ?)", [
			outboxIds[2],
			outboxIds[3],
		]);

		// Second sync: retransmits seq 2 and 3
		const result2 = await spoke.syncClient!.syncCycle();
		expect(result2.ok).toBe(true);

		// Still exactly 4 entries (seq 2 and 3 deduped by original outbox ID)
		expect(hubInboxTotal(streamId)).toBe(4);
		expect(hubInboxSeqs(streamId)).toEqual([0, 1, 2, 3]);
	});

	it("full retransmission of all chunks doesn't create duplicates", async () => {
		const streamId = randomUUID();
		const outboxIds = writeStreamChunks(streamId, [0, 1, 2, 3, 4], 4);

		// First sync
		await spoke.syncClient!.syncCycle();
		expect(hubInboxTotal(streamId)).toBe(5);

		// Mark ALL as undelivered (total response loss)
		spoke.db.run(
			`UPDATE relay_outbox SET delivered = 0 WHERE id IN (${outboxIds.map(() => "?").join(",")})`,
			outboxIds,
		);

		// Retransmit everything
		await spoke.syncClient!.syncCycle();

		// Still exactly 5 entries
		expect(hubInboxTotal(streamId)).toBe(5);
	});

	it("spoke outbox entries for multiple targets are delivered correctly", async () => {
		const streamId = randomUUID();
		const now = new Date();

		// Write chunks targeting the hub
		writeStreamChunks(streamId, [0, 1], 1);

		// Also write an unrelated entry targeting a different site
		writeOutbox(spoke.db, {
			id: randomUUID(),
			source_site_id: spoke.siteId,
			target_site_id: "other-site-id",
			kind: "tool_call",
			ref_id: null,
			idempotency_key: `test-${randomUUID()}`,
			stream_id: null,
			payload: JSON.stringify({ tool: "bash", args: {} }),
			created_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
		});

		// Sync delivers hub-targeted chunks and routes other-target entry
		const result = await spoke.syncClient!.syncCycle();
		expect(result.ok).toBe(true);

		// Hub's relay_inbox has the stream chunks
		expect(hubInboxTotal(streamId)).toBe(2);

		// The other-target entry was routed to hub's outbox (for later delivery)
		const hubOutbox = readUndelivered(hub.db, "other-site-id");
		expect(hubOutbox.length).toBe(1);
		expect(hubOutbox[0].kind).toBe("tool_call");
	});

	it("rapid consecutive sync cycles don't lose chunks", async () => {
		const streamId = randomUUID();

		// Write first batch
		writeStreamChunks(streamId, [0, 1]);

		// Fire 3 sync cycles in rapid succession (simulating rapid sync:trigger)
		const results = await Promise.all([
			spoke.syncClient!.syncCycle(),
			spoke.syncClient!.syncCycle(),
			spoke.syncClient!.syncCycle(),
		]);

		// At least one should succeed
		const successes = results.filter((r) => r.ok);
		expect(successes.length).toBeGreaterThanOrEqual(1);

		// Write second batch and sync again
		writeStreamChunks(streamId, [2, 3], 3);
		await spoke.syncClient!.syncCycle();

		// All chunks should have arrived (no lost chunks from racing)
		expect(hubInboxTotal(streamId)).toBe(4);
		expect(hubInboxSeqs(streamId)).toEqual([0, 1, 2, 3]);
	});
});
