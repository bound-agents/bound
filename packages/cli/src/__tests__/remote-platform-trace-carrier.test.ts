import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createRemotePlatformRequest } from "../commands/start/server.js";

/**
 * Objection 6 (#253) / #261 — remote-platform trace-carrier coverage, durable path.
 *
 * The producer (`createRemotePlatformRequest`) computes `traceContext:
 * serializeRelayTraceCarrier(injectRelayTraceCarrier())` and passes it to
 * `routeRelayRequest`, which now persists it onto the `durable_work.trace_context`
 * column (#261). The carrier survives the durable hop so the consumer's receive
 * span parents under the producer's request span.
 *
 * This test pins:
 *   1. the producer writes a well-formed `platform_request` durable row targeted at
 *      the fresh remote host, carrying the request payload;
 *   2. that row carries the serialized OTEL trace carrier in `trace_context`, equal
 *      to the traceparent for the active span context.
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

	it("stamps the active OTEL trace carrier onto the durable row's trace_context (#261)", async () => {
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

		const traceId = "0af7651916cd43dd8448eb211c80319c";
		const spanId = "b7ad6b7169203331";
		let pending: Promise<unknown> | undefined;
		await context.with(
			trace.setSpanContext(context.active(), {
				traceId,
				spanId,
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

		// The trace carrier now has a column to live on: assert it survives the
		// producer's insert, equal to the serialized W3C traceparent for the active span.
		const cols = db.query("PRAGMA table_info(durable_work)").all() as Array<{ name: string }>;
		expect(cols.some((c) => c.name === "trace_context")).toBe(true);
		const row = db
			.query(
				"SELECT trace_context FROM durable_work WHERE kind = 'platform_request' AND target_site_id = ?",
			)
			.get(remoteSiteId) as { trace_context: string | null } | null;
		expect(row?.trace_context).toBeTruthy();
		const carrier = JSON.parse(row?.trace_context ?? "{}") as { traceparent?: string };
		expect(carrier.traceparent).toBe(`00-${traceId}-${spanId}-01`);
	});
});
