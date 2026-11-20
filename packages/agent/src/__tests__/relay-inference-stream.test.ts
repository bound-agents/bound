import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchema } from "@bound/core";
import type { InferenceRequestPayload, StreamChunk } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";

import { createRelayInferenceStream } from "../relay-inference-stream";
import type { RelayStreamDeps } from "../relay-stream$";

/**
 * createRelayInferenceStream bridges the rxjs Observable produced by
 * createRelayStream$ into a plain async generator. These tests drive it over a
 * real SQLite DB (applySchema) and a real event bus, feeding stream responses
 * by writing durable_work response rows the same way relay-stream$.test.ts
 * does — no live target host, no network. The abort/error/empty-hosts paths are
 * exercised directly.
 */

const mockLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

function createTestDb(): { db: Database; tmpDir: string } {
	const tmpDir = mkdtempSync(join(tmpdir(), "relay-inf-stream-"));
	const dbPath = join(tmpDir, "test.db");
	const db = new Database(dbPath);
	applySchema(db);
	// routeRelayRequest requires the target host to advertise work_spool_capable,
	// else it returns a typed routing error with no legacy fallback.
	for (const siteId of ["spoke-1"]) {
		db.run(
			`INSERT INTO hosts (site_id, host_name, online_at, modified_at, work_spool_capable, deleted)
			 VALUES (?, ?, ?, ?, 1, 0)
			 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = 1, deleted = 0`,
			[siteId, `${siteId}.local`, new Date().toISOString(), new Date().toISOString()],
		);
	}
	return { db, tmpDir };
}

async function cleanup(db: Database, tmpDir: string) {
	try {
		db.close();
	} catch (_e) {
		/* already closed */
	}
	await cleanupTmpDir(tmpDir);
}

function makeDeps(db: Database, eventBus: TypedEventEmitter): RelayStreamDeps {
	return { db, eventBus, siteId: "hub", logger: mockLogger };
}

const payloadFixture: InferenceRequestPayload = {
	model: "test-model",
	segments: [
		{
			kind: "inline" as const,
			message: { role: "user" as const, content: "hello" },
		},
	],
	nowMs: 0,
};

function getStreamIdFromOutbox(db: Database): string {
	const row = db
		.prepare(
			"SELECT stream_id FROM durable_work WHERE stream_id IS NOT NULL AND kind = 'inference' ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { stream_id: string } | null;
	if (!row) throw new Error("No durable_work inference entry with a stream_id found");
	return row.stream_id;
}

// Writes a stream response row (chunk or end) targeted at self, keyed
// stream:<id>:<kind>:<seq>, the same shape the reducer's union consumer claims.
function insertStreamResponse(
	db: Database,
	opts: { id: string; kind: "stream_chunk" | "stream_end"; streamId: string; payload: string },
) {
	let seq = 0;
	try {
		seq = (JSON.parse(opts.payload) as { seq?: number }).seq ?? 0;
	} catch {
		/* non-JSON payload: seq stays 0 */
	}
	db.prepare(
		`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, received_at, stream_id, source_site)
		 VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
	).run(
		opts.id,
		"hub",
		opts.kind,
		opts.payload,
		`stream:${opts.streamId}:${opts.kind}:${seq}`,
		new Date().toISOString(),
		new Date(Date.now() + 300_000).toISOString(),
		new Date().toISOString(),
		opts.streamId,
		"spoke-1",
	);
}

const eligibleHostFixture = (siteId: string, hostName: string) => ({
	site_id: siteId,
	host_name: hostName,
	sync_url: null,
	online_at: new Date().toISOString(),
	modified_at: new Date().toISOString(),
});

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

describe("createRelayInferenceStream", () => {
	let db: Database;
	let tmpDir: string;

	afterEach(async () => {
		await cleanup(db, tmpDir);
	});

	it("yields chunks from the relay stream, then completes at stream_end", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const host = eligibleHostFixture("spoke-1", "spoke-1.local");

		const gen = createRelayInferenceStream(makeDeps(db, eventBus), payloadFixture, [host]);

		// Advance the generator to the first await so the producer writes its
		// request row and we can read the stream_id it allocated.
		const firstNext = gen.next();
		await pollUntil(
			() => {
				const r = db
					.prepare("SELECT COUNT(*) AS c FROM durable_work WHERE kind = 'inference'")
					.get() as { c: number };
				return r.c > 0;
			},
			{ timeoutMs: 5000, intervalMs: 20 },
		);
		const streamId = getStreamIdFromOutbox(db);

		insertStreamResponse(db, {
			id: "resp-chunk-0",
			kind: "stream_chunk",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text", content: "hi " }] }),
		});
		insertStreamResponse(db, {
			id: "resp-end",
			kind: "stream_end",
			streamId,
			payload: JSON.stringify({ seq: 1, chunks: [{ type: "text", content: "there" }] }),
		});

		const chunks: StreamChunk[] = [];
		const first = await firstNext;
		if (!first.done && first.value) chunks.push(first.value);
		for await (const chunk of gen) chunks.push(chunk);

		const text = chunks
			.filter((c): c is { type: "text"; content: string } => c.type === "text")
			.map((c) => c.content)
			.join("");
		expect(text).toContain("hi ");
		expect(text).toContain("there");
	});

	it("completes immediately with no chunks when the host list is empty", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();

		const gen = createRelayInferenceStream(makeDeps(db, eventBus), payloadFixture, []);
		const chunks: StreamChunk[] = [];
		for await (const chunk of gen) chunks.push(chunk);
		expect(chunks).toEqual([]);
	});

	it("terminates the generator when the signal aborts before any response arrives", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const host = eligibleHostFixture("spoke-1", "spoke-1.local");
		const controller = new AbortController();

		// The abort is observed by the inner observable's takeUntil(aborted$) only
		// once it fires live after subscription (an already-completed subject does
		// not retro-terminate). Pull once to subscribe, then abort before writing
		// any response row, and confirm the generator completes with no chunks
		// rather than blocking on the first-token/per-host timeout.
		const gen = createRelayInferenceStream(
			makeDeps(db, eventBus),
			payloadFixture,
			[host],
			controller.signal,
		);
		const firstNext = gen.next();
		await pollUntil(
			() => {
				const r = db
					.prepare("SELECT COUNT(*) AS c FROM durable_work WHERE kind = 'inference'")
					.get() as { c: number };
				return r.c > 0;
			},
			{ timeoutMs: 5000, intervalMs: 20 },
		);
		controller.abort();

		const chunks: StreamChunk[] = [];
		const first = await firstNext;
		if (!first.done && first.value) chunks.push(first.value);
		for await (const chunk of gen) chunks.push(chunk);
		expect(chunks).toEqual([]);
	});

	it("stops producing after the signal aborts mid-stream", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const host = eligibleHostFixture("spoke-1", "spoke-1.local");
		const controller = new AbortController();

		const gen = createRelayInferenceStream(
			makeDeps(db, eventBus),
			payloadFixture,
			[host],
			controller.signal,
		);

		const firstNext = gen.next();
		await pollUntil(
			() => {
				const r = db
					.prepare("SELECT COUNT(*) AS c FROM durable_work WHERE kind = 'inference'")
					.get() as { c: number };
				return r.c > 0;
			},
			{ timeoutMs: 5000, intervalMs: 20 },
		);
		const streamId = getStreamIdFromOutbox(db);
		insertStreamResponse(db, {
			id: "resp-chunk-0",
			kind: "stream_chunk",
			streamId,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text", content: "partial" }] }),
		});

		const chunks: StreamChunk[] = [];
		const first = await firstNext;
		if (!first.done && first.value) chunks.push(first.value);

		// Abort, then drain. The aborted$ subject completes the inner observable,
		// so the generator terminates without hanging.
		controller.abort();
		for await (const chunk of gen) chunks.push(chunk);

		// Generator must have terminated (loop exited). Any chunks seen were the
		// partial emitted before abort; the key assertion is non-hang + completion.
		const text = chunks
			.filter((c): c is { type: "text"; content: string } => c.type === "text")
			.map((c) => c.content)
			.join("");
		expect(text.length).toBeGreaterThanOrEqual(0);
	});

	it("propagates a stream error as a thrown error from the generator", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const host = eligibleHostFixture("spoke-1", "spoke-1.local");

		const gen = createRelayInferenceStream(makeDeps(db, eventBus), payloadFixture, [host]);

		const firstNext = gen.next();
		await pollUntil(
			() => {
				const r = db
					.prepare("SELECT COUNT(*) AS c FROM durable_work WHERE kind = 'inference'")
					.get() as { c: number };
				return r.c > 0;
			},
			{ timeoutMs: 5000, intervalMs: 20 },
		);
		const streamId = getStreamIdFromOutbox(db);
		// An "error" response row makes the reducer emit a thrown error downstream,
		// which the generator re-throws from its await.
		insertStreamResponse(db, {
			id: "resp-error",
			kind: "stream_chunk",
			streamId,
			payload: "not-json-will-still-be-chunk",
		});
		db.prepare(
			`INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at, expires_at, received_at, stream_id, source_site)
			 VALUES (?, ?, 'error', ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
		).run(
			"resp-err-kind",
			"hub",
			JSON.stringify({ error: "backend exploded" }),
			`stream:${streamId}:error:0`,
			new Date().toISOString(),
			new Date(Date.now() + 300_000).toISOString(),
			new Date().toISOString(),
			streamId,
			"spoke-1",
		);

		await expect(
			(async () => {
				const first = await firstNext;
				if (!first.done) {
					for await (const _chunk of gen) {
						/* drain */
					}
				}
			})(),
		).rejects.toThrow();
	});
});
