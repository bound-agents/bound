import { describe, expect, it } from "bun:test";
import { createWsTransportHolderStubs, wireWsTransportHolder } from "../wire-ws-transport-holder";

/**
 * Regression tests for the #253 spool wedge: the hub's wsTransport holder was
 * created with no-op stubs, and the production wiring `Object.assign` omitted
 * `handleSpoolTransfer` / `handleSpoolTransferAck` / `drainDurableWorkSpool`.
 * Inbound SPOOL_TRANSFER / SPOOL_TRANSFER_ACK frames dispatched into empty
 * arrows — no insert, no ack, no log — so hub-side spool receive was silent.
 *
 * These tests exercise the real wiring path (the same function index.ts calls)
 * and assert every declared holder method forwards to the real instance.
 */

/**
 * Build a fake WsTransport whose every method records that it was invoked with
 * the correct `this` binding, so the test can prove the holder forwards to the
 * real instance rather than to a leftover stub.
 */
function makeSpyTransport() {
	const calls: Array<{ method: string; args: unknown[]; boundToInstance: boolean }> = [];
	const marker = { isRealInstance: true };
	const record = (method: string, ret?: unknown) =>
		function (this: unknown, ...args: unknown[]) {
			calls.push({
				method,
				args,
				boundToInstance: (this as { isRealInstance?: boolean })?.isRealInstance === true,
			});
			return ret;
		};
	const transport = Object.assign(marker, {
		addPeer: record("addPeer"),
		removePeer: record("removePeer"),
		handleChangelogPush: record("handleChangelogPush"),
		handleChangelogAck: record("handleChangelogAck"),
		drainChangelog: record("drainChangelog"),
		handleRelaySend: record("handleRelaySend"),
		handleRelayAck: record("handleRelayAck"),
		handleSpoolTransfer: record("handleSpoolTransfer"),
		handleSpoolTransferAck: record("handleSpoolTransferAck"),
		drainDurableWorkSpool: record("drainDurableWorkSpool"),
		seedNewPeer: record("seedNewPeer"),
		handleSnapshotAck: record("handleSnapshotAck"),
		continueSnapshotSeed: record("continueSnapshotSeed"),
		applySnapshotChunk: record("applySnapshotChunk", 0),
		handleReseedRequest: record("handleReseedRequest"),
		handleConsistencyRequest: record("handleConsistencyRequest"),
		requestConsistency: record("requestConsistency", new Map()),
		handleRowPullRequest: record("handleRowPullRequest"),
		handleRowPullAck: record("handleRowPullAck"),
		continueRowPull: record("continueRowPull"),
		continueConsistencyStream: record("continueConsistencyStream"),
	});
	return { transport: transport as never, calls };
}

describe("wireWsTransportHolder", () => {
	it("forwards handleSpoolTransfer to the real instance (the #253 wedge)", () => {
		const holder = createWsTransportHolderStubs();
		const { transport, calls } = makeSpyTransport();

		wireWsTransportHolder(holder, transport);
		holder.handleSpoolTransfer("hub-site", { entries: [] });

		expect(calls).toEqual([
			{
				method: "handleSpoolTransfer",
				args: ["hub-site", { entries: [] }],
				boundToInstance: true,
			},
		]);
	});

	it("forwards handleSpoolTransferAck to the real instance", () => {
		const holder = createWsTransportHolderStubs();
		const { transport, calls } = makeSpyTransport();

		wireWsTransportHolder(holder, transport);
		holder.handleSpoolTransferAck("hub-site", { acked: 1 });

		expect(calls).toEqual([
			{
				method: "handleSpoolTransferAck",
				args: ["hub-site", { acked: 1 }],
				boundToInstance: true,
			},
		]);
	});

	it("forwards drainDurableWorkSpool to the real instance", () => {
		const holder = createWsTransportHolderStubs();
		const { transport, calls } = makeSpyTransport();

		wireWsTransportHolder(holder, transport);
		holder.drainDurableWorkSpool("peer-site");

		expect(calls).toEqual([
			{ method: "drainDurableWorkSpool", args: ["peer-site"], boundToInstance: true },
		]);
	});

	it("forwards every declared holder method to a real bound method (no method left stubbed)", () => {
		const holder = createWsTransportHolderStubs();
		const { transport, calls } = makeSpyTransport();

		wireWsTransportHolder(holder, transport);

		// Invoke every method key on the holder; each must land on the spy.
		for (const key of Object.keys(holder) as Array<keyof typeof holder>) {
			(holder[key] as (...a: unknown[]) => unknown)("x");
		}

		const invoked = new Set(calls.map((c) => c.method));
		for (const key of Object.keys(holder)) {
			expect(invoked.has(key)).toBe(true);
		}
		expect(calls.every((c) => c.boundToInstance)).toBe(true);
	});

	it("throws at wiring time when a required method is left unwired", () => {
		const holder = createWsTransportHolderStubs();
		const { transport } = makeSpyTransport();
		// Simulate the historical bug: a required transport method missing from the
		// real instance means the holder keeps its pre-wiring stub after assign.
		const partial = { ...(transport as Record<string, unknown>) };
		partial.handleSpoolTransfer = undefined;

		expect(() => wireWsTransportHolder(holder, partial as never)).toThrow(/handleSpoolTransfer/);
	});
});

describe("createWsTransportHolderStubs — unwired mode", () => {
	it("defaults to throw mode: every stub logs an error and throws its method name", () => {
		const errors: Array<{ msg: string; meta: unknown }> = [];
		const logger = {
			error: (msg: string, meta?: unknown) => errors.push({ msg, meta }),
			warn: () => {},
			info: () => {},
			debug: () => {},
		} as unknown as import("@bound/shared").Logger;
		const holder = createWsTransportHolderStubs(logger);

		expect(() => holder.handleSpoolTransfer("site", {})).toThrow(/handleSpoolTransfer/);
		expect(errors.length).toBe(1);
		expect(errors[0].msg).toMatch(/before wiring/);
	});

	it("throw mode is explicit and matches the default", () => {
		const holder = createWsTransportHolderStubs(undefined, { unwired: "throw" });
		expect(() => holder.drainDurableWorkSpool("peer")).toThrow(/drainDurableWorkSpool/);
	});

	it("benign mode: void methods return undefined and never throw, logging once at debug", () => {
		const debugs: Array<{ msg: string; meta: unknown }> = [];
		const logger = {
			error: () => {
				throw new Error("benign stubs must not log at error level");
			},
			warn: () => {
				throw new Error("benign stubs must not log at warn level");
			},
			info: () => {},
			debug: (msg: string, meta?: unknown) => debugs.push({ msg, meta }),
		} as unknown as import("@bound/shared").Logger;
		const holder = createWsTransportHolderStubs(logger, { unwired: "benign" });

		expect(holder.handleSpoolTransfer("site", {})).toBeUndefined();
		expect(holder.drainDurableWorkSpool("peer")).toBeUndefined();
		expect(holder.addPeer("s", () => true, new Uint8Array())).toBeUndefined();
		expect(debugs.length).toBeGreaterThanOrEqual(1);
		expect(debugs.every((d) => d.msg.includes("single-host") || d.msg.includes("unwired"))).toBe(
			true,
		);
	});

	it("benign mode: requestConsistency resolves to an empty Map (preserves single-host route semantics)", async () => {
		const holder = createWsTransportHolderStubs(undefined, { unwired: "benign" });
		const result = await holder.requestConsistency(["messages"]);
		expect(result).toBeInstanceOf(Map);
		expect(result.size).toBe(0);
	});

	it("benign mode: applySnapshotChunk returns its numeric neutral (0)", () => {
		const holder = createWsTransportHolderStubs(undefined, { unwired: "benign" });
		expect(holder.applySnapshotChunk("messages", [])).toBe(0);
	});

	it("benign mode: still wireable — wiring replaces benign stubs with real bound methods", () => {
		const holder = createWsTransportHolderStubs(undefined, { unwired: "benign" });
		const { transport, calls } = makeSpyTransport();
		wireWsTransportHolder(holder, transport);
		holder.handleSpoolTransfer("hub-site", { entries: [] });
		expect(calls).toEqual([
			{ method: "handleSpoolTransfer", args: ["hub-site", { entries: [] }], boundToInstance: true },
		]);
	});
});
