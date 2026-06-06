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
			"SELECT stream_id, payload FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { stream_id: string; payload: string } | null;
}

function insertRelayInboxEntry(
	db: Database,
	opts: { id: string; sourceSiteId: string; kind: string; streamId: string; payload: string },
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

const eligibleHost = (siteId: string, hostName: string): EligibleHost => ({
	site_id: siteId,
	host_name: hostName,
	sync_url: null,
	online_at: new Date().toISOString(),
	modified_at: new Date().toISOString(),
});

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

		const backend = createRelayBackend(
			{ db, eventBus, siteId: "local-spoke", logger: mockLogger },
			[eligibleHost(remoteSite, "remote-spoke.local")],
			"opus",
			5000,
		);

		const collected: StreamChunk[] = [];
		const consume = (async () => {
			for await (const chunk of backend.chat({
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
		const payload = JSON.parse(row.payload) as { model: string; timeout_ms: number };
		expect(payload.model).toBe("opus");
		expect(payload.timeout_ms).toBe(5000);

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
