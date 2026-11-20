import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { StreamChunk } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Subject, lastValueFrom, tap } from "rxjs";
import type { EligibleHost } from "../relay-router";
import { createRelayStream$ } from "../relay-stream$";

// These two cases guard the consumer-side seq-gap branch in relay-stream$.ts
// (the MAX_GAP_CYCLES / gapCyclesWaited logic). They are the only guards for:
//   1. forward-gap skip — a permanently-lost seq is skipped after the gap window
//      so the stream advances past it and still completes;
//   2. backward-seq discard — a stale retransmitted seq < nextExpectedSeq is
//      discarded by the consumer guard, not re-emitted.
// The sibling relay-stream$.test.ts covers contiguous delivery, same-seq
// redelivery (the write-side INSERT OR IGNORE fence), and crash-replay dedup,
// none of which exercise a permanently-missing or stale-behind seq.

describe("createRelayStream$() seq-gap handling", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "relay-stream-test-"));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
		eventBus = new TypedEventEmitter();
	});

	afterEach(async () => {
		// The relay-stream$ observable polls readDurableResponsesByStreamId on deps.db
		// each tick; a poll can still be in flight when a test's `await streamPromise`
		// resolves (gap-detection tests leave the stream open past the assertion).
		// Let pending microtasks/timers drain before closing so an in-flight poll does
		// not hit a closed database and surface as the NEXT test's failure.
		await new Promise((r) => setTimeout(r, 50));
		try {
			db.close();
		} catch {
			// Already closed
		}
		try {
			await cleanupTmpDir(tmpDir);
		} catch {
			// Already deleted
		}
	});

	function makeMockHost(hostName: string): EligibleHost {
		const siteId = `site-${hostName}`;
		const nowIso = new Date().toISOString();
		// Post-N+1 routeRelayRequest routes durable only when the target advertises
		// work_spool_capable (no legacy fallback). Seed the target host as capable.
		db.prepare(
			"INSERT OR IGNORE INTO hosts (site_id, host_name, online_at, modified_at, deleted, work_spool_capable) VALUES (?, ?, ?, ?, 0, 1)",
		).run(siteId, hostName, nowIso, nowIso);
		return {
			site_id: siteId,
			host_name: hostName,
			sync_url: null,
			online_at: nowIso,
		};
	}

	function createDeps() {
		return {
			db,
			eventBus,
			siteId: "test-site-id",
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
		};
	}

	function insertDurableRow(
		host: EligibleHost,
		streamId: string,
		kind: "stream_chunk" | "stream_end",
		seq: number,
		chunks: unknown[],
	) {
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO durable_work (id, source_site, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, target_site_id, claim_state, attempt_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'test-site-id', 'pending', 0, datetime('now'))`,
			[
				randomUUID(),
				host.site_id,
				kind,
				null,
				randomUUID(),
				streamId,
				JSON.stringify({ seq, chunks }),
				new Date(Date.now() + 60_000).toISOString(),
				now,
			],
		);
	}

	function getStreamId(): string | null {
		const row = db
			.query(
				"SELECT stream_id FROM durable_work WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { stream_id: string } | null;
		return row?.stream_id ?? null;
	}

	it("skips a permanently-lost seq after the gap window and still completes (AC1.8)", async () => {
		const host = makeMockHost("relay-host-gap");
		const payload = { model: "test-model", segments: [], nowMs: 0, tools: [] };
		const chunks: StreamChunk[] = [];
		const aborted$ = new Subject<void>();

		const streamPromise = lastValueFrom(
			createRelayStream$(
				createDeps(),
				payload,
				[host],
				aborted$,
				{},
				{
					pollIntervalMs: 5,
					perHostTimeoutMs: 500,
				},
			).pipe(tap((chunk) => chunks.push(chunk))),
			{ defaultValue: undefined },
		);

		await new Promise((r) => setTimeout(r, 10));
		const streamId = getStreamId();
		expect(streamId).not.toBeNull();
		if (streamId) {
			// seq 0 and seq 2 arrive; seq 1 is permanently lost. The consumer must
			// wait MAX_GAP_CYCLES, skip the missing seq 1, emit seq 0 + seq 2, and
			// complete on the stream_end. A regression that never advances past the
			// lost seq would hang here (perHostTimeoutMs fails the stream instead).
			insertDurableRow(host, streamId, "stream_chunk", 0, [{ type: "text", content: "first" }]);
			await new Promise((r) => setTimeout(r, 10));
			insertDurableRow(host, streamId, "stream_chunk", 2, [{ type: "text", content: "third" }]);
			insertDurableRow(host, streamId, "stream_end", 3, [
				{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } },
			]);
		}

		await streamPromise;

		const text = chunks.filter((c) => c.type === "text").map((c) => c.content);
		expect(text).toEqual(["first", "third"]);
		expect(chunks.some((c) => c.type === "done")).toBe(true);
	});

	it("discards a stale retransmitted seq behind nextExpectedSeq, not re-emitting it", async () => {
		const host = makeMockHost("relay-host-backwards");
		const payload = { model: "test-model", segments: [], nowMs: 0, tools: [] };
		const chunks: StreamChunk[] = [];
		const aborted$ = new Subject<void>();

		const streamPromise = lastValueFrom(
			createRelayStream$(
				createDeps(),
				payload,
				[host],
				aborted$,
				{},
				{
					pollIntervalMs: 5,
					perHostTimeoutMs: 2000,
				},
			).pipe(tap((chunk) => chunks.push(chunk))),
			{ defaultValue: undefined },
		);

		await new Promise((r) => setTimeout(r, 10));
		const streamId = getStreamId();
		expect(streamId).not.toBeNull();
		if (streamId) {
			// seq 0,1,2 fold in order; nextExpectedSeq advances to 3.
			for (let seq = 0; seq < 3; seq++) {
				insertDurableRow(host, streamId, "stream_chunk", seq, [
					{ type: "text", content: `chunk-${seq}` },
				]);
			}
			await new Promise((r) => setTimeout(r, 20));

			// Stale retransmits of seq 0,1 with DISTINCT content. These are not deduped
			// by the write-side INSERT OR IGNORE fence (fresh idempotency_key); the
			// consumer's nextExpectedSeq guard must discard them instead of re-emitting
			// "stale-*". A regression reprocessing seq < nextExpectedSeq would surface
			// the stale content in output.
			for (let seq = 0; seq < 2; seq++) {
				insertDurableRow(host, streamId, "stream_chunk", seq, [
					{ type: "text", content: `stale-${seq}` },
				]);
			}
			await new Promise((r) => setTimeout(r, 30));

			insertDurableRow(host, streamId, "stream_end", 3, [
				{ type: "done", usage: { input_tokens: 10, output_tokens: 5 } },
			]);
		}

		await streamPromise;

		const text = chunks.filter((c) => c.type === "text").map((c) => c.content ?? "");
		expect(text.filter((c) => c.startsWith("stale-"))).toEqual([]);
		expect(text.filter((c) => c.startsWith("chunk-"))).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
	});
});
