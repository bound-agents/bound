// 4D-C producer flip: the routing helper decides durable-spool vs legacy-outbox
// per destination for active non-stream REQUEST kinds. Durable IFF the toggle is
// on AND every hop advertises work_spool_capable (final target + hub when this
// host is a spoke and the target is not the hub). See
// docs/design/specs/2026-08-31-durable-work-consolidation.md (R-DW5/6, R-DW14).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applySchema,
	claimLocalDurableWork,
	deadLetterExpiredDurableWork,
	setDurableRelayEnabledForTesting,
} from "@bound/core";
import { routeRelayRequest, routeRelayResponse, shouldRouteRelayDurable } from "../relay-router";

let db: Database;

/** Advertise (or retract) a host's work-spool capability in the local hosts table. */
function setHostCapability(siteId: string, capable: boolean): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO hosts (site_id, host_name, version, online_at, modified_at, work_spool_capable, deleted)
		 VALUES (?, ?, '0', ?, ?, ?, 0)
		 ON CONFLICT(site_id) DO UPDATE SET work_spool_capable = excluded.work_spool_capable, deleted = 0`,
		[siteId, siteId, now, now, capable ? 1 : 0],
	);
}

/** Seed the lone sync_state row so a spoke resolves its hub via getPeerSiteId. */
function seedHubPeer(hubSiteId: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO sync_state (peer_site_id, last_received, last_sent, last_sync_at, sync_errors)
		 VALUES (?, '', '', ?, 0)
		 ON CONFLICT(peer_site_id) DO NOTHING`,
		[hubSiteId, now],
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	setDurableRelayEnabledForTesting(true);
});

afterEach(() => {
	setDurableRelayEnabledForTesting(true);
	db.close();
});

describe("shouldRouteRelayDurable", () => {
	const LOCAL = "local-site";
	const TARGET = "target-site";
	const HUB = "hub-site";

	it("routes durable on a hub when the target advertises capability", () => {
		setHostCapability(TARGET, true);
		expect(
			shouldRouteRelayDurable(db, {
				targetSiteId: TARGET,
				localSiteId: LOCAL,
				topologyRole: "hub",
			}),
		).toBe(true);
	});

	it("routes legacy when the toggle is off, even if all hops are capable", () => {
		setDurableRelayEnabledForTesting(false);
		setHostCapability(TARGET, true);
		expect(
			shouldRouteRelayDurable(db, {
				targetSiteId: TARGET,
				localSiteId: LOCAL,
				topologyRole: "hub",
			}),
		).toBe(false);
	});

	it("routes legacy when the final target does not advertise capability", () => {
		setHostCapability(TARGET, false);
		expect(
			shouldRouteRelayDurable(db, {
				targetSiteId: TARGET,
				localSiteId: LOCAL,
				topologyRole: "hub",
			}),
		).toBe(false);
	});

	it("routes legacy for a self-targeted request (loopback stays unchanged)", () => {
		setHostCapability(LOCAL, true);
		expect(
			shouldRouteRelayDurable(db, {
				targetSiteId: LOCAL,
				localSiteId: LOCAL,
				topologyRole: "hub",
			}),
		).toBe(false);
	});

	describe("on a spoke", () => {
		it("routes durable when both the target and the hub advertise capability", () => {
			seedHubPeer(HUB);
			setHostCapability(TARGET, true);
			setHostCapability(HUB, true);
			expect(
				shouldRouteRelayDurable(db, {
					targetSiteId: TARGET,
					localSiteId: LOCAL,
					topologyRole: "spoke",
				}),
			).toBe(true);
		});

		it("routes legacy when the target is capable but the hub is not (never strand rows at a spoke)", () => {
			seedHubPeer(HUB);
			setHostCapability(TARGET, true);
			setHostCapability(HUB, false);
			expect(
				shouldRouteRelayDurable(db, {
					targetSiteId: TARGET,
					localSiteId: LOCAL,
					topologyRole: "spoke",
				}),
			).toBe(false);
		});

		it("does not require the hub hop when the target IS the hub", () => {
			seedHubPeer(HUB);
			setHostCapability(HUB, true);
			expect(
				shouldRouteRelayDurable(db, {
					targetSiteId: HUB,
					localSiteId: LOCAL,
					topologyRole: "spoke",
				}),
			).toBe(true);
		});

		it("routes legacy when the target is the hub but the hub is not capable", () => {
			seedHubPeer(HUB);
			setHostCapability(HUB, false);
			expect(
				shouldRouteRelayDurable(db, {
					targetSiteId: HUB,
					localSiteId: LOCAL,
					topologyRole: "spoke",
				}),
			).toBe(false);
		});
	});
});

describe("routeRelayRequest write behavior", () => {
	const LOCAL = "local-site";
	const TARGET = "target-site";

	function durableRows(): Array<Record<string, unknown>> {
		return db.query("SELECT * FROM durable_work").all() as Array<Record<string, unknown>>;
	}
	function outboxRows(): Array<Record<string, unknown>> {
		return db.query("SELECT * FROM relay_outbox").all() as Array<Record<string, unknown>>;
	}

	it("(b) toggle off writes a legacy relay_outbox row, no durable row", () => {
		setDurableRelayEnabledForTesting(false);
		setHostCapability(TARGET, true);
		const routed = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "tool_call",
			payload: JSON.stringify({ kind: "tool_call", toolName: "x", args: {} }),
			timeoutMs: 30_000,
			topologyRole: "hub",
		});
		expect(routed.path).toBe("legacy");
		expect(routed.inserted).toBe(true);
		expect(durableRows()).toHaveLength(0);
		expect(outboxRows()).toHaveLength(1);
		expect(outboxRows()[0].id).toBe(routed.id);
	});

	it("(a) toggle on + capable target writes a durable_work row, no outbox row", () => {
		setHostCapability(TARGET, true);
		const routed = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "tool_call",
			payload: JSON.stringify({ kind: "tool_call", toolName: "x", args: {} }),
			timeoutMs: 30_000,
			topologyRole: "hub",
		});
		expect(routed.path).toBe("durable");
		expect(routed.inserted).toBe(true);
		expect(outboxRows()).toHaveLength(0);
		const rows = durableRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(routed.id);
		expect(rows[0].target_site_id).toBe(TARGET);
		expect(rows[0].claim_state).toBe("pending");
	});

	it("(d) client_tool key rides verbatim on the durable row", () => {
		setHostCapability(TARGET, true);
		const key = "client-tool:thread-1:call-9";
		routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "client_tool",
			payload: JSON.stringify({ thread_id: "thread-1", call_id: "call-9" }),
			timeoutMs: 300_000,
			idempotencyKey: key,
			topologyRole: "hub",
		});
		expect(durableRows()[0].idempotency_key).toBe(key);
	});

	it("(d) client_tool key is byte-identical across the flip (durable vs legacy)", () => {
		const key = "client-tool:thread-1:call-9";
		const payload = JSON.stringify({ thread_id: "thread-1", call_id: "call-9" });
		setHostCapability(TARGET, true);
		const durable = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "client_tool",
			payload,
			timeoutMs: 300_000,
			idempotencyKey: key,
			topologyRole: "hub",
		});
		setDurableRelayEnabledForTesting(false);
		const legacy = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "client_tool",
			payload,
			timeoutMs: 300_000,
			idempotencyKey: key,
			topologyRole: "hub",
		});
		const durableKey = durableRows().find((r) => r.id === durable.id)?.idempotency_key;
		const legacyKey = outboxRows().find((r) => r.id === legacy.id)?.idempotency_key;
		expect(durableKey).toBe(key);
		expect(legacyKey).toBe(key);
	});

	it("(d) notify_wakeup null key falls back to the minted row id", () => {
		setHostCapability(TARGET, true);
		const routed = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "notify_wakeup",
			payload: JSON.stringify({ thread_id: "t" }),
			timeoutMs: 300_000,
			topologyRole: "hub",
		});
		// Null legacy key => the durable row's own id is its deterministic key.
		expect(durableRows()[0].idempotency_key).toBe(routed.id);
	});

	it("(e) an expired durable request is dead-lettered and never claimed for dispatch", () => {
		setHostCapability(TARGET, true);
		const routed = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "tool_call",
			payload: JSON.stringify({ kind: "tool_call", toolName: "x", args: {} }),
			timeoutMs: 300_000,
			topologyRole: "hub",
		});
		expect(routed.path).toBe("durable");
		// The request rode the registry-clamped RPC TTL, so it is not born expired
		// (#253 TTL reconciliation). Age it past its terminal deadline to exercise the
		// expiry path: dead-letter it, and confirm the 4D-A claim lane skips it.
		db.run("UPDATE durable_work SET expires_at = ? WHERE id = ?", [
			new Date(Date.now() - 1000).toISOString(),
			routed.id,
		]);
		const dead = deadLetterExpiredDurableWork(db);
		expect(dead).toBe(1);
		expect(durableRows()[0].claim_state).toBe("dead_letter");
		// The 4D-A claim lane must NOT pick up a dead-lettered row.
		expect(claimLocalDurableWork(db, TARGET, "tool_call")).toBeNull();
	});

	// TTL reconciliation (#253): the durable-work registry declares the RPC-class
	// TTL (RPC_REQUEST_TTL_MS = 300s) as the intended expiry for request kinds
	// (durable-work-registry.ts: "carry an RPC-class TTL so the expiry sweep
	// dead-letters a stale request"). But callers pass a raw request timeoutMs — a
	// platform request rides a short client-tool timeout (~15s). A 15s terminal TTL
	// under the 30s transfer window is self-defeating: the row is terminally expired
	// before it is transfer-stale, so no transfer retry can ever fire (the live
	// incident). Clamp expires_at UP to at least the registry ttlMs so the terminal
	// deadline always sits well beyond the transfer window (R-DW10/11/12).
	it("(f) clamps a short request timeout up to the registry RPC-class TTL", () => {
		setHostCapability(TARGET, true);
		const before = Date.now();
		const routed = routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "tool_call",
			payload: JSON.stringify({ kind: "tool_call", toolName: "x", args: {} }),
			timeoutMs: 15_000, // shorter than the 300s registry TTL and the 30s transfer window
			topologyRole: "hub",
		});
		expect(routed.path).toBe("durable");
		const expiresAt = Date.parse(durableRows()[0].expires_at as string);
		// At least the 300s registry TTL beyond the write instant — never the 15s the
		// caller passed. Generous lower bound accounts for test execution slack.
		expect(expiresAt - before).toBeGreaterThanOrEqual(4 * 60 * 1000);
	});

	// A caller timeout LONGER than the registry TTL is honored as-is — the clamp is a
	// floor, not a ceiling. A caller that wants a longer live window keeps it.
	it("(f) leaves a request timeout longer than the registry TTL untouched", () => {
		setHostCapability(TARGET, true);
		const before = Date.now();
		routeRelayRequest(db, {
			targetSiteId: TARGET,
			sourceSiteId: LOCAL,
			kind: "tool_call",
			payload: JSON.stringify({ kind: "tool_call", toolName: "x", args: {} }),
			timeoutMs: 20 * 60 * 1000, // 20min, well over the 300s floor
			topologyRole: "hub",
		});
		const expiresAt = Date.parse(durableRows()[0].expires_at as string);
		expect(expiresAt - before).toBeGreaterThanOrEqual(19 * 60 * 1000);
	});
});

describe("routeRelayResponse write behavior", () => {
	const LOCAL = "responder-site";
	const REQUESTER = "requester-site";

	function durableRows(): Array<Record<string, unknown>> {
		return db.query("SELECT * FROM durable_work").all() as Array<Record<string, unknown>>;
	}
	function outboxRows(): Array<Record<string, unknown>> {
		return db.query("SELECT * FROM relay_outbox").all() as Array<Record<string, unknown>>;
	}

	it("(a) toggle on + capable requester writes a durable response row keyed response:<refId>", () => {
		setHostCapability(REQUESTER, true);
		const routed = routeRelayResponse(db, {
			targetSiteId: REQUESTER,
			sourceSiteId: LOCAL,
			kind: "result",
			payload: JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }),
			timeoutMs: 300_000,
			refId: "req-abc",
			idempotencyKey: "response:req-abc",
			topologyRole: "hub",
		});
		expect(routed.path).toBe("durable");
		expect(routed.inserted).toBe(true);
		expect(outboxRows()).toHaveLength(0);
		const rows = durableRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].target_site_id).toBe(REQUESTER);
		expect(rows[0].ref_id).toBe("req-abc");
		expect(rows[0].idempotency_key).toBe("response:req-abc");
		expect(rows[0].kind).toBe("result");
	});

	it("(e) toggle off writes a legacy relay_outbox response row with a null idempotency_key", () => {
		setDurableRelayEnabledForTesting(false);
		setHostCapability(REQUESTER, true);
		const routed = routeRelayResponse(db, {
			targetSiteId: REQUESTER,
			sourceSiteId: LOCAL,
			kind: "result",
			payload: JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }),
			timeoutMs: 300_000,
			refId: "req-abc",
			idempotencyKey: "response:req-abc",
			topologyRole: "hub",
		});
		expect(routed.path).toBe("legacy");
		expect(durableRows()).toHaveLength(0);
		const rows = outboxRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].ref_id).toBe("req-abc");
		expect(rows[0].idempotency_key).toBeNull();
	});

	it("(a) a redelivered response transfer is fenced by (kind, idempotency_key)", () => {
		setHostCapability(REQUESTER, true);
		const params = {
			targetSiteId: REQUESTER,
			sourceSiteId: LOCAL,
			kind: "result" as const,
			payload: JSON.stringify({ stdout: "ok", stderr: "", exit_code: 0 }),
			timeoutMs: 300_000,
			refId: "req-abc",
			idempotencyKey: "response:req-abc",
			topologyRole: "hub" as const,
		};
		const first = routeRelayResponse(db, params);
		const second = routeRelayResponse(db, params);
		expect(first.inserted).toBe(true);
		expect(second.inserted).toBe(false); // fence held — no second row
		expect(durableRows()).toHaveLength(1);
	});

	it("stream chunk keys are seq-scoped so distinct seqs coexist but a redelivered seq is fenced", () => {
		setHostCapability(REQUESTER, true);
		const chunk = (seq: number) =>
			routeRelayResponse(db, {
				targetSiteId: REQUESTER,
				sourceSiteId: LOCAL,
				kind: "stream_chunk",
				payload: JSON.stringify({ chunks: [], seq }),
				timeoutMs: 300_000,
				refId: "req-abc",
				idempotencyKey: `stream:stream-1:${seq}`,
				streamId: "stream-1",
				topologyRole: "hub",
			});
		chunk(0);
		chunk(1);
		expect(chunk(0).inserted).toBe(false); // redelivered seq 0 fenced
		expect(durableRows()).toHaveLength(2);
	});
});
