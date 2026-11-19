// Spoke-side snapshot seeding tests: drive the SNAPSHOT_BEGIN/CHUNK/END handlers
// that apply an incoming full-DB snapshot and send the final SNAPSHOT_ACK. The
// handlers are private; they are driven through a typed cast with a stubbed
// wsTransport (the DB-apply boundary) and a captured socket send, so the chunk
// bookkeeping and ack emission are exercised without a live WebSocket.

import { afterEach, describe, expect, it } from "bun:test";

import type { KeyManager } from "../key-manager.js";
import { WsSyncClient } from "../ws-client.js";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import type {
	SnapshotBeginPayload,
	SnapshotChunkPayload,
	SnapshotEndPayload,
} from "../ws-frames.js";

// Records every call the spoke handlers make across the DB-apply boundary.
interface TransportCalls {
	snapshotChunks: Array<{ table: string; rows: Array<Record<string, unknown>> }>;
	columnChunks: Array<{
		table: string;
		pk: string;
		column: string;
		index: number;
		data: string;
	}>;
}

function makeStubTransport(appliedPerChunk = 1): {
	transport: NonNullable<ConstructorParameters<typeof WsSyncClient>[0]["wsTransport"]>;
	calls: TransportCalls;
} {
	const calls: TransportCalls = { snapshotChunks: [], columnChunks: [] };
	const noop = () => {};
	const transport = {
		addPeer: noop,
		removePeer: noop,
		handleChangelogPush: noop,
		handleChangelogAck: noop,
		drainChangelog: noop,
		handleRelayDeliver: noop,
		handleRelayAck: noop,
		handleSpoolTransfer: noop,
		handleSpoolTransferAck: noop,
		drainDurableWorkSpool: noop,
		applySnapshotChunk: (table: string, rows: Array<Record<string, unknown>>) => {
			calls.snapshotChunks.push({ table, rows });
			return appliedPerChunk * rows.length;
		},
		applyColumnChunk: (table: string, pk: string, column: string, index: number, data: string) => {
			calls.columnChunks.push({ table, pk, column, index, data });
		},
	};
	return { transport, calls };
}

// Minimal KeyManager stub — snapshot handlers only need a symmetric key present.
const symKey = new Uint8Array(32).fill(5);
function makeKeyManagerStub(): KeyManager {
	return {
		getSymmetricKey: () => symKey,
	} as unknown as KeyManager;
}

function makeClient(
	transport: ConstructorParameters<typeof WsSyncClient>[0]["wsTransport"],
): WsSyncClient {
	return new WsSyncClient({
		hubUrl: "http://localhost:3000",
		privateKey: {} as CryptoKey,
		siteId: "spoke-site",
		keyManager: makeKeyManagerStub(),
		hubSiteId: "hub-site",
		wsTransport: transport,
	});
}

// Access shape for the private fields/handlers the tests drive.
interface SpokeInjector {
	symmetricKey: Uint8Array | null;
	snapshotRowCount: number;
	snapshotHlc: string | null;
	ws: { readyState: number; send: (data: unknown) => void } | null;
	reseedSent: boolean;
	handleSnapshotBegin(payload: SnapshotBeginPayload): void;
	handleSnapshotChunk(payload: SnapshotChunkPayload): void;
	handleSnapshotEnd(payload: SnapshotEndPayload): void;
}

// Install a fake OPEN socket that captures every outbound frame.
function captureSocket(client: WsSyncClient): Uint8Array[] {
	const sent: Uint8Array[] = [];
	(client as unknown as SpokeInjector).symmetricKey = symKey;
	(client as unknown as SpokeInjector).ws = {
		readyState: 1, // WebSocket.OPEN
		send: (data: unknown) => {
			sent.push(new Uint8Array(data as ArrayBufferLike));
		},
	};
	return sent;
}

describe("spoke snapshot seeding", () => {
	let client: WsSyncClient | null = null;

	afterEach(() => {
		client?.close();
		client = null;
	});

	it("handleSnapshotBegin resets the row counter and marks reseed as satisfied", () => {
		const { transport } = makeStubTransport();
		client = makeClient(transport);
		const inj = client as unknown as SpokeInjector;
		inj.snapshotRowCount = 999;

		inj.handleSnapshotBegin({
			snapshot_hlc: "2025-06-01T00:00:00.000Z_0000_aaaa",
			tables: ["users", "threads"],
		});

		expect(inj.snapshotHlc).toBe("2025-06-01T00:00:00.000Z_0000_aaaa");
		expect(inj.snapshotRowCount).toBe(0);
		// Hub is already seeding us, so the spoke must not also request a reseed.
		expect(inj.reseedSent).toBe(true);
	});

	it("handleSnapshotChunk applies row batches and accumulates the running count", () => {
		const { transport, calls } = makeStubTransport(1);
		client = makeClient(transport);
		const inj = client as unknown as SpokeInjector;
		inj.snapshotRowCount = 0;

		inj.handleSnapshotChunk({
			table_name: "users",
			offset: 0,
			rows: [{ id: "u1" }, { id: "u2" }],
			last: false,
		});
		inj.handleSnapshotChunk({
			table_name: "users",
			offset: 2,
			rows: [{ id: "u3" }],
			last: true,
		});

		expect(calls.snapshotChunks).toHaveLength(2);
		expect(calls.snapshotChunks[0].table).toBe("users");
		expect(calls.snapshotChunks[0].rows).toHaveLength(2);
		expect(inj.snapshotRowCount).toBe(3); // 2 + 1 applied
	});

	it("handleSnapshotChunk routes a column-chunk frame to applyColumnChunk", () => {
		const { transport, calls } = makeStubTransport();
		client = makeClient(transport);
		const inj = client as unknown as SpokeInjector;

		inj.handleSnapshotChunk({
			table_name: "messages",
			offset: 0,
			rows: [],
			last: true,
			col_chunk_row_id: "msg-1",
			col_chunk_column: "content",
			col_chunk_index: 2,
			col_chunk_data: "big-blob-piece",
		});

		expect(calls.columnChunks).toHaveLength(1);
		expect(calls.columnChunks[0]).toEqual({
			table: "messages",
			pk: "msg-1",
			column: "content",
			index: 2,
			data: "big-blob-piece",
		});
		// Column chunks don't count toward the row tally.
		expect(inj.snapshotRowCount).toBe(0);
		// No plain-row apply happened.
		expect(calls.snapshotChunks).toHaveLength(0);
	});

	it("handleSnapshotChunk is a no-op when no wsTransport is configured", () => {
		client = makeClient(undefined);
		const inj = client as unknown as SpokeInjector;
		// Must not throw despite rows being present.
		expect(() =>
			inj.handleSnapshotChunk({
				table_name: "users",
				offset: 0,
				rows: [{ id: "u1" }],
				last: false,
			}),
		).not.toThrow();
	});

	it("handleSnapshotEnd sends a SNAPSHOT_ACK carrying the begin HLC", () => {
		const { transport } = makeStubTransport();
		client = makeClient(transport);
		const inj = client as unknown as SpokeInjector;
		const sent = captureSocket(client);

		const hlc = "2025-06-01T00:00:00.000Z_0000_bbbb";
		inj.handleSnapshotBegin({ snapshot_hlc: hlc, tables: ["users"] });
		inj.handleSnapshotChunk({
			table_name: "users",
			offset: 0,
			rows: [{ id: "u1" }],
			last: true,
		});
		inj.handleSnapshotEnd({ table_count: 1, row_count: 1 });

		expect(sent).toHaveLength(1);
		const decoded = decodeFrame(sent[0], symKey);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.type).toBe(WsMessageType.SNAPSHOT_ACK);
		expect((decoded.value.payload as { snapshot_hlc: string }).snapshot_hlc).toBe(hlc);

		// State reset so a subsequent snapshot starts clean.
		expect(inj.snapshotHlc).toBeNull();
		expect(inj.snapshotRowCount).toBe(0);
	});

	it("handleSnapshotEnd sends no ACK when the begin HLC is missing", () => {
		const { transport } = makeStubTransport();
		client = makeClient(transport);
		const inj = client as unknown as SpokeInjector;
		const sent = captureSocket(client);

		// No SNAPSHOT_BEGIN — snapshotHlc stays null, so no ack is emitted.
		inj.handleSnapshotEnd({ table_count: 0, row_count: 0 });
		expect(sent).toHaveLength(0);
	});
});
