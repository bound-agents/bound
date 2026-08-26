import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema, readUndelivered } from "@bound/core";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createRemotePlatformRequest } from "../commands/start/server.js";

describe("remote platform request trace carrier", () => {
	it("preserves the active carrier on the actual CLI result-envelope request", async () => {
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
		const db = new Database(":memory:");
		applySchema(db);
		const localSiteId = "local-site";
		const remoteSiteId = "remote-site";
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, platforms, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
			[remoteSiteId, "remote", JSON.stringify(["discord"]), now, now],
		);
		const request = createRemotePlatformRequest({
			db,
			siteId: localSiteId,
			eventBus: undefined,
		} as never);
		const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		let pending: Promise<unknown>;
		await context.with(
			trace.setSpanContext(context.active(), {
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
				traceFlags: 1,
				isRemote: false,
			}),
			async () => {
				pending = request("discord", "tools/call", { name: "discord_list_channels" });
			},
		);
		const outbox = readUndelivered(db)[0];
		expect(outbox?.trace_context).toBe(`{"traceparent":"${traceparent}"}`);
		db.run(
			"INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, payload, expires_at, received_at, processed) VALUES (?, ?, 'result', ?, ?, ?, ?, 0)",
			[
				"result",
				remoteSiteId,
				outbox?.id,
				JSON.stringify({
					stdout: JSON.stringify({ ok: true }),
					stderr: "",
					exit_code: 0,
					execution_ms: 1,
				}),
				now,
				now,
			],
		);
		const startedRequest = pending;
		if (!startedRequest) throw new Error("request did not start");
		expect(await startedRequest).toEqual({ ok: true });
		db.close();
	});
});
