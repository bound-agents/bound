import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Subject, lastValueFrom } from "rxjs";
import { tap } from "rxjs/operators";

import { applySchema } from "@bound/core";
import type { StreamChunk } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { createRelayStream$ } from "../relay-stream$";

const mockLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

function createTestDb(): { db: Database; tmpDir: string } {
	const tmpDir = mkdtempSync(join("/tmp", "bound-test-"));
	const dbPath = join(tmpDir, "test.db");
	const db = new Database(dbPath);
	applySchema(db);
	return { db, tmpDir };
}

function cleanup(db: Database, tmpDir: string) {
	try {
		db.close();
	} catch (_e) {
		/* already closed */
	}
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch (_e) {
		/* already removed */
	}
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

const payloadFixture = {
	model: "test-model",
	messages: [{ role: "user" as const, content: "hello" }],
};

describe("createRelayStream$", () => {
	let db: Database;
	let tmpDir: string;

	afterEach(() => {
		cleanup(db, tmpDir);
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
			{ perHostTimeoutMs: 200, pollIntervalMs: 50 },
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

		// First host timeout occurs after 200ms. Meanwhile, second host outbox entry gets created.
		// Wait for timeout to occur and second host to be attempted
		await new Promise<void>((resolve) => setTimeout(resolve, 300));

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
});
