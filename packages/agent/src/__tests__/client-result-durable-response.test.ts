import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	applySchema,
	dropLegacyRelayTables,
	insertDurableWork,
	readDurableResponseByRefId,
} from "@bound/core";
import type { AppContext } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import type { LLMBackend } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import type { Observable } from "rxjs";
import { Subject, firstValueFrom } from "rxjs";
import { BoundAgentLoop } from "../bound-agent-loop";
import { dispatchAwaitableClientTool } from "../client-tool-dispatch";

/**
 * Regression coverage for #260: the two client_result awaiters
 * (client-tool-dispatch.ts `waitForRemoteResult` and bound-agent-loop.ts
 * `createClientResultWait$`) polled ONLY legacy relay_inbox behind a
 * `!hasDroppedLegacyRelayTables` guard, so once slice 4E dropped the legacy
 * tables the read returned nothing and every remote client-tool call hung the
 * full relay timeout → dead_letter. The same defect class fixed for
 * remotePlatformRequest in 30bf4693. The awaiter must consume the durable
 * `client_result` response row targeted at self via the union await
 * (readDurableResponseByRefId + token-fenced claim → deliver → ack).
 *
 * Test shape mirrors packages/cli/src/__tests__/remote-platform-durable-response.test.ts:
 * capable-host seeding forces routeRelayRequest onto the durable path.
 */

let openDbs: Database[] = [];

afterEach(() => {
	for (const db of openDbs) {
		try {
			db.close();
		} catch {
			/* already closed */
		}
	}
	openDbs = [];
});

function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	openDbs.push(db);
	return db;
}

/** A remote host that holds the WS session AND advertises work_spool_capable. */
function seedCapableSessionHost(
	db: Database,
	opts: { remoteSiteId: string; threadId: string },
): void {
	const now = new Date().toISOString();
	db.run(
		"INSERT INTO hosts (site_id, host_name, platforms, work_spool_capable, online_at, modified_at, deleted) VALUES (?, ?, ?, 1, ?, ?, 0)",
		[opts.remoteSiteId, "remote", JSON.stringify([]), now, now],
	);
	db.run(
		"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
		[`sess-${opts.remoteSiteId}`, "conn-1", opts.threadId, opts.remoteSiteId, now, now],
	);
}

function deps(db: Database, opts: { siteId: string; threadId: string }) {
	return {
		db,
		eventBus: new TypedEventEmitter() as never,
		siteId: opts.siteId,
		threadId: opts.threadId,
		toolName: "client_read_file",
		args: { path: "/tmp/x" },
		// No connectionId → the remote-session (relay) branch is taken.
		timeoutMs: 2000,
	};
}

describe("client_result durable-response awaiting (client-tool-dispatch.ts)", () => {
	it("(a) resolves from a pending durable 'client_result' row when legacy tables are dropped — THE regression", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		const threadId = "thread-1";
		seedCapableSessionHost(db, { remoteSiteId, threadId });
		dropLegacyRelayTables(db, "test: post-4E drop");

		const pending = dispatchAwaitableClientTool(deps(db, { siteId: localSiteId, threadId }));
		await new Promise((r) => setTimeout(r, 20));

		// The routed request minted a durable client_tool row; find its id (= ref_id the awaiter watches).
		const durableReq = db
			.query("SELECT id FROM durable_work WHERE kind = 'client_tool' LIMIT 1")
			.get() as { id: string } | null;
		expect(durableReq).not.toBeNull();
		const refId = durableReq?.id as string;

		const durableId = `result-${refId}`;
		insertDurableWork(db, {
			id: durableId,
			target_site_id: localSiteId,
			kind: "client_result",
			payload: JSON.stringify({ call_id: "c1", content: "file contents", is_error: false }),
			idempotency_key: `response:${refId}`,
			ref_id: refId,
			source_site: remoteSiteId,
			expires_at: new Date(Date.now() + 300_000).toISOString(),
		});

		expect(await pending).toEqual({ content: "file contents", isError: false });

		// (c) exactly-once: the durable row is acked to 'consumed'.
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(durableId) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
		expect(readDurableResponseByRefId(db, refId, localSiteId)).toBeNull();
	});

	it("surfaces a durable 'error' response as an error result", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		const threadId = "thread-err";
		seedCapableSessionHost(db, { remoteSiteId, threadId });
		dropLegacyRelayTables(db, "test: post-4E drop");

		const pending = dispatchAwaitableClientTool(deps(db, { siteId: localSiteId, threadId }));
		await new Promise((r) => setTimeout(r, 20));

		const refId = (
			db.query("SELECT id FROM durable_work WHERE kind = 'client_tool' LIMIT 1").get() as {
				id: string;
			}
		).id;

		insertDurableWork(db, {
			id: `err-${refId}`,
			target_site_id: localSiteId,
			kind: "error",
			payload: JSON.stringify({ error: "client blew up", retriable: false }),
			idempotency_key: `response:${refId}`,
			ref_id: refId,
			source_site: remoteSiteId,
			expires_at: new Date(Date.now() + 300_000).toISOString(),
		});

		expect(await pending).toEqual({ content: "Error: client blew up", isError: true });
		const row = db
			.query("SELECT claim_state FROM durable_work WHERE id = ?")
			.get(`err-${refId}`) as { claim_state: string } | null;
		expect(row?.claim_state).toBe("consumed");
	});

	it("(d) still consumes from legacy relay_inbox when the tables are present (compat path)", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		const threadId = "thread-legacy";
		// legacy tables NOT dropped, and the session host does NOT advertise
		// work_spool_capable → routeRelayRequest falls back to legacy relay_outbox.
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, platforms, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			[remoteSiteId, "remote", JSON.stringify([]), now, now],
		);
		db.run(
			"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
			[`sess-${remoteSiteId}`, "conn-1", threadId, remoteSiteId, now, now],
		);

		const pending = dispatchAwaitableClientTool(deps(db, { siteId: localSiteId, threadId }));
		await new Promise((r) => setTimeout(r, 20));

		const outbox = db.query("SELECT id FROM relay_outbox LIMIT 1").get() as { id: string } | null;
		expect(outbox).not.toBeNull();
		const refId = outbox?.id as string;

		const now2 = new Date().toISOString();
		db.run(
			"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed) VALUES (?, ?, 'client_result', ?, ?, ?, ?, 0)",
			[
				"legacy-client-result",
				remoteSiteId,
				refId,
				JSON.stringify({ call_id: "c1", content: "legacy contents", is_error: false }),
				now2,
				now2,
			],
		);

		expect(await pending).toEqual({ content: "legacy contents", isError: false });
		const processed = db
			.query("SELECT processed FROM relay_inbox WHERE id = ?")
			.get("legacy-client-result") as { processed: number } | null;
		expect(processed?.processed).toBe(1);
	});

	it("(objection 1) SETTLES an unparseable durable 'client_result' row (consumes it) and resolves with a parse-error result promptly", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		const threadId = "thread-bad";
		seedCapableSessionHost(db, { remoteSiteId, threadId });
		dropLegacyRelayTables(db, "test: post-4E drop");

		// Long timeout: the parse-error result must arrive from the read, NOT from
		// the timeout path — a deterministically-unparseable payload is poison, so
		// the awaiter surfaces the error immediately rather than hanging.
		const pending = dispatchAwaitableClientTool({
			...deps(db, { siteId: localSiteId, threadId }),
			timeoutMs: 5000,
		});
		await new Promise((r) => setTimeout(r, 20));

		const refId = (
			db.query("SELECT id FROM durable_work WHERE kind = 'client_tool' LIMIT 1").get() as {
				id: string;
			}
		).id;

		const durableId = `result-${refId}`;
		insertDurableWork(db, {
			id: durableId,
			target_site_id: localSiteId,
			kind: "client_result",
			// Malformed: not the shape clientResultPayloadSchema expects.
			payload: JSON.stringify({ not_a: "client_result" }),
			idempotency_key: `response:${refId}`,
			ref_id: refId,
			source_site: remoteSiteId,
			expires_at: new Date(Date.now() + 300_000).toISOString(),
		});

		// Poison-not-transient: the row was delivered to its only consumer. Settle
		// it and surface a parse error immediately — matching awaitPlatformRequestResponse,
		// which settle()s then throws on a parse failure rather than leaving the row
		// claimed for a retry loop that can never succeed.
		const result = await pending;
		expect(result).toEqual({ content: "Error: malformed client_result payload", isError: true });

		// Exactly-once: the poison row is acked to 'consumed', not left claimed.
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(durableId) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
		expect(readDurableResponseByRefId(db, refId, localSiteId)).toBeNull();
	});
});

/**
 * OBJECTION 2 regression coverage for the RxJS awaiter — the OTHER migrated
 * site. All the dispatch-level tests above enter through
 * `dispatchAwaitableClientTool` → `waitForRemoteResult`; nothing there reaches
 * `BoundAgentLoop.createClientResultWait$`, which the reviewer flagged as the
 * risky uncovered awaiter. These tests reach it through the narrowest real
 * entry: a minimal `BoundAgentLoop` subclass that surfaces the private method
 * without stubbing its body, driving the exact production Observable
 * (readUnionResponseEntry union read + relay:inbox wakeups + timeout).
 */

// Enough of an LLMBackend to construct a ModelRouter; never invoked — the
// awaiter under test only touches ctx.db / ctx.eventBus / ctx.siteId.
const stubBackend = {
	chat: async function* () {
		yield { type: "done" as const, usage: null };
	},
	capabilities: () => ({
		streaming: true,
		tool_use: true,
		system_prompt: true,
		prompt_caching: false,
		vision: false,
		max_context: 8000,
	}),
} as unknown as LLMBackend;

/** Surfaces the private RxJS awaiter for real-path testing. */
class WaitProbeLoop extends BoundAgentLoop {
	public clientResultWait$(
		outboxEntryId: string,
		timeoutMs: number,
		aborted$: Observable<unknown>,
	): Observable<{ content: string; isError: boolean } | null> {
		return (
			this as unknown as {
				createClientResultWait$: (
					id: string,
					t: number,
					a: Observable<unknown>,
				) => Observable<{ content: string; isError: boolean } | null>;
			}
		).createClientResultWait$(outboxEntryId, timeoutMs, aborted$);
	}
}

function makeWaitProbeLoop(db: Database, siteId: string): WaitProbeLoop {
	const eventBus = new TypedEventEmitter();
	const ctx = {
		db,
		eventBus,
		siteId,
		hostName: "test-host",
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as AppContext;
	const router = new ModelRouter(new Map([["test-model", stubBackend]]), "test-model");
	return new WaitProbeLoop(
		ctx,
		{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
		router,
		{
			threadId: "thread-rxjs",
			userId: "user-1",
			modelId: "test-model",
		},
	);
}

/**
 * Seed a durable response row targeted at `siteId` for `refId`, exactly as the
 * remote session host's relayed `client_result`/`error` lands post-4E.
 */
function seedDurableResponse(
	db: Database,
	opts: {
		id: string;
		targetSiteId: string;
		sourceSiteId: string;
		refId: string;
		kind: string;
		payload: string;
	},
): void {
	insertDurableWork(db, {
		id: opts.id,
		target_site_id: opts.targetSiteId,
		kind: opts.kind,
		payload: opts.payload,
		idempotency_key: `response:${opts.refId}`,
		ref_id: opts.refId,
		source_site: opts.sourceSiteId,
		expires_at: new Date(Date.now() + 300_000).toISOString(),
	});
}

describe("client_result durable-response awaiting (bound-agent-loop.ts createClientResultWait$)", () => {
	it("(a) resolves the wait$ from a pending durable 'client_result' row targeted at self when legacy tables are dropped — THE regression", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		dropLegacyRelayTables(db, "test: post-4E drop");
		const loop = makeWaitProbeLoop(db, localSiteId);

		const refId = "rxjs-ref-a";
		const durableId = `result-${refId}`;
		seedDurableResponse(db, {
			id: durableId,
			targetSiteId: localSiteId,
			sourceSiteId: remoteSiteId,
			refId,
			kind: "client_result",
			payload: JSON.stringify({ call_id: "c1", content: "file contents", is_error: false }),
		});

		const resolved = await firstValueFrom(loop.clientResultWait$(refId, 2000, new Subject()), {
			defaultValue: null,
		});
		expect(resolved).toEqual({ content: "file contents", isError: false });

		// (c) exactly-once: the durable row is acked to 'consumed'.
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(durableId) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
		expect(readDurableResponseByRefId(db, refId, localSiteId)).toBeNull();
	});

	it("(b) propagates a durable 'error' response as the error outcome", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		dropLegacyRelayTables(db, "test: post-4E drop");
		const loop = makeWaitProbeLoop(db, localSiteId);

		const refId = "rxjs-ref-b";
		seedDurableResponse(db, {
			id: `err-${refId}`,
			targetSiteId: localSiteId,
			sourceSiteId: remoteSiteId,
			refId,
			kind: "error",
			payload: JSON.stringify({ error: "client blew up", retriable: false }),
		});

		const resolved = await firstValueFrom(loop.clientResultWait$(refId, 2000, new Subject()), {
			defaultValue: null,
		});
		expect(resolved).toEqual({ content: "Error: client blew up", isError: true });
		const row = db
			.query("SELECT claim_state FROM durable_work WHERE id = ?")
			.get(`err-${refId}`) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
	});

	it("(objection 1) SETTLES an unparseable durable 'client_result' row (consumes it); wait$ emits a parse-error outcome promptly instead of hanging", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		dropLegacyRelayTables(db, "test: post-4E drop");
		const loop = makeWaitProbeLoop(db, localSiteId);

		const refId = "rxjs-ref-d";
		const durableId = `result-${refId}`;
		seedDurableResponse(db, {
			id: durableId,
			targetSiteId: localSiteId,
			sourceSiteId: remoteSiteId,
			refId,
			kind: "client_result",
			// Malformed: not the shape clientResultPayloadSchema expects.
			payload: JSON.stringify({ not_a: "client_result" }),
		});

		// Long timeout: the parse-error outcome must arrive via the stream from the
		// initial read, NOT from the timeout path. Poison is settled + surfaced
		// immediately, mirroring awaitPlatformRequestResponse.
		const resolved = await firstValueFrom(loop.clientResultWait$(refId, 5000, new Subject()), {
			defaultValue: null,
		});
		expect(resolved).toEqual({
			content: "Error: malformed client_result payload",
			isError: true,
		});

		// Exactly-once: the poison row is acked to 'consumed', not left claimed.
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(durableId) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
	});

	it("(objection 2) resolves the wait$ via the relay:inbox WAKEUP path: subscribe first with no row, then insert + emit; row ends consumed", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		dropLegacyRelayTables(db, "test: post-4E drop");
		const loop = makeWaitProbeLoop(db, localSiteId);
		const eventBus = (loop as unknown as { ctx: { eventBus: TypedEventEmitter } }).ctx.eventBus;

		const refId = "rxjs-ref-wakeup";
		const durableId = `result-${refId}`;

		// Subscribe FIRST with NO row present. The initial `defer` read finds nothing
		// (returns null → filtered out), so the stream is genuinely parked on the
		// relay:inbox wakeup — not resolved by the initial read.
		const pending = firstValueFrom(loop.clientResultWait$(refId, 2000, new Subject()), {
			defaultValue: null,
		});

		// After the subscription is live, deliver the durable row and fire the wakeup.
		// Only the wakeup-triggered re-read can find it.
		await new Promise((r) => setTimeout(r, 30));
		seedDurableResponse(db, {
			id: durableId,
			targetSiteId: localSiteId,
			sourceSiteId: remoteSiteId,
			refId,
			kind: "client_result",
			payload: JSON.stringify({ call_id: "c1", content: "woke up", is_error: false }),
		});
		eventBus.emit("relay:inbox", { ref_id: refId, kind: "client_result" });

		expect(await pending).toEqual({ content: "woke up", isError: false });

		// Exactly-once: the durable row is acked to 'consumed' via the wakeup delivery.
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(durableId) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
		expect(readDurableResponseByRefId(db, refId, localSiteId)).toBeNull();
	});

	it("(objection 2b) a second relay:inbox wakeup after settlement is harmless: no double-settle, no throw, single consumed row", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		dropLegacyRelayTables(db, "test: post-4E drop");
		const loop = makeWaitProbeLoop(db, localSiteId);
		const eventBus = (loop as unknown as { ctx: { eventBus: TypedEventEmitter } }).ctx.eventBus;

		const refId = "rxjs-ref-race";
		const durableId = `result-${refId}`;

		// Subscribe first with no row; the initial read finds nothing and parks.
		const pending = firstValueFrom(loop.clientResultWait$(refId, 2000, new Subject()), {
			defaultValue: null,
		});
		await new Promise((r) => setTimeout(r, 30));

		// Deliver the row, then fire TWO wakeups. take(1) unsubscribes the event
		// listener the instant the first wakeup's synchronous re-read + settle emits,
		// so the second emit fires into a dead subscription and never performs a
		// competing read. This proves the post-settlement wakeup is inert: exactly
		// one settle wins, the row is consumed once, no double-settle and no throw.
		seedDurableResponse(db, {
			id: durableId,
			targetSiteId: localSiteId,
			sourceSiteId: remoteSiteId,
			refId,
			kind: "client_result",
			payload: JSON.stringify({ call_id: "c1", content: "raced contents", is_error: false }),
		});
		eventBus.emit("relay:inbox", { ref_id: refId, kind: "client_result" });
		eventBus.emit("relay:inbox", { ref_id: refId, kind: "client_result" });

		expect(await pending).toEqual({ content: "raced contents", isError: false });

		// Single row, consumed exactly once (no second consumed duplicate).
		const rows = db
			.query("SELECT claim_state FROM durable_work WHERE id = ?")
			.all(durableId) as Array<{ claim_state: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.claim_state).toBe("consumed");
	});
});
