/**
 * Wiring for the deferred `wsTransportHolder` on the sync server.
 *
 * The sync server needs a `wsTransport` object at construction time, but the
 * real `WsTransport` instance is only built later in the bootstrap sequence
 * (Phase 8, after sync init). To break that ordering cycle, the server is
 * handed a mutable *holder* seeded with placeholder methods, and the real
 * instance's methods are copied onto the holder once it exists.
 *
 * #253 spool-wedge root cause: the holder was seeded with silent `() => {}`
 * no-ops, and the hand-maintained copy list drifted from the holder interface —
 * it omitted `handleSpoolTransfer`, `handleSpoolTransferAck`, and
 * `drainDurableWorkSpool`. On the hub, inbound SPOOL_TRANSFER /
 * SPOOL_TRANSFER_ACK frames dispatched into those empty no-ops: no insert, no
 * ack, no log. TypeScript never flagged it because the no-op stubs make the
 * holder structurally complete — an incomplete copy list is not a type error.
 *
 * Two guardrails prevent that class of bug from silently recurring:
 *   1. Placeholder methods are NOT silent — each logs a structured error if
 *      invoked before wiring (a visible-at-runtime default beats an invisible
 *      no-op) AND carries a non-enumerable marker so the assertion can find it.
 *   2. `wireWsTransportHolder` asserts, after copying, that no holder method
 *      still points at a placeholder — a hub that cannot receive spool frames
 *      must fail loudly at startup rather than silently boot half-wired.
 */

import type { Logger } from "@bound/shared";
import type { WsTransport } from "@bound/sync";

export interface WsTransportHolder {
	addPeer: (
		siteId: string,
		sendFrame: (frame: Uint8Array) => boolean,
		symmetricKey: Uint8Array,
	) => void;
	removePeer: (siteId: string) => void;
	handleChangelogPush: (siteId: string, payload: Record<string, unknown>) => void;
	handleChangelogAck: (siteId: string, payload: Record<string, unknown>) => void;
	drainChangelog: (siteId: string) => void;
	handleRelaySend: (sourceSiteId: string, payload: Record<string, unknown>) => void;
	handleRelayAck: (sourceSiteId: string, payload: Record<string, unknown>) => void;
	handleSpoolTransfer: (sourceSiteId: string, payload: unknown) => void;
	handleSpoolTransferAck: (sourceSiteId: string, payload: unknown) => void;
	drainDurableWorkSpool: (siteId: string) => void;
	seedNewPeer: (siteId: string) => void;
	handleSnapshotAck: (siteId: string, payload: unknown) => void;
	continueSnapshotSeed: (siteId: string) => void;
	applySnapshotChunk: (tableName: string, rows: Array<Record<string, unknown>>) => number;
	handleReseedRequest: (siteId: string, payload: unknown) => void;
	handleConsistencyRequest: (siteId: string, payload: unknown) => void;
	requestConsistency: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>;
	handleRowPullRequest: (siteId: string, payload: unknown) => void;
	handleRowPullAck: (siteId: string, payload: unknown) => void;
	continueRowPull: (siteId: string) => void;
	continueConsistencyStream: (siteId: string) => void;
}

/**
 * Typed as the concrete class so `wsTransport[name]` in the wiring loop fails
 * typecheck when a holder method is renamed or removed on `WsTransport`. The
 * holder's payload params are widened to `unknown`, so `WsTransport` is not
 * structurally assignable to `WsTransportHolder`.
 */
export type WsTransportSource = WsTransport;

/**
 * Every holder method that MUST be wired before the node can correctly serve
 * its role. All spool / changelog / relay / snapshot / consistency handlers
 * count: a hub that leaves any of them at a placeholder silently drops the
 * corresponding frame family. This is the whole holder surface — there are no
 * genuinely-optional transport methods today, so the required set is exhaustive.
 */
const REQUIRED_HOLDER_METHODS: ReadonlyArray<keyof WsTransportHolder> = [
	"addPeer",
	"removePeer",
	"handleChangelogPush",
	"handleChangelogAck",
	"drainChangelog",
	"handleRelaySend",
	"handleRelayAck",
	"handleSpoolTransfer",
	"handleSpoolTransferAck",
	"drainDurableWorkSpool",
	"seedNewPeer",
	"handleSnapshotAck",
	"continueSnapshotSeed",
	"applySnapshotChunk",
	"handleReseedRequest",
	"handleConsistencyRequest",
	"requestConsistency",
	"handleRowPullRequest",
	"handleRowPullAck",
	"continueRowPull",
	"continueConsistencyStream",
];

/**
 * Non-enumerable marker property tagged onto every pre-wiring placeholder so
 * `wireWsTransportHolder` can detect a method left unwired after the copy,
 * regardless of the placeholder's call signature. Non-enumerable so it never
 * leaks into `Object.keys(holder)` iteration or serialization.
 */
const UNWIRED_STUB_MARKER = "__boundWsTransportUnwiredStub";

function isUnwiredStub(value: unknown): boolean {
	return (
		typeof value === "function" &&
		(value as unknown as Record<string, unknown>)[UNWIRED_STUB_MARKER] === true
	);
}

/**
 * How a not-yet-wired holder method should behave when invoked.
 *
 * - `"throw"` (default): the sync-server startup holder, which is wired moments
 *   later on any node that builds a `WsTransport`. On a hub/spoke a method still
 *   at a placeholder means the copy list drifted (the #253 wedge) or wiring was
 *   skipped — a real bug that must fail loudly rather than silently drop frames.
 * - `"benign"`: the single-host fallback holder (index.ts). With no sync config
 *   / no keyring peers, `initSync` returns `wsTransport: undefined` BY DESIGN and
 *   the holder is never wired — these stubs are live forever. They must preserve
 *   the pre-#253 semantics: log once at debug (normal operation, not an error)
 *   and return each signature's neutral value so reachable-in-single-host paths
 *   (notably `POST /consistency`, which presence-checks `requestConsistency` and
 *   expects an empty result, not a 500) keep working.
 */
export type UnwiredStubMode = "throw" | "benign";

/**
 * Build a throwing placeholder for a not-yet-wired holder method: it logs a
 * structured error when invoked (visible-at-runtime, unlike a silent no-op) and
 * carries the unwired marker so the post-wiring assertion can detect it.
 */
function makeUnwiredStub(
	name: keyof WsTransportHolder,
	logger?: Logger,
): (...args: never[]) => never {
	const stub = (..._args: never[]): never => {
		logger?.error("ws transport method called before wiring", { method: String(name) });
		throw new Error(`ws transport method called before wiring: ${String(name)}`);
	};
	Object.defineProperty(stub, UNWIRED_STUB_MARKER, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return stub;
}

/**
 * The neutral value each holder method returns in benign mode, read off the
 * real `WsTransport` return types. The single-host `POST /consistency` route
 * relies on `requestConsistency` resolving to an empty Map.
 */
function benignReturnValue(name: keyof WsTransportHolder): unknown {
	if (name === "requestConsistency") return Promise.resolve(new Map());
	if (name === "applySnapshotChunk") return 0;
	return undefined;
}

/**
 * Build a benign placeholder for a holder method that is unwired BY DESIGN
 * (single-host mode). Unlike the throwing stub it never throws and logs at debug
 * — this is normal operation, not a bug. It carries no unwired marker: a benign
 * holder is a legitimate terminal state, so the post-wiring assertion (which
 * runs only on the startup holder, and only after `wireWsTransportHolder`
 * replaces every method) never inspects it. Returns each method's neutral value.
 */
function makeBenignStub(
	name: keyof WsTransportHolder,
	logger?: Logger,
): (...args: never[]) => unknown {
	const neutral = benignReturnValue(name);
	return (..._args: never[]): unknown => {
		logger?.debug("ws transport method invoked on single-host (unwired) holder — no-op", {
			method: String(name),
		});
		return neutral;
	};
}

/**
 * Seed the deferred holder with placeholder methods. `mode` selects the
 * pre-wiring behavior (see `UnwiredStubMode`): `"throw"` (default) for the
 * sync-server startup holder that fails loudly if a frame arrives before wiring;
 * `"benign"` for the single-host fallback holder that stays unwired by design
 * and must preserve the old no-op/empty-Map semantics.
 */
export function createWsTransportHolderStubs(
	logger?: Logger,
	options?: { unwired?: UnwiredStubMode },
): WsTransportHolder {
	const mode = options?.unwired ?? "throw";
	const holder = {} as Record<keyof WsTransportHolder, unknown>;
	for (const name of REQUIRED_HOLDER_METHODS) {
		holder[name] = mode === "benign" ? makeBenignStub(name, logger) : makeUnwiredStub(name, logger);
	}
	return holder as unknown as WsTransportHolder;
}

/**
 * Copy every required method from the real `WsTransport` onto the deferred
 * holder, bound to the instance, then assert none is still a placeholder. A
 * hub that cannot receive a spool/changelog/relay/snapshot frame must not
 * silently boot.
 */
export function wireWsTransportHolder(
	holder: WsTransportHolder,
	wsTransport: WsTransportSource,
): void {
	const target = holder as Record<keyof WsTransportHolder, unknown>;
	for (const name of REQUIRED_HOLDER_METHODS) {
		const method: unknown = wsTransport[name];
		if (typeof method === "function") target[name] = method.bind(wsTransport);
	}

	const unwired = REQUIRED_HOLDER_METHODS.filter((name) => isUnwiredStub(target[name]));
	if (unwired.length > 0) {
		throw new Error(
			`ws transport holder left required methods unwired after wiring: ${unwired
				.map(String)
				.join(", ")}. The WsTransport instance does not implement them.`,
		);
	}
}
