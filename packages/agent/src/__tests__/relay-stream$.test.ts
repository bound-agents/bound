import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Subject } from "rxjs";
import { lastValueFrom } from "rxjs";
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

function createTestDb(): { db: Database.Database; tmpDir: string } {
	const tmpDir = mkdtempSync(join("/tmp", "bound-test-"));
	const dbPath = join(tmpDir, "test.db");
	const db = new Database(dbPath);
	applySchema(db);
	return { db, tmpDir };
}

function cleanup(db: Database.Database, tmpDir: string) {
	try {
		db.close();
	} catch (_e) {
		// already closed
	}
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch (_e) {
		// already removed
	}
}

describe("createRelayStream$", () => {
	it("AC1.1: Sequential chunks emitted immediately", async () => {
		const { db, tmpDir } = createTestDb();
		try {
			const eventBus = new TypedEventEmitter();
			const siteId = "hub";
			const remoteHost = "spoke-1";
			const streamId = randomBytes(4).toString("hex");
			const aborted$ = new Subject<void>();
			const chunks: StreamChunk[] = [];

			const eligibleHosts = [
				{
					site_id: remoteHost,
					host_name: "spoke-1.local",
					sync_url: null,
					online_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
				},
			];

			const payload = {
				model: "test-model",
				messages: [{ role: "user" as const, content: "hello" }],
			};

			const streamChunks: StreamChunk[] = [
				{ type: "text_delta", text: "a" },
				{ type: "text_delta", text: "b" },
				{ type: "text_delta", text: "c" },
			];

			// Simulate relay processor writing chunks
			setTimeout(() => {
				for (let seq = 0; seq < 3; seq++) {
					db.prepare(
						`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						`entry-${seq}`,
						remoteHost,
						"stream_chunk",
						null,
						null,
						streamId,
						JSON.stringify({
							seq,
							chunks: [streamChunks[seq]],
						}),
						new Date(Date.now() + 300_000).toISOString(),
						new Date().toISOString(),
						0,
					);
				}

				// Emit stream_end
				db.prepare(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"stream_end",
					remoteHost,
					"stream_end",
					null,
					null,
					streamId,
					JSON.stringify({ seq: 2, chunks: [] }),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
					0,
				);

				eventBus.emit("relay:inbox", {
					stream_id: streamId,
					kind: "stream_chunk" as const,
				});
			}, 100);

			await lastValueFrom(
				createRelayStream$(
					{ db, eventBus, siteId, logger: mockLogger },
					payload as any,
					eligibleHosts as any,
					aborted$,
					undefined,
					{ perHostTimeoutMs: 5000 },
				).pipe(
					tap((chunk) => {
						chunks.push(chunk);
					}),
				),
				{ defaultValue: undefined },
			);

			expect(chunks.length).toBe(3);
			expect(chunks[0]).toEqual({ type: "text_delta", text: "a" });
			expect(chunks[1]).toEqual({ type: "text_delta", text: "b" });
			expect(chunks[2]).toEqual({ type: "text_delta", text: "c" });
		} finally {
			cleanup(db, tmpDir);
		}
	});

	it("AC1.2: Out-of-order chunks reordered correctly", async () => {
		const { db, tmpDir } = createTestDb();
		try {
			const eventBus = new TypedEventEmitter();
			const siteId = "hub";
			const remoteHost = "spoke-1";
			const streamId = randomBytes(4).toString("hex");
			const aborted$ = new Subject<void>();
			const chunks: StreamChunk[] = [];

			const eligibleHosts = [
				{
					site_id: remoteHost,
					host_name: "spoke-1.local",
					sync_url: null,
					online_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
				},
			];

			const payload = {
				model: "test-model",
				messages: [{ role: "user" as const, content: "hello" }],
			};

			const streamChunks: StreamChunk[] = [
				{ type: "text_delta", text: "a" },
				{ type: "text_delta", text: "b" },
				{ type: "text_delta", text: "c" },
			];

			// Insert chunks out of order: 0, 2, 1
			setTimeout(() => {
				const sequences = [0, 2, 1];
				for (const seq of sequences) {
					db.prepare(
						`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						`entry-${seq}`,
						remoteHost,
						"stream_chunk",
						null,
						null,
						streamId,
						JSON.stringify({
							seq,
							chunks: [streamChunks[seq]],
						}),
						new Date(Date.now() + 300_000).toISOString(),
						new Date().toISOString(),
						0,
					);
				}

				// Emit stream_end
				db.prepare(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"stream_end",
					remoteHost,
					"stream_end",
					null,
					null,
					streamId,
					JSON.stringify({ seq: 2, chunks: [] }),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
					0,
				);

				eventBus.emit("relay:inbox", {
					stream_id: streamId,
					kind: "stream_chunk" as const,
				});
			}, 100);

			await lastValueFrom(
				createRelayStream$(
					{ db, eventBus, siteId, logger: mockLogger },
					payload as any,
					eligibleHosts as any,
					aborted$,
					undefined,
					{ perHostTimeoutMs: 5000 },
				).pipe(
					tap((chunk) => {
						chunks.push(chunk);
					}),
				),
				{ defaultValue: undefined },
			);

			// Should be emitted in order 0, 1, 2 despite arriving as 0, 2, 1
			expect(chunks.length).toBe(3);
			expect(chunks[0]).toEqual({ type: "text_delta", text: "a" });
			expect(chunks[1]).toEqual({ type: "text_delta", text: "b" });
			expect(chunks[2]).toEqual({ type: "text_delta", text: "c" });
		} finally {
			cleanup(db, tmpDir);
		}
	});

	it("AC1.3: Normal completion on stream_end", async () => {
		const { db, tmpDir } = createTestDb();
		try {
			const eventBus = new TypedEventEmitter();
			const siteId = "hub";
			const remoteHost = "spoke-1";
			const streamId = randomBytes(4).toString("hex");
			const aborted$ = new Subject<void>();
			let completed = false;

			const eligibleHosts = [
				{
					site_id: remoteHost,
					host_name: "spoke-1.local",
					sync_url: null,
					online_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
				},
			];

			const payload = {
				model: "test-model",
				messages: [{ role: "user" as const, content: "hello" }],
			};

			setTimeout(() => {
				// Insert single chunk
				db.prepare(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"entry-0",
					remoteHost,
					"stream_chunk",
					null,
					null,
					streamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text_delta", text: "a" }],
					}),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
					0,
				);

				// Emit stream_end with same seq
				db.prepare(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"stream_end",
					remoteHost,
					"stream_end",
					null,
					null,
					streamId,
					JSON.stringify({ seq: 0, chunks: [] }),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
					0,
				);

				eventBus.emit("relay:inbox", {
					stream_id: streamId,
					kind: "stream_chunk" as const,
				});
			}, 100);

			try {
				await lastValueFrom(
					createRelayStream$(
						{ db, eventBus, siteId, logger: mockLogger },
						payload as any,
						eligibleHosts as any,
						aborted$,
						undefined,
						{ perHostTimeoutMs: 5000 },
					),
					{ defaultValue: undefined },
				);
				completed = true;
			} catch (_e) {
				// Ignore errors for this test
			}

			expect(completed).toBe(true);
		} finally {
			cleanup(db, tmpDir);
		}
	});

	it("AC1.9: Metadata capture on first chunk", async () => {
		const { db, tmpDir } = createTestDb();
		try {
			const eventBus = new TypedEventEmitter();
			const siteId = "hub";
			const remoteHost = "spoke-1";
			const streamId = randomBytes(4).toString("hex");
			const aborted$ = new Subject<void>();
			const metadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};

			const eligibleHosts = [
				{
					site_id: remoteHost,
					host_name: "spoke-1.local",
					sync_url: null,
					online_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
				},
			];

			const payload = {
				model: "test-model",
				messages: [{ role: "user" as const, content: "hello" }],
			};

			setTimeout(() => {
				db.prepare(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"entry-0",
					remoteHost,
					"stream_chunk",
					null,
					null,
					streamId,
					JSON.stringify({
						seq: 0,
						chunks: [{ type: "text_delta", text: "a" }],
					}),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
					0,
				);

				db.prepare(
					`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"stream_end",
					remoteHost,
					"stream_end",
					null,
					null,
					streamId,
					JSON.stringify({ seq: 0, chunks: [] }),
					new Date(Date.now() + 300_000).toISOString(),
					new Date().toISOString(),
					0,
				);

				eventBus.emit("relay:inbox", {
					stream_id: streamId,
					kind: "stream_chunk" as const,
				});
			}, 100);

			await lastValueFrom(
				createRelayStream$(
					{ db, eventBus, siteId, logger: mockLogger },
					payload as any,
					eligibleHosts as any,
					aborted$,
					metadataRef,
					{ perHostTimeoutMs: 5000 },
				),
				{ defaultValue: undefined },
			);

			expect(metadataRef.hostName).toBe("spoke-1.local");
			expect(typeof metadataRef.firstChunkLatencyMs).toBe("number");
			if (metadataRef.firstChunkLatencyMs !== undefined) {
				expect(metadataRef.firstChunkLatencyMs >= 0).toBe(true);
			}
		} finally {
			cleanup(db, tmpDir);
		}
	});
});
