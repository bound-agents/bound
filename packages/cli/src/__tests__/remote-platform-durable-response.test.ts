import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	applySchema,
	dropLegacyRelayTables,
	insertDurableWork,
	readDurableResponseByRefId,
	readUndelivered,
} from "@bound/core";
import { createRemotePlatformRequest } from "../commands/start/server.js";

/**
 * Regression coverage for the last #253 defect: the two remotePlatformRequest
 * awaiters (scheduler.ts + server.ts) polled ONLY legacy relay_inbox and were
 * gated on `!hasDroppedLegacyRelayTables(db)`, so once slice 4E dropped the
 * legacy tables the poll loop body never ran and every platform_request hung
 * 15s → "Timeout waiting for platform_request response". Responses arrive on
 * the requesting spoke as pending durable_work rows targeted at self; the
 * awaiter must consume them via the union await (readDurableResponseByRefId +
 * token-fenced claim → deliver → ack).
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

function seedFreshRemoteHost(db: Database, remoteSiteId: string): void {
	const now = new Date().toISOString();
	db.run(
		"INSERT INTO hosts (site_id, host_name, platforms, work_spool_capable, online_at, modified_at, deleted) VALUES (?, ?, ?, 1, ?, ?, 0)",
		[remoteSiteId, "remote", JSON.stringify(["discord"]), now, now],
	);
}

function insertDurableResult(
	db: Database,
	opts: { refId: string; targetSiteId: string; sourceSite: string; stdout: string },
): string {
	const id = `result-${opts.refId}`;
	insertDurableWork(db, {
		id,
		target_site_id: opts.targetSiteId,
		kind: "result",
		payload: JSON.stringify({
			stdout: opts.stdout,
			stderr: "",
			exit_code: 0,
			execution_ms: 1,
		}),
		idempotency_key: `response:${opts.refId}`,
		ref_id: opts.refId,
		source_site: opts.sourceSite,
		expires_at: new Date(Date.now() + 300_000).toISOString(),
	});
	return id;
}

describe("remotePlatformRequest durable-response awaiting (server.ts)", () => {
	it("(a) resolves from a pending durable 'result' row when legacy tables are dropped — THE regression", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		seedFreshRemoteHost(db, remoteSiteId);
		dropLegacyRelayTables(db, "test: post-4E drop");

		const request = createRemotePlatformRequest({
			db,
			siteId: localSiteId,
			eventBus: undefined,
			optionalConfig: undefined,
		} as never);

		const pending = request("discord", "tools/call", { name: "discord_list_channels" });
		await new Promise((r) => setTimeout(r, 20));

		// The routed request minted a durable row targeted at the remote; find its id.
		const durableReq = db
			.query("SELECT id FROM durable_work WHERE kind = 'platform_request' LIMIT 1")
			.get() as { id: string } | null;
		expect(durableReq).not.toBeNull();
		const refId = durableReq?.id as string;

		const durableId = insertDurableResult(db, {
			refId,
			targetSiteId: localSiteId,
			sourceSite: remoteSiteId,
			stdout: JSON.stringify({ ok: true }),
		});

		expect(await pending).toEqual({ ok: true });

		// (d) exactly-once: the durable row is acked to 'consumed'.
		const row = db.query("SELECT claim_state FROM durable_work WHERE id = ?").get(durableId) as {
			claim_state: string;
		} | null;
		expect(row?.claim_state).toBe("consumed");
		expect(readDurableResponseByRefId(db, refId, localSiteId)).toBeNull();
	});

	it("(b) rejects with the error payload when a durable 'error' row arrives", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		seedFreshRemoteHost(db, remoteSiteId);
		dropLegacyRelayTables(db, "test: post-4E drop");

		const request = createRemotePlatformRequest({
			db,
			siteId: localSiteId,
			eventBus: undefined,
			optionalConfig: undefined,
		} as never);

		const pending = request("discord", "tools/call", { name: "discord_list_channels" });
		await new Promise((r) => setTimeout(r, 20));

		const refId = (
			db.query("SELECT id FROM durable_work WHERE kind = 'platform_request' LIMIT 1").get() as {
				id: string;
			}
		).id;

		insertDurableWork(db, {
			id: `err-${refId}`,
			target_site_id: localSiteId,
			kind: "error",
			payload: JSON.stringify({ error: "remote blew up", retriable: false }),
			idempotency_key: `response:${refId}`,
			ref_id: refId,
			source_site: remoteSiteId,
			expires_at: new Date(Date.now() + 300_000).toISOString(),
		});

		await expect(pending).rejects.toThrow("remote blew up");
		const row = db
			.query("SELECT claim_state FROM durable_work WHERE id = ?")
			.get(`err-${refId}`) as { claim_state: string } | null;
		expect(row?.claim_state).toBe("consumed");
	});

	it("(c) still consumes from legacy relay_inbox when the tables are present (compat path)", async () => {
		const db = makeDb();
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		// legacy tables NOT dropped, and the remote host does NOT advertise
		// work_spool_capable, so routeRelayRequest falls back to the legacy
		// relay_outbox path (the pre-4E compat condition).
		const now0 = new Date().toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, platforms, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			[remoteSiteId, "remote", JSON.stringify(["discord"]), now0, now0],
		);

		const request = createRemotePlatformRequest({
			db,
			siteId: localSiteId,
			eventBus: undefined,
			optionalConfig: undefined,
		} as never);

		const pending = request("discord", "tools/call", { name: "discord_list_channels" });
		await new Promise((r) => setTimeout(r, 20));

		const outbox = readUndelivered(db)[0];
		expect(outbox).toBeDefined();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed) VALUES (?, ?, 'result', ?, ?, ?, ?, 0)",
			[
				"legacy-result",
				remoteSiteId,
				outbox?.id,
				JSON.stringify({
					stdout: JSON.stringify({ ok: "legacy" }),
					stderr: "",
					exit_code: 0,
					execution_ms: 1,
				}),
				now,
				now,
			],
		);

		expect(await pending).toEqual({ ok: "legacy" });
		const processed = db
			.query("SELECT processed FROM relay_inbox WHERE id = ?")
			.get("legacy-result") as { processed: number } | null;
		expect(processed?.processed).toBe(1);
	});
});
