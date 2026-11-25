import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TypedEventEmitter } from "@bound/shared";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";
import { createSyncTestSchema } from "./test-harness.js";

/**
 * #306: a consistency request in flight when its connection drops must settle
 * promptly (timer cleared, partial progress kept as resume state) so the
 * reconnect backfill can run on the healthy replacement instead of waiting for
 * the five-minute deadline. The deadline still bounds a live, silent hub.
 */
describe("consistency requests across disconnect (#306)", () => {
	let db: Database;
	let transport: WsTransport;
	const key = new Uint8Array(32).fill(3);

	/** Payloads of every CONSISTENCY_REQUEST, in send order, tagged by connection. */
	let requests: Array<{ conn: string; payload: Record<string, unknown> }>;

	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	/** Captured 300s consistency deadlines, keyed by fake timer handle. */
	let deadlines: Map<number, () => void>;
	let cleared: Set<number>;
	let nextHandle: number;

	function connect(conn: string, siteId = "hub"): void {
		transport.addPeer(
			siteId,
			(frame) => {
				const decoded = decodeFrame(frame, key);
				if (decoded.ok && decoded.value.type === WsMessageType.CONSISTENCY_REQUEST) {
					requests.push({ conn, payload: decoded.value.payload as Record<string, unknown> });
				}
				return true;
			},
			key,
		);
	}

	/** Fail fast (instead of hanging) if a promise does not settle promptly. */
	function prompt<T>(p: Promise<T>): Promise<T> {
		return Promise.race([
			p,
			new Promise<T>((_, reject) => {
				originalSetTimeout(() => reject(new Error("did not settle promptly")), 500);
			}),
		]);
	}

	function lastRequestId(): string {
		return requests[requests.length - 1].payload.request_id as string;
	}

	function partialPage(requestId: string): void {
		transport.handleConsistencyResponse({
			table: "semantic_memory",
			pks: ["u-1", "u-2"],
			count: 10,
			has_more: true,
			table_index: 0,
			table_count: 12,
			request_id: requestId,
			next_table_index: 0,
			next_offset: 2,
		});
	}

	function finalPage(requestId: string, pk: string | null = "m-1"): void {
		transport.handleConsistencyResponse({
			table: "tasks",
			pks: pk === null ? [] : [pk],
			count: pk === null ? 0 : 1,
			has_more: false,
			table_index: 11,
			table_count: 12,
			all_done: true,
			request_id: requestId,
		});
	}

	beforeEach(() => {
		db = new Database(":memory:");
		createSyncTestSchema(db);
		transport = new WsTransport({
			db,
			siteId: "spoke",
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
		requests = [];
		deadlines = new Map();
		cleared = new Set();
		nextHandle = 1_000_000;
		globalThis.setTimeout = ((callback, delay, ...args) => {
			if (delay === 300_000) {
				const handle = nextHandle++;
				deadlines.set(handle, () => {
					if (typeof callback === "function") callback(...args);
				});
				return handle as unknown as Timer;
			}
			return originalSetTimeout(callback, delay, ...args);
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle?: Timer | number) => {
			if (typeof handle === "number" && deadlines.has(handle)) {
				cleared.add(handle);
				deadlines.delete(handle);
				return;
			}
			originalClearTimeout(handle as Timer);
		}) as typeof clearTimeout;
	});

	afterEach(() => {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		transport.stop();
		db.close();
	});

	it("disconnect settles the in-flight backfill promptly so reconnect backfill resumes the partial page", async () => {
		const now = new Date().toISOString();
		for (const id of ["u-1", "u-2"]) {
			db.run(
				`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at)
				 VALUES (?, ?, 'v', 'test', ?, ?)`,
				[id, id, now, now],
			);
		}
		connect("old");
		const first = transport.runBackfill({ trigger: "initial" });
		expect(requests).toHaveLength(1);
		partialPage(lastRequestId());

		transport.removePeer("hub");
		await expect(prompt(first)).rejects.toThrow("connection closed");
		// The five-minute deadline is cleared, not left to fire later.
		expect(cleared.size).toBe(1);
		expect(deadlines.size).toBe(0);

		// Healthy replacement: reconnect backfill sends a new request at once,
		// resuming from the partial page instead of being skipped as "running".
		connect("new");
		const second = transport.runBackfill({ trigger: "reconnect" });
		expect(requests).toHaveLength(2);
		expect(requests[1].conn).toBe("new");
		expect(requests[1].payload.resume_table_index).toBe(0);
		expect(requests[1].payload.resume_offset).toBe(2);

		// Empty final page and locally present partial rows: no row pull needed.
		finalPage(lastRequestId(), null);
		await expect(prompt(second)).resolves.toMatchObject({ pulled: 0 });
	});

	it("keeps partial data from the dropped request in the resumed result", async () => {
		connect("old");
		const first = transport.requestConsistency([]);
		partialPage(lastRequestId());
		transport.removePeer("hub");
		await expect(prompt(first)).rejects.toThrow("connection closed");

		connect("new");
		const second = transport.requestConsistency([]);
		finalPage(lastRequestId());
		const tables = await prompt(second);
		expect(tables.get("semantic_memory")?.pks).toEqual(["u-1", "u-2"]);
		expect(tables.get("tasks")?.pks).toEqual(["m-1"]);
	});

	it("ignores late responses from the old generation", async () => {
		connect("old");
		const first = transport.requestConsistency([]);
		const oldId = lastRequestId();
		transport.removePeer("hub");
		await expect(prompt(first)).rejects.toThrow("connection closed");

		connect("new");
		let settled = false;
		const second = transport.requestConsistency([]).finally(() => {
			settled = true;
		});
		const newId = lastRequestId();
		expect(newId).not.toBe(oldId);

		// A frame for the abandoned request arrives after the reconnect.
		finalPage(oldId, "stale");
		await Promise.resolve();
		expect(settled).toBe(false);

		finalPage(newId, "fresh");
		const tables = await prompt(second);
		expect(tables.get("tasks")?.pks).toEqual(["fresh"]);
	});

	it("a replacement connection settles only the replaced connection's requests", async () => {
		connect("old");
		const first = transport.requestConsistency([]);
		// Replacement registered before the old socket's close is observed.
		connect("new");
		await expect(prompt(first)).rejects.toThrow("connection closed");

		const second = transport.requestConsistency([]);
		expect(requests[1].conn).toBe("new");
		finalPage(lastRequestId());
		await expect(prompt(second)).resolves.toBeDefined();
	});

	it("removing an unrelated peer leaves the hub request pending", async () => {
		connect("hub-conn");
		connect("other-conn", "other-peer");
		let settled = false;
		const pending = transport.requestConsistency([]).finally(() => {
			settled = true;
		});
		expect(requests[0].conn).toBe("hub-conn");

		transport.removePeer("other-peer");
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(deadlines.size).toBe(1);

		finalPage(lastRequestId());
		await expect(prompt(pending)).resolves.toBeDefined();
	});

	it("keeps the five-minute deadline for a live but silent connection", async () => {
		connect("live");
		const pending = transport.requestConsistency([]);
		partialPage(lastRequestId());
		expect(deadlines.size).toBe(1);
		const [fire] = [...deadlines.values()];
		fire();
		await expect(prompt(pending)).rejects.toThrow("timed out");

		// Timeout still preserves resume state for the next attempt.
		transport.requestConsistency([]).catch(() => {});
		expect(requests[1].payload.resume_offset).toBe(2);
	});
});
