/**
 * Targeted coverage for `initScheduler`'s connector-tool `remotePlatformRequest`
 * closure (scheduler.ts 67-131, exercising 73-118). The fully-configured boot
 * fixture builds a PlatformMcpRegistry with ZERO connectors, so the connector
 * tool never routes a remote request; this test drives that closure directly.
 *
 * `initScheduler` now returns the connector tool it built (SchedulerResult.
 * connectorTool — a behavior-neutral addition read by no production caller), so
 * the test invokes the REAL closure rather than reconstructing it. The
 * connector tool's `channels` action is the only action that calls
 * `remotePlatformRequest`, and it is exercised against:
 *
 *   1. a FRESH remote host row advertising the platform → findFreshPlatformHost
 *      returns a target, routeRelayRequest mints a durable platform_request row,
 *      and the closure awaits a response. We satisfy the real awaiter by writing
 *      the matching durable response row, so awaitPlatformRequestResponse
 *      resolves end to end (73-118); and
 *   2. NO fresh host → findFreshPlatformHost returns null → the closure throws
 *      the "no fresh remote host" error (83-87), surfaced by the tool as an
 *      error string.
 *
 * Built on a real AppContext + DB and the real relay/awaiter helpers — no
 * stubbed router that echoes its input.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, MainAgentLoop } from "@bound/agent";
import { type AppContext, createAppContext, insertDurableWork, insertRow } from "@bound/core";
import { PlatformMcpRegistry, type PlatformRegisteredTool } from "@bound/platforms";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runInit } from "../../init.js";
import { initScheduler } from "../scheduler.js";

const PLATFORM = "discord";
const REMOTE_SITE = "remote-platform-host";

/** A no-op agent-loop factory: the scheduler needs one but we never run a task. */
const agentLoopFactory = (_config: AgentLoopConfig): MainAgentLoop =>
	({}) as unknown as MainAgentLoop;

describe("initScheduler — connector tool remotePlatformRequest", () => {
	let tempDir: string;
	let configDir: string;
	let appContext: AppContext;
	let registry: PlatformMcpRegistry;
	let schedulerHandle: { stop: () => void } | null = null;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-sched-remote-"));
		configDir = join(tempDir, "config");
		await runInit({ ollama: true, name: "sched-remote-operator", configDir });
		appContext = await createAppContext(configDir, ":memory:");
		registry = new PlatformMcpRegistry({
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			pollIntervalSeconds: 0,
		});
	});

	afterEach(async () => {
		schedulerHandle?.stop();
		schedulerHandle = null;
		await cleanupTmpDir(tempDir);
	});

	/** Boot the real scheduler and return the connector tool it wired. */
	function bootAndGetConnectorTool(): PlatformRegisteredTool {
		const result = initScheduler(
			appContext,
			agentLoopFactory,
			null, // no model router — scheduler still wires the connector tool
			{ bash: undefined },
			registry,
		);
		schedulerHandle = result.schedulerHandle;
		if (!result.connectorTool) throw new Error("connector tool not wired by initScheduler");
		return result.connectorTool;
	}

	it("throws 'no fresh remote host' when no peer advertises the platform (83-87)", async () => {
		const connector = bootAndGetConnectorTool();
		expect(connector.execute).toBeDefined();
		// channels → remotePlatformRequest → findFreshPlatformHost returns null, so
		// the closure throws. The connector tool's execute does not wrap handler
		// throws, so the rejection propagates to the caller (the loop surfaces it as
		// a tool error) — assert the rejection carries the specific cause.
		let rejected: Error | null = null;
		try {
			await connector.execute?.({ action: "channels", server_name: PLATFORM });
		} catch (err) {
			rejected = err as Error;
		}
		expect(rejected).toBeInstanceOf(Error);
		expect(rejected?.message).toContain("No fresh remote host found");
		expect(rejected?.message).toContain(PLATFORM);
	});

	it("routes a durable platform_request and resolves the awaited response (73-118)", async () => {
		// Seed a FRESH remote host advertising the platform so findFreshPlatformHost
		// selects it (modified_at is well within the 5-minute stale threshold).
		const now = new Date().toISOString();
		insertRow(
			appContext.db,
			"hosts",
			{
				site_id: REMOTE_SITE,
				host_name: "remote",
				platforms: JSON.stringify([PLATFORM]),
				work_spool_capable: 1,
				online_at: now,
				modified_at: now,
			},
			appContext.siteId,
		);

		const connector = bootAndGetConnectorTool();

		// The closure polls awaitPlatformRequestResponse against the durable row it
		// minted. Fulfil it concurrently: find the minted request row, then write
		// the matching durable `result` response so the real awaiter resolves. The
		// awaiter parses the payload through resultPayloadSchema and returns
		// JSON.parse(stdout), so stdout carries the events-list JSON.
		const eventsPayload = { events: [{ name: "message.received", description: "a message" }] };
		const responder = (async () => {
			const reqId = await waitForPlatformRequestRow();
			insertDurableWork(appContext.db, {
				id: crypto.randomUUID(),
				target_site_id: appContext.siteId,
				kind: "result",
				payload: JSON.stringify({
					stdout: JSON.stringify(eventsPayload),
					stderr: "",
					exit_code: 0,
					execution_ms: 1,
				}),
				idempotency_key: `response:${reqId}`,
				ref_id: reqId,
				source_site: REMOTE_SITE,
			});
		})();

		const out = await connector.execute?.({ action: "channels", server_name: PLATFORM });
		await responder;

		// handleChannels annotates each event with its existing bindings and
		// JSON-stringifies the result; the event name from the awaited remote
		// response must appear and the output must be valid JSON.
		expect(out).toContain("message.received");
		expect(() => JSON.parse(out as string)).not.toThrow();
		const parsed = JSON.parse(out as string) as Array<{ name: string; bindings: unknown[] }>;
		expect(parsed[0]?.name).toBe("message.received");
		expect(parsed[0]?.bindings).toEqual([]);
	});

	/** Poll the durable_work table for the platform_request row the closure minted. */
	async function waitForPlatformRequestRow(): Promise<string> {
		for (let i = 0; i < 400; i++) {
			const row = appContext.db
				.query(
					"SELECT id, payload FROM durable_work WHERE kind = 'platform_request' ORDER BY created_at DESC LIMIT 1",
				)
				.get() as { id: string; payload: string } | null;
			if (row) {
				const parsed = JSON.parse(row.payload) as { server_name?: string };
				if (parsed.server_name === PLATFORM) return row.id;
			}
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error("platform_request durable row was never minted");
	}
});

describe("initScheduler — seed arms and scheduler-start failure handling", () => {
	let tempDir: string;
	let configDir: string;
	let appContext: AppContext;
	let schedulerHandle: { stop: () => void } | null = null;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-sched-seed-"));
		configDir = join(tempDir, "config");
		await runInit({ ollama: true, name: "sched-seed-operator", configDir });
		appContext = await createAppContext(configDir, ":memory:");
	});

	afterEach(async () => {
		schedulerHandle?.stop();
		schedulerHandle = null;
		await cleanupTmpDir(tempDir);
	});

	it("seeds the heartbeat and consolidation cron tasks on a healthy boot (52-67)", () => {
		// No model router here: the seed arms (52-67) and the scheduler start run
		// identically with or without a router, and the connector-tool path is
		// covered by the describe block above.
		const result = initScheduler(appContext, agentLoopFactory, null, { bash: undefined }, null);
		schedulerHandle = result.schedulerHandle;
		expect(result.schedulerHandle).not.toBeNull();
		// Both seed calls ran — the heartbeat + consolidation task rows prove the
		// happy path of 52-67 (seedHeartbeat writes type='heartbeat',
		// seedConsolidation writes type='consolidation').
		const seeded = appContext.db
			.query("SELECT COUNT(*) AS c FROM tasks WHERE type IN ('heartbeat', 'consolidation')")
			.get() as { c: number };
		expect(seeded.c).toBe(2);
	});

	it("logs and continues when seeding throws against a closed DB (54-56, 63-65)", () => {
		// Close the DB so seedHeartbeat / seedConsolidation each throw inside their
		// guarded try blocks; initScheduler must swallow every one and still return
		// (never throw out of the composition root). scheduler.start() does not touch
		// the closed DB synchronously (its DB work runs inside interval callbacks
		// that self-stop on a closed DB), so a handle is still produced.
		appContext.db.close();
		let threw = false;
		let result: ReturnType<typeof initScheduler> | null = null;
		try {
			result = initScheduler(appContext, agentLoopFactory, null, { bash: undefined }, null);
		} catch {
			threw = true;
		}
		schedulerHandle = result?.schedulerHandle ?? null;
		expect(threw).toBe(false);
		expect(result).not.toBeNull();
	});
});
