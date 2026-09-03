import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchema } from "@bound/core";
import type { StreamChunk } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { createRelayBackend } from "../relay-backend";
import type { EligibleHost } from "../relay-router";

const mockLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

function createTestDb(): { db: Database; tmpDir: string } {
	const tmpDir = mkdtempSync(join(tmpdir(), "bound-test-"));
	const db = new Database(join(tmpDir, "test.db"));
	applySchema(db);
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000, pollMs = 10): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

function getInferenceOutboxRow(db: Database): { stream_id: string; payload: string } | null {
	return db
		.prepare(
			"SELECT stream_id, payload FROM durable_work WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { stream_id: string; payload: string } | null;
}

// Post-N+1: stream responses ride the durable_work spool as self-targeted rows
// keyed by stream_id, consumed by the awaiter's union read.
function insertRelayInboxEntry(
	db: Database,
	opts: { id: string; sourceSiteId: string; kind: string; streamId: string; payload: string },
) {
	// Post-N+1: stream responses ride the durable_work spool. A chunk/end is a
	// durable row targeted at the requester (local-spoke), keyed by stream_id.
	db.prepare(
		`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, claim_state, attempt_count, created_at, source_site)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
	).run(
		opts.id,
		"local-spoke",
		opts.kind,
		null,
		`stream:${opts.streamId}:${opts.kind}:${opts.id}`,
		opts.streamId,
		opts.payload,
		new Date(Date.now() + 300_000).toISOString(),
		new Date().toISOString(),
		new Date().toISOString(),
		opts.sourceSiteId,
	);
}

const eligibleHost = (siteId: string, hostName: string): EligibleHost => ({
	site_id: siteId,
	host_name: hostName,
	sync_url: null,
	online_at: new Date().toISOString(),
	modified_at: new Date().toISOString(),
});

// Post-N+1 routeRelayRequest requires the target host to advertise
// work_spool_capable (no legacy fallback). Seed the relay target as capable.
function seedCapableHost(db: Database, siteId: string, hostName: string) {
	const now = new Date().toISOString();
	db.prepare(
		"INSERT OR IGNORE INTO hosts (site_id, host_name, online_at, modified_at, deleted, work_spool_capable) VALUES (?, ?, ?, ?, 0, 1)",
	).run(siteId, hostName, now, now);
}

describe("createRelayBackend", () => {
	let db: Database;
	let tmpDir: string;

	afterEach(async () => {
		await cleanup(db, tmpDir);
	});

	it("AC1.1/AC1.2: chat() issues one relay inference carrying the logical model alias and yields its chunks in order", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const remoteSite = "remote-spoke";
		seedCapableHost(db, remoteSite, "remote-spoke.local");
		seedCapableHost(db, remoteSite, "remote-spoke.local");

		const backend = createRelayBackend(
			{ db, eventBus, siteId: "local-spoke", logger: mockLogger },
			[eligibleHost(remoteSite, "remote-spoke.local")],
			"opus",
			5000,
		);

		const collected: StreamChunk[] = [];
		const consume = (async () => {
			for await (const chunk of backend.chat({
				threadId: "thread-123",
				system: "Summarize the thread.",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 256,
			})) {
				collected.push(chunk);
			}
		})();

		// Responder: wait for the inference request to land in the outbox, lift its
		// stream_id, then seed the inbox response and wake the stream.
		const appeared = await waitFor(() => getInferenceOutboxRow(db) !== null);
		expect(appeared).toBe(true);

		const row = getInferenceOutboxRow(db);
		if (!row) throw new Error("no inference outbox row");

		// AC1.2: the payload carries the logical alias, not a provider-specific id.
		const payload = JSON.parse(row.payload) as {
			threadId: string;
			model: string;
			timeout_ms: number;
			segments: Array<{ kind: string; message?: unknown }>;
			nowMs: number;
		};
		expect(payload.threadId).toBe("thread-123");
		expect(payload.model).toBe("opus");
		expect(payload.timeout_ms).toBe(5000);
		// The relay backend now emits inline segments + a send-instant nowMs
		// instead of a raw `messages` array.
		expect(payload.segments).toEqual([
			{ kind: "inline", message: { role: "user", content: "hello" } },
		]);
		expect(typeof payload.nowMs).toBe("number");

		insertRelayInboxEntry(db, {
			id: "chunk-0",
			sourceSiteId: remoteSite,
			kind: "stream_chunk",
			streamId: row.stream_id,
			payload: JSON.stringify({ seq: 0, chunks: [{ type: "text", content: "Hello " }] }),
		});
		insertRelayInboxEntry(db, {
			id: "chunk-1",
			sourceSiteId: remoteSite,
			kind: "stream_chunk",
			streamId: row.stream_id,
			payload: JSON.stringify({ seq: 1, chunks: [{ type: "text", content: "world" }] }),
		});
		insertRelayInboxEntry(db, {
			id: "stream-end",
			sourceSiteId: remoteSite,
			kind: "stream_end",
			streamId: row.stream_id,
			payload: JSON.stringify({ seq: 1, chunks: [] }),
		});
		eventBus.emit("relay:inbox", { stream_id: row.stream_id, kind: "stream_chunk" as const });

		await consume;

		const texts = collected
			.filter((c): c is { type: "text"; content: string } => c.type === "text")
			.map((c) => c.content);
		expect(texts).toEqual(["Hello ", "world"]);
	});

	it("AC1.3: capabilities() returns a permissive stub", async () => {
		({ db, tmpDir } = createTestDb());
		const eventBus = new TypedEventEmitter();
		const backend = createRelayBackend(
			{ db, eventBus, siteId: "local-spoke", logger: mockLogger },
			[eligibleHost("remote-spoke", "remote-spoke.local")],
			"opus",
			5000,
		);

		const caps = backend.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(false);
		expect(caps.max_context).toBe(0);
	});
});
