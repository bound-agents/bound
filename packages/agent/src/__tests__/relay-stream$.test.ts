import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subject, lastValueFrom } from "rxjs";
import { tap } from "rxjs/operators";

import { applySchema, insertDurableWork } from "@bound/core";
import type { StreamChunk } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { createRelayStream$ } from "../relay-stream$";

const mockLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

function createTestDb(): { db: Database; tmpDir: string } {
	// tmpdir() works on Windows where the previous "/tmp" path did not exist.
	const tmpDir = mkdtempSync(join(tmpdir(), "bound-test-"));
	const dbPath = join(tmpDir, "test.db");
	const db = new Database(dbPath);
	applySchema(db);
	return { db, tmpDir };
}

async function cleanup(db: Database, tmpDir: string) {
	try {
		db.close();
	} catch (_e) {
		/* already closed */
	}
	// cleanupTmpDir retries on Windows EBUSY where SQLite WAL/SHM handles
	// occasionally outlive db.close(); bare rmSync fails immediately.
	await cleanupTmpDir(tmpDir);
}

function getStreamIdFromOutbox(db: Database): string {
	const row = db
		.prepare("SELECT stream_id FROM relay_outbox ORDER BY created_at DESC LIMIT 1")
		.get() as { stream_id: string } | null;
	if (!row) throw new Error("No outbox entry found");
	return row.stream_id;
}

function insertRelayInboxEntry(
	db: Database,
	opts: {
		id: string;
		sourceSiteId: string;
		kind: string;
		streamId: string;
		payload: string;
	},
) {
	db.prepare(
		`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		opts.id,
		opts.sourceSiteId,
		opts.kind,
		null,
		null,
		opts.streamId,
		opts.payload,
		new Date(Date.now() + 300_000).toISOString(),
		new Date().toISOString(),
		0,
	);
}

const eligibleHostFixture = (siteId: string, hostName: string) => ({
	site_id: siteId,
	host_name: hostName,
	sync_url: null,
	online_at: new Date().toISOString(),
	modified_at: new Date().toISOString(),
});

/**
 * Poll until `predicate` is true or the timeout elapses. Used in timing tests
 * to wait for an asynchronous condition (e.g. a relay timeout's downstream
 * outbox write) deterministically, rather than sleeping a fixed wall-clock
 * interval. A fixed sleep assumes the condition completes within a fixed
 * budget, which races on a loaded CI runner; polling proceeds the moment the
 * condition holds and only fails if it never does.
 */
async function pollUntil(
	predicate: () => boolean,
	opts: { timeoutMs: number; intervalMs: number },
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > opts.timeoutMs) {
			throw new Error(`pollUntil timed out after ${opts.timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, opts.intervalMs));
	}
}

const payloadFixture = {
	model: "test-model",
	segments: [{ role: "user" as const, content: "hello" }].map((m) => ({
		kind: "inline" as const,
		message: m,
	})),
	nowMs: 0,
};

describe("createRelayStream$", () => {
	let db: Database;
	let tmpDir: string;

	afterEach(async () => {
		await cleanup(db, tmpDir);
	});

	it("AC1.1: Sequential chunks emitted immediately", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});

		await subscribed;
		const streamId = getStreamIdFromOutbox(db);

		for (let seq = 0; seq < 3; seq++) {
			insertRelayInboxEntry(db, {
				id: `entry-${seq}`,
				sourceSiteId: remoteHost,
				kind: "stream_chunk",
				streamId,
				payload: JSON.stringify({
					seq,
					chunks: [{ type: "text_delta", text: String.fromCharCode(97 + seq) }],
				}),
			});
		}

		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteHost,
			kind: "stream_end",
			streamId,
			payload: JSON.stringify({ seq: 2, chunks: [] }),
		});

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		expect(chunks.length).toBe(3);
		expect(chunks[0]).toEqual({ type: "text_delta", text: "a" });
		expect(chunks[1]).toEqual({ type: "text_delta", text: "b" });
		expect(chunks[2]).toEqual({ type: "text_delta", text: "c" });
	});

	it("AC1.2: Out-of-order chunks reordered correctly", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});

		await subscribed;
		const streamId = getStreamIdFromOutbox(db);

		const sequences = [0, 2, 1];
		for (const seq of sequences) {
			insertRelayInboxEntry(db, {
				id: `entry-${seq}`,
				sourceSiteId: remoteHost,
				kind: "stream_chunk",
				streamId,
				payload: JSON.stringify({
					seq,
					chunks: [{ type: "text_delta", text: String.fromCharCode(97 + seq) }],
				}),
			});
		}

		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteHost,
			kind: "stream_end",
			streamId,
			payload: JSON.stringify({ seq: 2, chunks: [] }),
		});

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		expect(chunks.length).toBe(3);
		expect(chunks[0]).toEqual({ type: "text_delta", text: "a" });
		expect(chunks[1]).toEqual({ type: "text_delta", text: "b" });
		expect(chunks[2]).toEqual({ type: "text_delta", text: "c" });
	});

	it("AC1.3: Normal completion on stream_end", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const remoteHost = "spoke-1";
		let completed = false;

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		const done = lastValueFrom(stream$, { defaultValue: undefined }).then(() => {
			completed = true;
		});

		await subscribed;
		const streamId = getStreamIdFromOutbox(db);

		insertRelayInboxEntry(db, {
			id: "entry-0",
			sourceSiteId: remoteHost,
			kind: "stream_chunk",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "a" }] }),
		});

		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteHost,
			kind: "stream_end",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [] }),
		});

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;
		expect(completed).toBe(true);
	});

	it("AC1.9: Metadata capture on first chunk", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const metadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};
		const remoteHost = "spoke-1";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			metadataRef,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		const done = lastValueFrom(stream$, { defaultValue: undefined });

		await subscribed;
		const streamId = getStreamIdFromOutbox(db);

		insertRelayInboxEntry(db, {
			id: "entry-0",
			sourceSiteId: remoteHost,
			kind: "stream_chunk",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "a" }] }),
		});

		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteHost,
			kind: "stream_end",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [] }),
		});

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		expect(metadataRef.hostName).toBe("spoke-1.local");
		expect(typeof metadataRef.firstChunkLatencyMs).toBe("number");
		expect(metadataRef.firstChunkLatencyMs).toBeGreaterThanOrEqual(0);
	});

	it("AC1.10: Two-host failover when first host times out, second succeeds", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHosts = ["spoke-1", "spoke-2"];

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[
				eligibleHostFixture(remoteHosts[0], "spoke-1.local"),
				eligibleHostFixture(remoteHosts[1], "spoke-2.local"),
			] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 1000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});

		await subscribed;

		// Get first outbox entry (spoke-1)
		const firstStreamId = getStreamIdFromOutbox(db);

		// The first host times out; the stream then switches to spoke-2 and
		// writes a second 'inference' outbox entry (plus a cancel for the first
		// host). Poll for that second inference entry instead of sleeping. Keep
		// the timeout comfortably above the polling/SQLite work: this test covers
		// failover semantics, not a 200ms scheduling deadline on loaded CI.
		await pollUntil(
			() =>
				(
					db.prepare("SELECT COUNT(*) as cnt FROM relay_outbox WHERE kind = 'inference'").get() as {
						cnt: number;
					}
				).cnt >= 2,
			{ timeoutMs: 5000, intervalMs: 25 },
		);

		// Get second outbox entry (spoke-2) - query from after first entry
		const secondEntry = db
			.prepare("SELECT stream_id FROM relay_outbox ORDER BY created_at DESC LIMIT 1")
			.get() as { stream_id: string } | null;
		if (!secondEntry || secondEntry.stream_id === firstStreamId) {
			throw new Error("Second outbox entry not found");
		}
		const secondStreamId = secondEntry.stream_id;

		// Verify we have at least 2 inference outbox entries (plus a cancel for first host timeout)
		const inferenceOutbox = db
			.prepare("SELECT COUNT(*) as cnt FROM relay_outbox WHERE kind = 'inference'")
			.get() as { cnt: number };
		expect(inferenceOutbox.cnt).toBe(2);

		// Now insert response for second host (first host has timed out and won't be responded to)
		insertRelayInboxEntry(db, {
			id: "entry-0",
			sourceSiteId: remoteHosts[1],
			kind: "stream_chunk",
			streamId: secondStreamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "success" }] }),
		});

		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteHosts[1],
			kind: "stream_end",
			streamId: secondStreamId,
			payload: JSON.stringify({ seq: 0, chunks: [] }),
		});

		eventBus.emit("relay:inbox", { stream_id: secondStreamId, kind: "stream_chunk" as const });

		await done;

		expect(chunks.length).toBe(1);
		expect(chunks[0]).toEqual({ type: "text_delta", text: "success" });
	});

	it("AC1.11: Single host timeout errors with correct message", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const remoteHost = "spoke-1";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 150, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		let error: Error | null = null;
		const done = lastValueFrom(stream$, { defaultValue: undefined })
			.then(() => undefined)
			.catch((err) => {
				error = err;
			});

		await subscribed;
		const _streamId = getStreamIdFromOutbox(db);

		// Wait for timeout
		await new Promise<void>((resolve) => setTimeout(resolve, 250));

		// Don't insert any responses - just let it timeout
		await done;

		expect(error).toBeDefined();
		expect(error?.message).toContain("all 1 eligible host(s) timed out");
	});

	it("AC1.12: Host returning error propagates error message", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const remoteHost = "spoke-1";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		let error: Error | null = null;
		const done = lastValueFrom(stream$, { defaultValue: undefined })
			.then(() => undefined)
			.catch((err) => {
				error = err;
			});

		await subscribed;
		const streamId = getStreamIdFromOutbox(db);

		// Insert error entry
		insertRelayInboxEntry(db, {
			id: "error-entry",
			sourceSiteId: remoteHost,
			kind: "error",
			streamId,
			payload: JSON.stringify({ error: "Model not found" }),
		});

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "error" as const });

		await done;

		expect(error).toBeDefined();
		expect(error?.message).toContain("Model not found");
	});

	it("fails over when heartbeats arrive but no model content reaches the first-token deadline", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const hosts = [
			eligibleHostFixture("spoke-1", "spoke-1.local"),
			eligibleHostFixture("spoke-2", "spoke-2.local"),
		] as any;
		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			hosts,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 500, firstTokenTimeoutMs: 80, pollIntervalMs: 10 },
		);
		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const firstStreamId = getStreamIdFromOutbox(db);
		let heartbeatSeq = 0;
		const heartbeatTimer = setInterval(() => {
			insertRelayInboxEntry(db, {
				id: `heartbeat-${heartbeatSeq}`,
				sourceSiteId: "spoke-1",
				kind: "stream_chunk",
				streamId: firstStreamId,
				payload: JSON.stringify({ seq: heartbeatSeq++, chunks: [] }),
			});
			eventBus.emit("relay:inbox", { stream_id: firstStreamId, kind: "stream_chunk" as const });
		}, 20);
		await pollUntil(
			() =>
				(
					db
						.prepare("SELECT COUNT(*) AS count FROM relay_outbox WHERE kind = 'inference'")
						.get() as {
						count: number;
					}
				).count === 2,
			{ timeoutMs: 500, intervalMs: 10 },
		);
		clearInterval(heartbeatTimer);
		const secondStreamId = getStreamIdFromOutbox(db);
		insertRelayInboxEntry(db, {
			id: "real-0",
			sourceSiteId: "spoke-2",
			kind: "stream_chunk",
			streamId: secondStreamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "fallback" }] }),
		});
		insertRelayInboxEntry(db, {
			id: "end-1",
			sourceSiteId: "spoke-2",
			kind: "stream_end",
			streamId: secondStreamId,
			payload: JSON.stringify({ seq: 1, chunks: [] }),
		});
		eventBus.emit("relay:inbox", { stream_id: secondStreamId, kind: "stream_chunk" as const });
		await done;
		expect(chunks).toEqual([{ type: "text_delta", text: "fallback" }]);
	});

	it("AC1.4: Only first host is tried when it succeeds immediately", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		const subscribed = new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});

		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});

		await subscribed;
		const streamId = getStreamIdFromOutbox(db);

		// Insert successful response from the host
		insertRelayInboxEntry(db, {
			id: "entry-0",
			sourceSiteId: remoteHost,
			kind: "stream_chunk",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "success" }] }),
		});

		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteHost,
			kind: "stream_end",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [] }),
		});

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		// Verify response was delivered
		expect(chunks.length).toBe(1);
		expect(chunks[0]).toEqual({ type: "text_delta", text: "success" });

		// Verify exactly one inference outbox entry was created when host succeeds
		const outbox = db
			.prepare("SELECT COUNT(*) as cnt FROM relay_outbox WHERE kind = 'inference'")
			.get() as { cnt: number };
		expect(outbox.cnt).toBe(1);
	});

	it("splits an oversized inference request into relay-safe parts", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const remoteHost = "spoke-1";
		const maxPayloadBytes = 512;
		const stream$ = createRelayStream$(
			{ db, eventBus, siteId: "hub", logger: mockLogger, maxPayloadBytes },
			{
				...payloadFixture,
				segments: [
					{ kind: "inline" as const, message: { role: "user", content: "電".repeat(4000) } },
				],
			} as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 100, firstTokenTimeoutMs: 100, pollIntervalMs: 20 },
		);
		await lastValueFrom(stream$, { defaultValue: undefined }).catch(() => undefined);
		const rows = db
			.prepare(
				"SELECT kind, ref_id, stream_id, payload FROM relay_outbox WHERE kind = 'inference_part'",
			)
			.all() as Array<{ kind: string; ref_id: string; stream_id: string; payload: string }>;
		expect(rows.length).toBeGreaterThan(1);
		expect(new Set(rows.map((row) => row.ref_id)).size).toBe(1);
		expect(new Set(rows.map((row) => row.stream_id)).size).toBe(1);
		for (const row of rows) {
			expect(new TextEncoder().encode(row.payload).byteLength).toBeLessThanOrEqual(maxPayloadBytes);
		}
		expect(
			(
				db.prepare("SELECT COUNT(*) AS count FROM relay_outbox WHERE kind = 'inference'").get() as {
					count: number;
				}
			).count,
		).toBe(0);
	});
});

describe("createRelayStream$ — 4D-D durable chunk union", () => {
	let db: Database;
	let tmpDir: string;

	afterEach(async () => {
		await cleanup(db, tmpDir);
	});

	// The reducer reads the UNION of legacy relay_inbox chunk rows and pending
	// durable chunk rows targeted at self for its stream_id, folding both through
	// the same seq-dedup loop and consuming durable rows exactly-once.
	function insertDurableChunk(
		database: Database,
		opts: {
			id: string;
			kind: string;
			streamId: string;
			target: string;
			source: string;
			seq: number;
			chunks: unknown[];
		},
	): void {
		const now = new Date().toISOString();
		database
			.prepare(`
				INSERT INTO durable_work
				(id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, stream_id, source_site)
				VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
			`)
			.run(
				opts.id,
				opts.target,
				opts.kind,
				JSON.stringify({ seq: opts.seq, chunks: opts.chunks }),
				`stream:${opts.streamId}:${opts.seq}`,
				now,
				opts.streamId,
				opts.source,
			);
	}

	it("folds durable chunk rows through seq-dedup and consumes them, completing on durable stream_end", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";
		const siteId = "hub";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId, logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});
		const streamId = getStreamIdFromOutbox(db);

		for (let seq = 0; seq < 3; seq++) {
			insertDurableChunk(db, {
				id: `dur-chunk-${seq}`,
				kind: "stream_chunk",
				streamId,
				target: siteId,
				source: remoteHost,
				seq,
				chunks: [{ type: "text_delta", text: String.fromCharCode(97 + seq) }],
			});
		}
		insertDurableChunk(db, {
			id: "dur-stream-end",
			kind: "stream_end",
			streamId,
			target: siteId,
			source: remoteHost,
			seq: 3,
			chunks: [],
		});
		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		expect(chunks.map((c) => (c as { text: string }).text)).toEqual(["a", "b", "c"]);
		const leftover = db
			.prepare(
				"SELECT COUNT(*) AS count FROM durable_work WHERE stream_id = ? AND claim_state != 'consumed'",
			)
			.get(streamId) as { count: number };
		expect(leftover.count).toBe(0);
	});

	it("a redelivered durable chunk (same seq) does not duplicate output", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";
		const siteId = "hub";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId, logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});
		const streamId = getStreamIdFromOutbox(db);

		// seq 0 folded and consumed. Model a redelivered transfer via insertDurableWork
		// (the receiver's INSERT OR IGNORE), which is fenced by (kind, idempotency_key):
		// only one row for stream:<id>:0 ever exists, so the consumer emits "a" once.
		insertDurableChunk(db, {
			id: "dur-chunk-0",
			kind: "stream_chunk",
			streamId,
			target: siteId,
			source: remoteHost,
			seq: 0,
			chunks: [{ type: "text_delta", text: "a" }],
		});
		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });
		await new Promise((resolve) => setTimeout(resolve, 120));

		// A redelivered transfer of the SAME logical chunk: fresh id, identical
		// (kind, idempotency_key). insertDurableWork's INSERT OR IGNORE fences it.
		const redelivered = insertDurableWork(db, {
			id: "dur-chunk-0-redelivered",
			target_site_id: siteId,
			kind: "stream_chunk",
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "a" }] }),
			idempotency_key: `stream:${streamId}:0`,
			stream_id: streamId,
			source_site: remoteHost,
		});
		expect(redelivered).toBe(false); // fence held — no second row for seq 0
		insertDurableChunk(db, {
			id: "dur-stream-end",
			kind: "stream_end",
			streamId,
			target: siteId,
			source: remoteHost,
			seq: 1,
			chunks: [],
		});
		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		expect(chunks.map((c) => (c as { text: string }).text)).toEqual(["a"]);
	});

	it("a chunk crash before ack boot-resets the row; re-fold yields no duplicates and no gaps", async () => {
		// OBJECTION 2 crash-window: the required order is claim → deliver → ack. A chunk
		// row is CLAIMED while folding, but its ack is deferred until AFTER its content is
		// emitted downstream. This test drives the recovery property directly: emit seq 0
		// and 1, simulate a crash before their acks (boot-reset processing → pending), then
		// re-fold. seq-dedup (nextExpectedSeq guard) must suppress the replayed seqs, so
		// downstream output has NO duplicates and NO gaps.
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";
		const siteId = "hub";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId, logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});
		const streamId = getStreamIdFromOutbox(db);

		// Deliver seq 0 and seq 1; the reducer folds, emits, and (post-emission) acks.
		for (let seq = 0; seq < 2; seq++) {
			insertDurableChunk(db, {
				id: `dur-recover-${seq}`,
				kind: "stream_chunk",
				streamId,
				target: siteId,
				source: remoteHost,
				seq,
				chunks: [{ type: "text_delta", text: String.fromCharCode(97 + seq) }],
			});
		}
		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });
		// Wait until both seqs have been emitted downstream.
		await pollUntil(() => chunks.length >= 2, { timeoutMs: 2000, intervalMs: 20 });

		// CRASH WINDOW: model a crash between emission and ack. The pipeline acks each
		// seq to 'consumed' only AFTER emitting it downstream; a crash in that window
		// leaves the ack unwritten. Boot recovery would find the row still claimable and
		// re-present it. We model that directly: force the two already-emitted rows back
		// to 'pending' (the state a lost ack + boot reset yields) and re-fire the poll.
		// If the consumer re-emitted them, output would gain duplicates. It must not:
		// nextExpectedSeq has already advanced past seq 0 and 1, so seq-dedup suppresses
		// the replay and simply re-settles the rows.
		db.run(
			"UPDATE durable_work SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL, consumed_at = NULL WHERE stream_id = ? AND claim_state = 'consumed'",
			[streamId],
		);
		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Now deliver the terminator at seq 2 to complete the stream.
		insertDurableChunk(db, {
			id: "dur-recover-end",
			kind: "stream_end",
			streamId,
			target: siteId,
			source: remoteHost,
			seq: 2,
			chunks: [],
		});
		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		// No duplicates and no gaps: exactly ["a", "b"], each once, in order.
		expect(chunks.map((c) => (c as { text: string }).text)).toEqual(["a", "b"]);
		// All rows retired (replayed copies were folded-and-settled without re-emission).
		const leftover = db
			.prepare(
				"SELECT COUNT(*) AS count FROM durable_work WHERE stream_id = ? AND claim_state != 'consumed'",
			)
			.get(streamId) as { count: number };
		expect(leftover.count).toBe(0);
	});

	it("a stream_chunk and a stream_end at the SAME seq coexist as distinct durable rows and the stream completes", async () => {
		// OBJECTION 3 coexistence: keys are stream:<id>:<seq> for BOTH stream_chunk and
		// stream_end. They do not collide because the unique index is (kind,
		// idempotency_key) and the kinds differ. Prove both rows persist at the same seq
		// and the terminator is not dropped (dropping it would hang the await path).
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const aborted$ = new Subject<void>();
		const chunks: StreamChunk[] = [];
		const remoteHost = "spoke-1";
		const siteId = "hub";

		const stream$ = createRelayStream$(
			{ db, eventBus, siteId, logger: mockLogger },
			payloadFixture as any,
			[eligibleHostFixture(remoteHost, "spoke-1.local")] as any,
			aborted$,
			undefined,
			{ perHostTimeoutMs: 5000, pollIntervalMs: 50 },
		);

		await new Promise((resolve) => setTimeout(resolve, 20));
		const done = lastValueFrom(stream$.pipe(tap((chunk) => chunks.push(chunk))), {
			defaultValue: undefined,
		});
		const streamId = getStreamIdFromOutbox(db);

		// A content chunk at seq 0 and a terminator at seq 0 exist SIMULTANEOUSLY as
		// distinct rows. insertDurableWork's fence is on (kind, idempotency_key), so a
		// stream_chunk and a stream_end sharing stream:<id>:0 are two accepted rows.
		const chunkWritten = insertDurableWork(db, {
			id: "coexist-chunk-0",
			target_site_id: siteId,
			kind: "stream_chunk",
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text_delta", text: "a" }] }),
			idempotency_key: `stream:${streamId}:0`,
			stream_id: streamId,
			source_site: remoteHost,
		});
		const endWritten = insertDurableWork(db, {
			id: "coexist-end-0",
			target_site_id: siteId,
			kind: "stream_end",
			payload: JSON.stringify({ seq: 0, chunks: [] }),
			idempotency_key: `stream:${streamId}:0`,
			stream_id: streamId,
			source_site: remoteHost,
		});
		expect(chunkWritten).toBe(true);
		expect(endWritten).toBe(true); // same seq, different kind → NOT fenced

		// Both rows are durable at the same seq before the consumer folds them.
		const bothRows = db
			.prepare(
				"SELECT COUNT(*) AS count FROM durable_work WHERE stream_id = ? AND idempotency_key = ?",
			)
			.get(streamId, `stream:${streamId}:0`) as { count: number };
		expect(bothRows.count).toBe(2);

		eventBus.emit("relay:inbox", { stream_id: streamId, kind: "stream_chunk" as const });

		await done;

		// The content chunk emitted once; the terminator drove completion (await did not hang).
		expect(chunks.map((c) => (c as { text: string }).text)).toEqual(["a"]);
	});
});
