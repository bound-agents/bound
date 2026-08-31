// 4D-B spool-transfer protocol: peer-targeted durable_work rows travel host to
// host over SPOOL_TRANSFER / SPOOL_TRANSFER_ACK. Sender retires its copy only
// after the receiver has durably inserted (or deduplicated) its destination
// copy. See R-DW10/R-DW11 and docs/design/specs/2026-08-31-durable-work-consolidation.md.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type DurableWorkRow, insertDurableWork, setDurableWorkEventBus } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { WsMessageType, decodeFrame } from "../ws-frames.js";
import type { SpoolTransferAckPayload, SpoolTransferPayload } from "../ws-frames.js";
import { WsTransport } from "../ws-transport.js";

const KEY = new Uint8Array(32).fill(7);

/** Minimal schema for durable_work + the hosts capability row. */
function createDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.exec(`
		CREATE TABLE durable_work (
			id TEXT PRIMARY KEY, target_site_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			claim_state TEXT NOT NULL DEFAULT 'pending' CHECK (claim_state IN ('pending', 'processing', 'transferring', 'consumed', 'dead_letter')),
			claim_token TEXT, claimed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
			created_at TEXT NOT NULL, expires_at TEXT, dead_lettered_at TEXT, consumed_at TEXT,
			ref_id TEXT, source_site TEXT, received_at TEXT, stream_id TEXT
		) STRICT;
		CREATE TABLE hosts (
			site_id TEXT PRIMARY KEY, host_name TEXT NOT NULL, version TEXT NOT NULL,
			online_at TEXT NOT NULL, modified_at TEXT NOT NULL,
			work_spool_capable INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0
		) STRICT;
	`);
	return db;
}

/** Declare a peer's advertised work-spool capability in this host's hosts table. */
function setPeerCapability(db: Database, siteId: string, capable: boolean): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable)
		 VALUES (?, ?, '0', ?, ?, ?)
		 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = excluded.work_spool_capable`,
		[siteId, siteId, now, now, capable ? 1 : 0],
	);
}

/**
 * Insert a pending row on `node`. The durable_work event bus is a module-level
 * singleton in @bound/core; in this single-process test each node has its own
 * bus, so we point the singleton at THIS node's bus immediately before the
 * insert so the push-on-insert path fires on the right transport. (In the real
 * system each host process owns its own @bound/core module instance and one
 * shared bus, so there is no such contention.) Passing `push: false` skips the
 * bus entirely for drain-based tests that must NOT auto-transfer on insert.
 */
function seedPendingRow(
	node: Node,
	overrides: Partial<DurableWorkRow> & { id: string },
	push = true,
): void {
	setDurableWorkEventBus(push ? node.bus : null);
	try {
		insertDurableWork(node.db, {
			id: overrides.id,
			target_site_id: overrides.target_site_id ?? "peer",
			kind: overrides.kind ?? "tool_call",
			payload: overrides.payload ?? JSON.stringify({ hello: overrides.id }),
			idempotency_key: overrides.idempotency_key ?? `key-${overrides.id}`,
			expires_at: overrides.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
			ref_id: overrides.ref_id ?? null,
			source_site: overrides.source_site ?? null,
			received_at: overrides.received_at ?? null,
			stream_id: overrides.stream_id ?? null,
		});
	} finally {
		setDurableWorkEventBus(null);
	}
}

function rowState(db: Database, id: string): DurableWorkRow | null {
	return db.query("SELECT * FROM durable_work WHERE id = ?").get(id) as DurableWorkRow | null;
}

/**
 * A test node: one WsTransport + its DB + a shared bus. Each node captures the
 * frames its transport tries to send so the harness can deliver them by hand,
 * giving deterministic control over ack drops and reconnect ordering.
 */
interface Node {
	siteId: string;
	db: Database;
	transport: WsTransport;
	bus: TypedEventEmitter;
	sent: Uint8Array[];
	stop: () => void;
}

function createNode(siteId: string, isHub = false): Node {
	const db = createDb();
	const bus = new TypedEventEmitter();
	const sent: Uint8Array[] = [];
	const transport = new WsTransport({ db, siteId, eventBus: bus, isHub });
	// The durable_work:written push path is driven per-insert via seedPendingRow,
	// which points the module-level bus at the target node just for that insert.
	transport.start();
	return {
		siteId,
		db,
		transport,
		bus,
		sent,
		stop: () => {
			transport.stop();
			db.close();
		},
	};
}

/**
 * Run a node's transport handler with the module-level durable_work bus pointed
 * at THAT node's bus for the duration of the call. Receiver-side inserts inside
 * handleSpoolTransfer emit `durable_work:written`, which in production the node's
 * own transport listens on to forward hub-buffered rows onward; scoping the
 * singleton here models that per-process ownership faithfully in one test
 * process. Restores the previous binding afterward for toggle hygiene.
 */
function act<T>(node: Node, fn: () => T): T {
	setDurableWorkEventBus(node.bus);
	try {
		return fn();
	} finally {
		setDurableWorkEventBus(null);
	}
}

/** Register `peer` as a connected peer of `node`, capturing sent frames. */
function connect(node: Node, peerSiteId: string): void {
	node.transport.addPeer(
		peerSiteId,
		(frame) => {
			node.sent.push(frame);
			return true;
		},
		KEY,
	);
}

/** Decode the frames a node captured, filtered to the two spool frame types. */
function decodeSpoolFrames(
	node: Node,
): Array<
	| { type: WsMessageType.SPOOL_TRANSFER; payload: SpoolTransferPayload }
	| { type: WsMessageType.SPOOL_TRANSFER_ACK; payload: SpoolTransferAckPayload }
> {
	const out: Array<
		| { type: WsMessageType.SPOOL_TRANSFER; payload: SpoolTransferPayload }
		| { type: WsMessageType.SPOOL_TRANSFER_ACK; payload: SpoolTransferAckPayload }
	> = [];
	for (const frame of node.sent) {
		const decoded = decodeFrame(frame, KEY);
		if (!decoded.ok) continue;
		if (
			decoded.value.type === WsMessageType.SPOOL_TRANSFER ||
			decoded.value.type === WsMessageType.SPOOL_TRANSFER_ACK
		) {
			out.push(decoded.value as (typeof out)[number]);
		}
	}
	return out;
}

/** Narrow a possibly-undefined decoded frame to its payload, failing the test if absent. */
function payloadOf<P>(frame: { payload: P } | undefined): P {
	if (!frame) throw new Error("expected a spool frame but none was captured");
	return frame.payload;
}

describe("spool transfer (4D-B)", () => {
	afterEach(() => {
		// Toggle hygiene: the durable_work event bus is a module-level singleton in
		// @bound/core. Clear it so a subsequent test file starting in the same bun
		// process never sees this file's bus (two prior gate failures were toggle
		// leaks between test files).
		setDurableWorkEventBus(null);
	});

	describe("(a) direct transfer round-trip", () => {
		let sender: Node;
		let receiver: Node;

		beforeEach(() => {
			sender = createNode("sender");
			receiver = createNode("receiver");
		});
		afterEach(() => {
			sender.stop();
			receiver.stop();
		});

		it("pending → transferring → SPOOL_TRANSFER → receiver pending → ack → sender copy gone", () => {
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			connect(receiver, "sender");

			// Push path: inserting a peer-targeted row emits durable_work:written,
			// which the sender transport transfers to the advertising receiver.
			seedPendingRow(sender, {
				id: "row-1",
				target_site_id: "receiver",
				kind: "tool_call",
				stream_id: "stream-xyz",
				source_site: "sender",
			});

			// Sender began the transfer (pending → transferring, token retained).
			expect(rowState(sender.db, "row-1")?.claim_state).toBe("transferring");
			expect(rowState(sender.db, "row-1")?.claim_token).toBeTruthy();

			// One SPOOL_TRANSFER frame carrying immutable identity, incl. stream_id.
			const frames = decodeSpoolFrames(sender);
			expect(frames).toHaveLength(1);
			const transfer = frames[0];
			expect(transfer.type).toBe(WsMessageType.SPOOL_TRANSFER);
			const payload = transfer.payload as SpoolTransferPayload;
			expect(payload.entries).toHaveLength(1);
			expect(payload.entries[0]).toMatchObject({
				id: "row-1",
				target_site_id: "receiver",
				kind: "tool_call",
				idempotency_key: "key-row-1",
				stream_id: "stream-xyz",
				source_site: "sender",
			});
			// No mutable claim state travels.
			expect(payload.entries[0]).not.toHaveProperty("claim_state");
			expect(payload.entries[0]).not.toHaveProperty("claim_token");
			expect(payload.entries[0]).not.toHaveProperty("attempt_count");

			// Deliver the transfer to the receiver.
			receiver.transport.handleSpoolTransfer("sender", payload);

			// Receiver has a fresh pending row with identity fields intact.
			const received = rowState(receiver.db, "row-1");
			expect(received).toMatchObject({
				id: "row-1",
				target_site_id: "receiver",
				kind: "tool_call",
				idempotency_key: "key-row-1",
				stream_id: "stream-xyz",
				source_site: "sender",
				claim_state: "pending",
			});

			// Receiver acked the id AND echoed the transfer token; deliver back to sender.
			const ack = decodeSpoolFrames(receiver).find(
				(f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK,
			);
			const ackPayload = payloadOf(ack) as SpoolTransferAckPayload;
			expect(ackPayload.entries).toHaveLength(1);
			expect(ackPayload.entries[0].id).toBe("row-1");
			// The echoed token is exactly the sender's live transferring token.
			expect(ackPayload.entries[0].token).toBe(rowState(sender.db, "row-1")?.claim_token);
			sender.transport.handleSpoolTransferAck("receiver", ackPayload);

			// Sender copy retired (deleted) after transfer ack.
			expect(rowState(sender.db, "row-1")).toBeNull();
		});
	});

	describe("(b) redelivery after a dropped ack", () => {
		let sender: Node;
		let receiver: Node;

		beforeEach(() => {
			sender = createNode("sender");
			receiver = createNode("receiver");
		});
		afterEach(() => {
			sender.stop();
			receiver.stop();
		});

		it("dedupes on the fence, acks again, and lands exactly one receiver row", () => {
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			connect(receiver, "sender");

			seedPendingRow(sender, { id: "row-2", target_site_id: "receiver", source_site: "sender" });
			const firstTransfer = decodeSpoolFrames(sender)[0].payload as SpoolTransferPayload;

			// First delivery: receiver inserts, acks — but the ack is DROPPED.
			receiver.transport.handleSpoolTransfer("sender", firstTransfer);
			expect(rowState(sender.db, "row-2")?.claim_state).toBe("transferring");

			// Re-send: the row is still transferring; a reconnect drain re-ships it.
			sender.sent.length = 0;
			sender.transport.drainDurableWorkSpool("receiver");
			const resend = decodeSpoolFrames(sender);
			expect(resend).toHaveLength(1);
			const resendPayload = resend[0].payload as SpoolTransferPayload;

			// Receiver dedupes on (kind, idempotency_key) and acks again.
			receiver.sent.length = 0;
			receiver.transport.handleSpoolTransfer("sender", resendPayload);
			const ack = decodeSpoolFrames(receiver)[0];
			expect(ack.type).toBe(WsMessageType.SPOOL_TRANSFER_ACK);
			expect((ack.payload as SpoolTransferAckPayload).entries.map((e) => e.id)).toEqual(["row-2"]);

			// Exactly one receiver row.
			expect(
				(
					receiver.db.query("SELECT COUNT(*) AS n FROM durable_work WHERE id = 'row-2'").get() as {
						n: number;
					}
				).n,
			).toBe(1);

			// Sender retires on the second ack.
			sender.transport.handleSpoolTransferAck("receiver", ack.payload as SpoolTransferAckPayload);
			expect(rowState(sender.db, "row-2")).toBeNull();
		});
	});

	describe("(c) capability gate", () => {
		let sender: Node;

		beforeEach(() => {
			sender = createNode("sender");
		});
		afterEach(() => {
			sender.stop();
		});

		it("leaves the row pending and sends nothing to a non-advertising peer", () => {
			setPeerCapability(sender.db, "peer", false);
			connect(sender, "peer");

			seedPendingRow(sender, { id: "row-3", target_site_id: "peer" });

			expect(rowState(sender.db, "row-3")?.claim_state).toBe("pending");
			expect(decodeSpoolFrames(sender)).toHaveLength(0);
		});

		it("picks the row up once the capability flips on and a drain runs", () => {
			setPeerCapability(sender.db, "peer", false);
			connect(sender, "peer");
			seedPendingRow(sender, { id: "row-4", target_site_id: "peer" });
			expect(decodeSpoolFrames(sender)).toHaveLength(0);

			// Capability appears; drain (reconnect trigger) now transfers the row.
			setPeerCapability(sender.db, "peer", true);
			sender.transport.drainDurableWorkSpool("peer");

			expect(rowState(sender.db, "row-4")?.claim_state).toBe("transferring");
			const frames = decodeSpoolFrames(sender);
			expect(frames).toHaveLength(1);
			expect((frames[0].payload as SpoolTransferPayload).entries[0].id).toBe("row-4");
		});
	});

	describe("(d) hub forward (spoke A → hub B → spoke C)", () => {
		let a: Node;
		let b: Node;
		let c: Node;

		beforeEach(() => {
			a = createNode("A");
			b = createNode("B", true);
			c = createNode("C");
		});
		afterEach(() => {
			a.stop();
			b.stop();
			c.stop();
		});

		it("hub buffers durably + acks A, forwards to C, retires its copy — row lands once on C", () => {
			// A → B (hub advertises), B → C (C advertises).
			setPeerCapability(a.db, "B", true);
			setPeerCapability(b.db, "C", true);
			connect(a, "B");
			connect(b, "A");
			connect(b, "C");
			connect(c, "B");

			// A writes a row targeted at C.
			seedPendingRow(a, { id: "row-5", target_site_id: "C", source_site: "A" });
			expect(rowState(a.db, "row-5")?.claim_state).toBe("transferring");
			const aTransfer = decodeSpoolFrames(a)[0].payload as SpoolTransferPayload;

			// B receives: inserts into its OWN durable_work (target still C, pending),
			// acks A, and its own sender-drain forwards to C.
			act(b, () => b.transport.handleSpoolTransfer("A", aTransfer));

			// B buffered the row durably with the final destination + source preserved.
			expect(rowState(b.db, "row-5")).toMatchObject({
				target_site_id: "C",
				source_site: "A",
			});

			// B acked A → A retires its copy.
			const bFrames = decodeSpoolFrames(b);
			const ackToA = bFrames.find((f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK);
			const ackToAPayload = payloadOf(ackToA) as SpoolTransferAckPayload;
			expect(ackToAPayload.entries.map((e) => e.id)).toEqual(["row-5"]);
			// The echoed token is A's own begin-transfer generation for its copy.
			expect(ackToAPayload.entries[0].token).toBe(rowState(a.db, "row-5")?.claim_token);
			a.transport.handleSpoolTransferAck("B", ackToAPayload);
			expect(rowState(a.db, "row-5")).toBeNull();

			// B's push path forwarded a SPOOL_TRANSFER onward to C.
			const forward = bFrames.find((f) => f.type === WsMessageType.SPOOL_TRANSFER);
			expect(forward).toBeTruthy();
			expect(rowState(b.db, "row-5")?.claim_state).toBe("transferring");

			// C inserts + acks; B retires its copy on that ack.
			act(c, () =>
				c.transport.handleSpoolTransfer("B", payloadOf(forward) as SpoolTransferPayload),
			);
			expect(rowState(c.db, "row-5")).toMatchObject({
				target_site_id: "C",
				source_site: "A",
				claim_state: "pending",
			});
			const ackToB = decodeSpoolFrames(c).find((f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK);
			b.transport.handleSpoolTransferAck("C", payloadOf(ackToB) as SpoolTransferAckPayload);
			expect(rowState(b.db, "row-5")).toBeNull();

			// Row landed exactly once on C.
			expect(
				(
					c.db.query("SELECT COUNT(*) AS n FROM durable_work WHERE id = 'row-5'").get() as {
						n: number;
					}
				).n,
			).toBe(1);
		});
	});

	describe("(e) reconnect drain and lost-ack recovery", () => {
		let sender: Node;
		let receiver: Node;

		beforeEach(() => {
			sender = createNode("sender");
			receiver = createNode("receiver");
		});
		afterEach(() => {
			sender.stop();
			receiver.stop();
		});

		it("transfers rows accumulated while the peer was offline, on reconnect", () => {
			// Peer advertising but NOT connected: rows accumulate pending.
			setPeerCapability(sender.db, "receiver", true);
			seedPendingRow(sender, { id: "off-1", target_site_id: "receiver" });
			seedPendingRow(sender, { id: "off-2", target_site_id: "receiver" });
			expect(decodeSpoolFrames(sender)).toHaveLength(0);
			expect(rowState(sender.db, "off-1")?.claim_state).toBe("pending");

			// Reconnect: peer connects, drain runs.
			connect(sender, "receiver");
			sender.transport.drainDurableWorkSpool("receiver");

			expect(rowState(sender.db, "off-1")?.claim_state).toBe("transferring");
			expect(rowState(sender.db, "off-2")?.claim_state).toBe("transferring");
			const transferred = decodeSpoolFrames(sender)
				.filter((f) => f.type === WsMessageType.SPOOL_TRANSFER)
				.flatMap((f) => (f.payload as SpoolTransferPayload).entries.map((e) => e.id));
			expect(transferred.sort()).toEqual(["off-1", "off-2"]);
		});

		it("re-sends a transferring row whose ack was lost in a crash, safely once received", () => {
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			connect(receiver, "sender");

			// Simulate a pre-crash state: a row already transferring, ack never arrived.
			seedPendingRow(sender, { id: "crash-1", target_site_id: "receiver", source_site: "sender" });
			expect(rowState(sender.db, "crash-1")?.claim_state).toBe("transferring");
			const tokenBefore = rowState(sender.db, "crash-1")?.claim_token;

			// Reconnect drain re-sends WITHOUT re-beginning (token retained).
			sender.sent.length = 0;
			sender.transport.drainDurableWorkSpool("receiver");
			expect(rowState(sender.db, "crash-1")?.claim_token).toBe(tokenBefore ?? "");
			const resend = decodeSpoolFrames(sender);
			expect(resend).toHaveLength(1);

			// Receiver applies it once; ack retires the sender copy.
			act(receiver, () =>
				receiver.transport.handleSpoolTransfer("sender", resend[0].payload as SpoolTransferPayload),
			);
			const ack = decodeSpoolFrames(receiver).find(
				(f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK,
			);
			sender.transport.handleSpoolTransferAck(
				"receiver",
				payloadOf(ack) as SpoolTransferAckPayload,
			);
			expect(rowState(sender.db, "crash-1")).toBeNull();
			expect(
				(
					receiver.db
						.query("SELECT COUNT(*) AS n FROM durable_work WHERE id = 'crash-1'")
						.get() as {
						n: number;
					}
				).n,
			).toBe(1);
		});

		it("stale-token ack after a re-begin is a no-op (fence holds)", () => {
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			seedPendingRow(sender, { id: "fence-1", target_site_id: "receiver" });
			const staleToken = rowState(sender.db, "fence-1")?.claim_token ?? "stale";

			// A stale ack carrying the wrong token cannot retire the row: the handler
			// reads the CURRENT transferring token and only deletes under it. Simulate
			// a stale token by mutating the row's token, then acking — handler uses the
			// live token, so the delete succeeds; but a *wrong* explicit token must not.
			sender.db.run("UPDATE durable_work SET claim_token = 'newtok' WHERE id = 'fence-1'");
			// acknowledgeDurableWorkTransfer is token-fenced: the stale token fails.
			const { acknowledgeDurableWorkTransfer } = require("@bound/core");
			expect(acknowledgeDurableWorkTransfer(sender.db, "fence-1", staleToken)).toBe(false);
			expect(rowState(sender.db, "fence-1")?.claim_state).toBe("transferring");
		});

		it("a gen-1 ack delivered through the real handler after a gen-2 re-begin is fenced out", () => {
			// This exercises the WIRE path (handleSpoolTransferAck), not the helper
			// directly: the ack carries the ECHOED gen-1 token, the row now holds a
			// gen-2 token, and the token-through-wire fence must reject it end-to-end.
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			connect(receiver, "sender");

			// Gen 1: begin + send. Capture the gen-1 transfer + the ack the receiver
			// would echo (carrying the gen-1 token) — but DROP the ack.
			seedPendingRow(sender, { id: "gen-1", target_site_id: "receiver", source_site: "sender" });
			const gen1Token = rowState(sender.db, "gen-1")?.claim_token;
			expect(gen1Token).toBeTruthy();
			const gen1Transfer = decodeSpoolFrames(sender)[0].payload as SpoolTransferPayload;
			expect(gen1Transfer.entries[0].token).toBe(gen1Token);
			receiver.transport.handleSpoolTransfer("sender", gen1Transfer);
			const gen1Ack = payloadOf(
				decodeSpoolFrames(receiver).find((f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK),
			) as SpoolTransferAckPayload;
			expect(gen1Ack.entries[0].token).toBe(gen1Token);

			// No live code path re-begins a still-transferring row (resume retains the
			// token by design — readTransferringDurableWork re-sends without
			// beginDurableWorkTransfer). Force a gen-2 generation the only way a
			// redrive/reset would: reset the row to pending, then begin again.
			const { beginDurableWorkTransfer } = require("@bound/core");
			sender.db.run(
				"UPDATE durable_work SET claim_state = 'pending', claim_token = NULL WHERE id = 'gen-1'",
			);
			const gen2Token = beginDurableWorkTransfer(sender.db, "gen-1");
			expect(gen2Token).toBeTruthy();
			expect(gen2Token).not.toBe(gen1Token);

			// Deliver the STALE gen-1 ack through the real handler. The echoed gen-1
			// token no longer matches the row's gen-2 token, so the fence holds: the
			// row is NOT retired and still transferring under gen-2.
			sender.transport.handleSpoolTransferAck("receiver", gen1Ack);
			expect(rowState(sender.db, "gen-1")?.claim_state).toBe("transferring");
			expect(rowState(sender.db, "gen-1")?.claim_token).toBe(gen2Token);

			// A correct gen-2 ack through the same handler DOES retire it.
			sender.transport.handleSpoolTransferAck("receiver", {
				entries: [{ id: "gen-1", token: gen2Token as string }],
			});
			expect(rowState(sender.db, "gen-1")).toBeNull();
		});
	});

	describe("(h) stale-transferring recovery without a reconnect", () => {
		let sender: Node;
		let receiver: Node;

		beforeEach(() => {
			sender = createNode("sender");
			receiver = createNode("receiver");
		});
		afterEach(() => {
			sender.stop();
			receiver.stop();
		});

		// Live incident (#253, spoke 7cf34dd659c0): a peer-targeted row flips
		// pending -> transferring on the push path, the SPOOL_TRANSFER ships, the
		// receiver DURABLY accepts it, but its SPOOL_TRANSFER_ACK never reaches the
		// sender. drainDurableWorkSpool only re-sends on a *reconnect*; a
		// persistently-connected sender whose ack was dropped has no retry path, so
		// the row wedges at transferring past its transfer timeout forever (observed:
		// 200+ platform_request rows, attempt_count=0). This test drives the full real
		// interaction with SELECTIVE ack suppression — real frame path, no transport
		// stub: (1) receiver durably accepts the original transfer, (2) that ack is
		// dropped, (3) the sender sweep reclaims under a NEW token and re-sends, (4)
		// the stale original ack arrives and is REJECTED by the (id, transferring,
		// token) fence, (5) the duplicate transfer is deduplicated receiver-side, (6)
		// the new-token ack finally retires the sender row.
		it("survives a dropped ack: reclaims under a new token, rejects the stale ack, dedups the resend, and retires on the new ack", () => {
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			connect(receiver, "sender");

			// (1) Push path: the row begins transferring and ships. Its terminal TTL is
			// far in the FUTURE — the work is still live; only its transfer ack failed.
			seedPendingRow(sender, {
				id: "stale-1",
				target_site_id: "receiver",
				source_site: "sender",
				expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
			});
			expect(rowState(sender.db, "stale-1")?.claim_state).toBe("transferring");
			const originalToken = rowState(sender.db, "stale-1")?.claim_token;
			const originalTransfer = payloadOf(
				decodeSpoolFrames(sender).find((f) => f.type === WsMessageType.SPOOL_TRANSFER),
			) as SpoolTransferPayload;

			// (1) The receiver durably accepts the ORIGINAL transfer and emits its ack
			// echoing the original token — but that ack is DROPPED (never handed to the
			// sender). Capture it so we can replay it stale in step (4).
			act(receiver, () => receiver.transport.handleSpoolTransfer("sender", originalTransfer));
			expect(rowState(receiver.db, "stale-1")?.claim_state).toBe("pending");
			const droppedAck = payloadOf(
				decodeSpoolFrames(receiver).find((f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK),
			) as SpoolTransferAckPayload;
			expect(droppedAck.entries[0].token).toBe(originalToken);

			// The transfer timeout lapses with the sender still transferring (ack never
			// arrived). Back-date claimed_at so the sweep's transfer clock fires; the
			// terminal expiry is untouched (the work is still live). Clear captured
			// frames so the next SPOOL_TRANSFER provably comes from recovery.
			const staleClaimedAt = new Date(Date.now() - 120_000).toISOString();
			sender.db.run("UPDATE durable_work SET claimed_at = ? WHERE id = 'stale-1'", [
				staleClaimedAt,
			]);
			sender.sent.length = 0;
			receiver.sent.length = 0;

			// (3) Recovery: the sweep reclaims the stale transferring row and re-drives
			// it over the live link. The redrive re-begins the transfer under a NEW
			// generation (fresh token), charging one attempt.
			sender.transport.sweepAndRedriveStaleDurableWork();
			const reswept = rowState(sender.db, "stale-1");
			expect(reswept?.claim_state).toBe("transferring");
			expect(reswept?.attempt_count).toBe(1);
			const newToken = reswept?.claim_token;
			expect(newToken).toBeTruthy();
			expect(newToken).not.toBe(originalToken);

			const resend = decodeSpoolFrames(sender).filter(
				(f) => f.type === WsMessageType.SPOOL_TRANSFER,
			);
			expect(resend).toHaveLength(1);
			const resendPayload = resend[0].payload as SpoolTransferPayload;
			expect(resendPayload.entries[0].id).toBe("stale-1");
			expect(resendPayload.entries[0].token).toBe(newToken);

			// (4) The stale ORIGINAL ack (carrying the retired token) finally arrives.
			// The (id, transferring, token) fence rejects it: the sender row is now under
			// the new generation, so the stale delete matches nothing and the row stays
			// transferring — it is NOT double-retired.
			sender.transport.handleSpoolTransferAck("receiver", droppedAck);
			expect(rowState(sender.db, "stale-1")?.claim_state).toBe("transferring");
			expect(rowState(sender.db, "stale-1")?.claim_token).toBe(newToken);

			// (5) The receiver applies the DUPLICATE resend. Its destination copy is
			// already present under the (kind, idempotency_key) fence, so the insert is a
			// no-op dedup — the receiver still acks (echoing the NEW token) so the sender
			// can retire either way.
			act(receiver, () => receiver.transport.handleSpoolTransfer("sender", resendPayload));
			const newAcks = decodeSpoolFrames(receiver).filter(
				(f) => f.type === WsMessageType.SPOOL_TRANSFER_ACK,
			);
			expect(newAcks).toHaveLength(1);
			const newAck = newAcks[0].payload as SpoolTransferAckPayload;
			expect(newAck.entries[0].token).toBe(newToken);

			// (6) The new-token ack retires the sender copy — the stall clears exactly
			// once. The receiver still holds its single durable copy.
			sender.transport.handleSpoolTransferAck("receiver", newAck);
			expect(rowState(sender.db, "stale-1")).toBeNull();
			expect(rowState(receiver.db, "stale-1")?.claim_state).toBe("pending");
		});

		it("leaves a still-fresh transferring row untouched (TTL not yet lapsed)", () => {
			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");

			seedPendingRow(sender, {
				id: "fresh-1",
				target_site_id: "receiver",
				source_site: "sender",
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			});
			const tokenBefore = rowState(sender.db, "fresh-1")?.claim_token;
			sender.sent.length = 0;

			sender.transport.sweepAndRedriveStaleDurableWork();

			// Not swept: same token, no attempt charged, nothing re-sent.
			expect(rowState(sender.db, "fresh-1")?.claim_token).toBe(tokenBefore ?? "");
			expect(rowState(sender.db, "fresh-1")?.attempt_count).toBe(0);
			expect(decodeSpoolFrames(sender)).toHaveLength(0);
		});
	});

	describe("(f) receiver consumer wake", () => {
		let sender: Node;
		let receiver: Node;

		beforeEach(() => {
			sender = createNode("sender");
			receiver = createNode("receiver");
		});
		afterEach(() => {
			sender.stop();
			receiver.stop();
		});

		it("emits relay:inbox to wake the local durable consumer lane for a self-targeted row", () => {
			const wakes: Array<{ kind: string; ref_id?: string; stream_id?: string }> = [];
			receiver.bus.on("relay:inbox", (e) => wakes.push(e));

			setPeerCapability(sender.db, "receiver", true);
			connect(sender, "receiver");
			connect(receiver, "sender");

			seedPendingRow(sender, {
				id: "wake-1",
				target_site_id: "receiver",
				kind: "tool_call",
				ref_id: "ref-1",
				stream_id: "s-1",
				source_site: "sender",
			});
			const transfer = decodeSpoolFrames(sender)[0].payload as SpoolTransferPayload;
			receiver.transport.handleSpoolTransfer("sender", transfer);

			// The 4D-A durable lane runs on the relay-processor tick, nudged by
			// relay:inbox. The receiver fires exactly that wake for a self-targeted row.
			expect(wakes).toEqual([{ kind: "tool_call", ref_id: "ref-1", stream_id: "s-1" }]);
		});

		it("does NOT wake the local lane for a hub-forwarded row (target != self)", () => {
			const hub = createNode("hub", true);
			const wakes: unknown[] = [];
			hub.bus.on("relay:inbox", (e) => wakes.push(e));

			connect(hub, "sender");
			const transfer: SpoolTransferPayload = {
				entries: [
					{
						id: "fwd-1",
						target_site_id: "elsewhere",
						source_site: "sender",
						kind: "tool_call",
						payload: { x: 1 },
						idempotency_key: "key-fwd-1",
						ref_id: null,
						stream_id: null,
						expires_at: new Date(Date.now() + 60_000).toISOString(),
						received_at: null,
						token: "tok-fwd-1",
					},
				],
			};
			hub.transport.handleSpoolTransfer("sender", transfer);

			// Buffered locally with the final destination, but no local-lane wake.
			expect(rowState(hub.db, "fwd-1")?.target_site_id).toBe("elsewhere");
			expect(wakes).toHaveLength(0);
			hub.stop();
		});
	});

	describe("(g) LOCAL_WORK_TARGET sentinel is never spool-transferred", () => {
		let spoke: Node;

		beforeEach(() => {
			spoke = createNode("spoke");
		});
		afterEach(() => {
			spoke.stop();
		});

		it("push path leaves a local-targeted row pending even with a capable hub connected", () => {
			// Regression: a spoke routes every peer-targeted row to its hub
			// (resolveSpoolNextHop), and 'local' !== siteId, so before the sentinel
			// guard the dispatch wakeup was begun (transferring) and shipped to the
			// hub — permanently stranding the thread wakeup it carried.
			setPeerCapability(spoke.db, "hub", true);
			connect(spoke, "hub");

			seedPendingRow(spoke, {
				id: "wakeup-1",
				target_site_id: "local",
				kind: "dispatch_message",
				payload: JSON.stringify({
					message_id: "m-1",
					thread_id: "t-1",
					event_type: "user_message",
					event_payload: null,
				}),
			});

			expect(rowState(spoke.db, "wakeup-1")?.claim_state).toBe("pending");
			expect(decodeSpoolFrames(spoke)).toHaveLength(0);
		});

		it("reconnect drain skips local-targeted rows", () => {
			setPeerCapability(spoke.db, "hub", true);

			// Insert without the push bus, then connect + drain (the offline-accumulation path).
			seedPendingRow(
				spoke,
				{ id: "wakeup-2", target_site_id: "local", kind: "dispatch_message" },
				false,
			);
			seedPendingRow(
				spoke,
				{ id: "real-peer-row", target_site_id: "hub", kind: "tool_call" },
				false,
			);

			connect(spoke, "hub");
			spoke.transport.drainDurableWorkSpool("hub");

			// Only the genuinely peer-targeted row transfers.
			expect(rowState(spoke.db, "wakeup-2")?.claim_state).toBe("pending");
			expect(rowState(spoke.db, "real-peer-row")?.claim_state).toBe("transferring");
			const frames = decodeSpoolFrames(spoke);
			expect(frames).toHaveLength(1);
			const transfer = payloadOf(
				frames.find((f) => f.type === WsMessageType.SPOOL_TRANSFER),
			) as SpoolTransferPayload;
			expect(transfer.entries.map((e) => e.id)).toEqual(["real-peer-row"]);
		});
	});
});
