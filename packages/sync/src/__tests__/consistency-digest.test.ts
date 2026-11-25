import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { computeTableStateDigest } from "@bound/core";
import type { ConsistencyResponsePayload } from "../ws-frames.js";
import type { WsTransport } from "../ws-transport.js";
import { type WsTestCluster, createWsTestCluster } from "./test-harness.js";
import { waitFor } from "./wait-helpers.js";

function until(description: string, isReady: () => boolean): Promise<boolean> {
	return waitFor({ description, observe: isReady, isReady: (ready) => ready, timeoutMs: 5_000 });
}

/**
 * #248: per-table state digests short-circuit unchanged tables in the
 * consistency exchange. Converged tables answer with one row-free frame;
 * changed tables, older peers, and unverifiable digests keep the row path.
 */

type TransportInternals = {
	backfillRunning: boolean;
	lastBackfillAt: number;
	computeLocalTableDigests: (tables: readonly string[]) => Map<string, string>;
	handleConsistencyRequest: (peerSiteId: string, payload: Record<string, unknown>) => void;
	handleConsistencyResponse: (payload: ConsistencyResponsePayload) => void;
};

function internals(transport: WsTransport): TransportInternals {
	return transport as unknown as TransportInternals;
}

function insertMemory(
	db: WsTestCluster["hub"]["db"],
	id: string,
	value: string,
	modifiedAt = "2026-01-01T00:00:00.000Z",
): void {
	db.run(
		"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, 'test', '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z', 0)",
		[id, `key-${id}`, value, modifiedAt],
	);
}

function insertMessage(db: WsTestCluster["hub"]["db"], id: string, role: string): void {
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, 'thread-1', ?, 'content', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'hub', 0)",
		[id, role],
	);
}

describe("consistency table digest short-circuit (#248)", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({
			spokeCount: 1,
			basePort: 0,
			testRunId: `digest-${randomBytes(4).toString("hex")}`,
		});
		const spoke = internals(cluster.spokes[0].wsTransport);
		// The connect-time backfill races the fixture rows; let it settle first.
		await until("backfill idle", () => !spoke.backfillRunning);
		for (const db of [cluster.hub.db, cluster.spokes[0].db]) {
			for (let i = 0; i < 20; i++) insertMemory(db, `mem-${i}`, `value-${i}`);
			insertMessage(db, "msg-1", "user");
		}
		// Unsyncable rows must not break digest equality (invariant #19).
		insertMessage(cluster.hub.db, "sys-hub", "system");
	});

	afterEach(async () => {
		await cluster.cleanup();
	});

	async function runBackfill(): Promise<{
		result: { backfilled: number; requested: number; pulled: number };
		frames: ConsistencyResponsePayload[];
	}> {
		const transport = cluster.spokes[0].wsTransport;
		const spoke = internals(transport);
		const frames: ConsistencyResponsePayload[] = [];
		const original = spoke.handleConsistencyResponse.bind(transport);
		spoke.handleConsistencyResponse = (payload) => {
			frames.push(structuredClone(payload));
			original(payload);
		};
		await until("backfill idle", () => !spoke.backfillRunning);
		spoke.lastBackfillAt = 0;
		try {
			const result = await transport.runBackfill({ trigger: "periodic" });
			return { result, frames };
		} finally {
			spoke.handleConsistencyResponse = original;
		}
	}

	it("a converged cluster exchanges only digest frames and no per-row advertisement", async () => {
		const { result, frames } = await runBackfill();
		expect(frames.length).toBe(12);
		expect(frames.every((frame) => frame.digest_match === true)).toBe(true);
		expect(frames.every((frame) => frame.pks.length === 0)).toBe(true);
		expect(frames.reduce((sum, frame) => sum + (frame.entries?.length ?? 0), 0)).toBe(0);
		expect(result).toMatchObject({ backfilled: 0, requested: 0, pulled: 0 });
	});

	it("a changed row sends only its table through the row-level path", async () => {
		cluster.hub.db.run(
			"UPDATE semantic_memory SET value = 'hub-newer', modified_at = '2026-02-01T00:00:00.000Z' WHERE id = 'mem-3'",
		);
		const { result, frames } = await runBackfill();
		const rowFrames = frames.filter((frame) => frame.digest_match !== true);
		expect(rowFrames.map((frame) => frame.table)).toEqual(["semantic_memory"]);
		expect(rowFrames[0].pks.length).toBe(20);
		expect(frames.filter((frame) => frame.digest_match === true).length).toBe(11);
		expect(result).toMatchObject({ backfilled: 0, requested: 1 });
		await until("hub-newer row applied", () => {
			const row = cluster.spokes[0].db
				.query("SELECT value FROM semantic_memory WHERE id = 'mem-3'")
				.get() as { value: string } | null;
			return row?.value === "hub-newer";
		});
	});

	it("a spoke-only row pushes just that row, not the whole table", async () => {
		insertMemory(cluster.spokes[0].db, "spoke-only", "local");
		const { result, frames } = await runBackfill();
		expect(frames.filter((frame) => frame.digest_match !== true).map((f) => f.table)).toEqual([
			"semantic_memory",
		]);
		expect(result).toMatchObject({ backfilled: 1, requested: 0 });
	});

	it("an old spoke without digests gets the full row stream and converges", async () => {
		const transport = cluster.spokes[0].wsTransport;
		const spoke = internals(transport);
		spoke.computeLocalTableDigests = () => new Map();
		const { result, frames } = await runBackfill();
		expect(frames.some((frame) => frame.digest_match === true)).toBe(false);
		const memory = frames.find((frame) => frame.table === "semantic_memory");
		expect(memory?.pks.length).toBe(20);
		expect(result).toMatchObject({ backfilled: 0, requested: 0, pulled: 0 });
	});

	it("an old hub that ignores digests keeps the row stream and converges", async () => {
		const hubTransport = cluster.hub.wsTransport;
		const hub = internals(hubTransport);
		const original = hub.handleConsistencyRequest.bind(hubTransport);
		hub.handleConsistencyRequest = (peerSiteId, payload) => {
			const { table_digests: _ignored, ...legacy } = payload;
			original(peerSiteId, legacy);
		};
		insertMemory(cluster.spokes[0].db, "spoke-only", "local");
		const { result, frames } = await runBackfill();
		expect(frames.some((frame) => frame.digest_match === true)).toBe(false);
		expect(result).toMatchObject({ backfilled: 1, requested: 0 });
	});

	it("malformed or mismatched digests from the spoke fall back to the row stream", async () => {
		const transport = cluster.spokes[0].wsTransport;
		const spoke = internals(transport);
		const real = spoke.computeLocalTableDigests.bind(transport);
		spoke.computeLocalTableDigests = (tables) => {
			const digests = real(tables);
			digests.set("semantic_memory", "not-a-digest");
			digests.set("messages", `v1:${"0".repeat(64)}`);
			return digests;
		};
		const { result, frames } = await runBackfill();
		const rowTables = frames.filter((frame) => frame.digest_match !== true).map((f) => f.table);
		expect(rowTables.sort()).toEqual(["messages", "semantic_memory"]);
		expect(result).toMatchObject({ backfilled: 0, requested: 0, pulled: 0 });
	});

	it("an unverifiable digest_match is skipped, never diffed as an empty advertisement", async () => {
		insertMemory(cluster.spokes[0].db, "spoke-only", "local");
		const transport = cluster.spokes[0].wsTransport;
		const spoke = internals(transport);
		const original = spoke.handleConsistencyResponse.bind(transport);
		spoke.handleConsistencyResponse = (payload) => {
			original(
				payload.table === "users"
					? { ...payload, pks: [], entries: [], digest_match: true, digest: `v1:${"f".repeat(64)}` }
					: payload,
			);
		};
		cluster.spokes[0].db.run(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES ('u-local', 'Local', 'now', 'now', 0)",
		);
		const { result } = await runBackfill();
		// semantic_memory pushes its one local-only row; users is skipped outright.
		expect(result.backfilled).toBe(1);
	});

	it("hub and spoke digests agree for every converged table", () => {
		for (const table of ["semantic_memory", "messages", "hosts", "cluster_config"] as const) {
			expect(computeTableStateDigest(cluster.hub.db, table).digest).toBe(
				computeTableStateDigest(cluster.spokes[0].db, table).digest,
			);
		}
	});
});
