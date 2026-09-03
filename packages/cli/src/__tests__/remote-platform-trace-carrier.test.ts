import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createRemotePlatformRequest } from "../commands/start/server.js";

/**
 * Objection 6 (#253) — remote-platform trace-carrier coverage, durable rewrite.
 *
 * The original test (deleted in the demolition) asserted the producer stamped the
 * active OTEL trace carrier into the `relay_outbox.trace_context` column and that the
 * awaiter resolved from a seeded `relay_inbox` `result` row. Both stores are gone; the
 * producer now writes a peer-targeted `durable_work` row via `routeRelayRequest`.
 *
 * FINDING (severity upgrade, see 253-o6-trace-carrier-finding.md): the demolition lost
 * trace-carrier carriage AT THE PRODUCER, not merely on the processing path.
 * `createRemotePlatformRequest` still computes `traceContext:
 * serializeRelayTraceCarrier(injectRelayTraceCarrier())` and passes it to
 * `routeRelayRequest`, but `routeRelayRequest`'s `insertDurableWork` call never
 * references `params.traceContext`, `NewDurableWork` has no `trace_context` field, and
 * the `durable_work` table has no `trace_context` column. So the carrier is silently
 * discarded for every durable relay request and response.
 *
 * This test therefore pins two things:
 *   1. what DOES survive — the producer writes a well-formed `platform_request` durable
 *      row targeted at the fresh remote host, carrying the request payload (GREEN);
 *   2. the regression — that row carries NO trace carrier (there is nowhere on the row
 *      to hold one). When the fix lands (add a `trace_context` column + thread it
 *      through), the second assertion flips and this test must be updated to assert the
 *      carrier survives instead.
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

/** A fresh, spool-capable remote host advertising the platform. */
function seedFreshRemoteHost(db: Database, remoteSiteId: string, platform: string): void {
	const now = new Date().toISOString();
	db.run(
		"INSERT INTO hosts (site_id, host_name, platforms, work_spool_capable, online_at, modified_at, deleted) VALUES (?, ?, ?, 1, ?, ?, 0)",
		[remoteSiteId, "remote", JSON.stringify([platform]), now, now],
	);
}

/** Find the single peer-targeted platform_request durable_work row the producer wrote. */
function findPlatformRequestRow(db: Database, targetSiteId: string) {
	return db
		.query("SELECT * FROM durable_work WHERE kind = 'platform_request' AND target_site_id = ?")
		.get(targetSiteId) as {
		id: string;
		kind: string;
		payload: string;
		source_site: string | null;
	} | null;
}

/**
 * Settle the producer's awaiter so no poll outlives the test DB (Objection 4, #253).
 * The awaiter (`awaitPlatformRequestResponse` → `readDurableResponseByRefId`) resolves
 * on a `pending` durable `result` row targeted at the local site with `ref_id` = the
 * request row id. Writing one lets `request()` return promptly instead of polling to its
 * 15s deadline and touching a closed database in `afterEach`.
 */
function settleAwaiter(db: Database, localSiteId: string, refId: string): void {
	if (!refId) return;
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO durable_work (id, target_site_id, kind, ref_id, idempotency_key, payload, claim_state, attempt_count, created_at, expires_at, source_site, received_at)
		 VALUES (?, ?, 'result', ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
		[
			crypto.randomUUID(),
			localSiteId,
			refId,
			`response:${refId}`,
			JSON.stringify({ stdout: JSON.stringify({ ok: true }), stderr: "", exit_code: 0 }),
			now,
			new Date(Date.now() + 60_000).toISOString(),
			"remote-site",
			now,
		],
	);
}

describe("remote platform request trace carrier (durable)", () => {
	it("stamps the request payload onto a peer-targeted platform_request durable row", async () => {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		seedFreshRemoteHost(db, remoteSiteId, "discord");

		const request = createRemotePlatformRequest({
			db,
			siteId: localSiteId,
			eventBus: undefined,
			optionalConfig: undefined,
		} as never);

		// Drive the producer under an active span context so a carrier WOULD be injected
		// if the producer persisted one. Capture the awaiter promise and settle it before
		// teardown (Objection 4, #253): the request() awaiter polls the durable spool until
		// its deadline, so a `void`ed promise keeps polling past afterEach and throws
		// "Cannot use a closed database" in the full-suite run. We seed a resolving durable
		// `result` row keyed to the request's ref_id, then await the promise so no poll
		// outlives the DB.
		let pending: Promise<unknown> | undefined;
		await context.with(
			trace.setSpanContext(context.active(), {
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				traceFlags: 1,
				isRemote: false,
			}),
			async () => {
				pending = request("discord", "tools/call", { name: "discord_list_channels" }).catch(
					() => undefined,
				);
				// Yield so the synchronous routeRelayRequest insert has run.
				await Promise.resolve();
			},
		);
		const requestRow = findPlatformRequestRow(db, remoteSiteId);
		settleAwaiter(db, localSiteId, requestRow?.id ?? "");
		await pending;

		const row = findPlatformRequestRow(db, remoteSiteId);
		expect(row).not.toBeNull();
		expect(row?.kind).toBe("platform_request");
		expect(row?.source_site).toBe(localSiteId);
		const payload = JSON.parse(row?.payload ?? "{}") as {
			server_name: string;
			method: string;
			params: Record<string, unknown>;
		};
		expect(payload.server_name).toBe("discord");
		expect(payload.method).toBe("tools/call");
		expect(payload.params).toEqual({ name: "discord_list_channels" });
	});

	it("FINDING: the durable row carries NO trace carrier (producer-level loss, #253 follow-up)", async () => {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		seedFreshRemoteHost(db, remoteSiteId, "discord");

		const request = createRemotePlatformRequest({
			db,
			siteId: localSiteId,
			eventBus: undefined,
			optionalConfig: undefined,
		} as never);

		let pending: Promise<unknown> | undefined;
		await context.with(
			trace.setSpanContext(context.active(), {
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				traceFlags: 1,
				isRemote: false,
			}),
			async () => {
				pending = request("discord", "tools/call", { name: "discord_list_channels" }).catch(
					() => undefined,
				);
				await Promise.resolve();
			},
		);
		// Settle the awaiter before teardown (Objection 4, #253) so no poll outlives the DB.
		const requestRow = findPlatformRequestRow(db, remoteSiteId);
		settleAwaiter(db, localSiteId, requestRow?.id ?? "");
		await pending;

		// The durable_work row physically cannot carry a trace carrier: there is no
		// trace_context column, and routeRelayRequest discards params.traceContext.
		// Assert the regression explicitly so a fix (add the column, thread it through,
		// read it in processPendingDurableWork's entry build) flips this test red and
		// forces it to be rewritten to assert survival.
		const cols = db.query("PRAGMA table_info(durable_work)").all() as Array<{ name: string }>;
		expect(cols.some((c) => c.name === "trace_context")).toBe(false);
	});
});
