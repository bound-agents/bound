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
});
