import { createRelayOutboxEntry } from "@bound/agent";
import {
	cancelClientToolCalls,
	compareAllTables,
	countUnsyncableLocalOnly,
	getPendingClientToolCalls,
	getSiteId,
	insertRow,
	writeOutbox,
} from "@bound/core";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	type TypedEventEmitter,
	createLogger,
	hostModelsSchema,
	parseJsonSafe,
} from "@bound/shared";
import { Hono } from "hono";

export interface ModelInfo {
	id: string;
	provider: string;
}

export interface ClusterModelInfo {
	id: string;
	provider: string;
	host: string;
	via: "local" | "relay";
	status: "local" | "online" | "offline?";
}

export interface ModelsConfig {
	models: ModelInfo[];
	default: string;
}

export function createStatusRoutes(
	db: Database,
	eventBus: TypedEventEmitter,
	hostName: string,
	siteId: string,
	modelsConfig?: ModelsConfig,
	activeDelegations?: Map<string, { targetSiteId: string; processOutboxId: string }>,
	logger?: ReturnType<typeof createLogger>,
	emitToolCancel?: (
		entries: Array<{ event_payload: string | null; claimed_by: string | null; message_id: string }>,
		threadId: string,
		reason: "thread_canceled" | "dispatch_expired" | "session_reset",
	) => void,
	requestConsistency?: (tables: string[]) => Promise<Map<string, { count: number; pks: string[] }>>,
): Hono {
	const log = logger ?? createLogger("@bound/web", "status");
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const uptime = process.uptime();
			const activeLoops = db
				.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'running' AND deleted = 0")
				.get() as { count: number };

			const status = {
				host_info: {
					uptime_seconds: Math.floor(uptime),
					active_loops: activeLoops.count,
				},
			};

			return c.json(status);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get status",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/network", (c) => {
		try {
			const hosts = db
				.query("SELECT * FROM hosts WHERE deleted = 0 ORDER BY host_name ASC")
				.all() as Array<Record<string, unknown>>;

			const syncState = db.query("SELECT * FROM sync_state").all() as Array<
				Record<string, unknown>
			>;

			const localSiteId = getSiteId(db);

			// Determine hub: if we have a sync_state peer, that's our hub (spoke mode).
			// Otherwise we ARE the hub.
			let hub: { siteId: string; hostName: string } | null = null;
			const peerRow = db.query("SELECT peer_site_id FROM sync_state LIMIT 1").get() as {
				peer_site_id: string;
			} | null;
			const hubSiteId = peerRow?.peer_site_id ?? localSiteId;
			const hubHostRow = db
				.query("SELECT site_id, host_name FROM hosts WHERE site_id = ? AND deleted = 0")
				.get(hubSiteId) as { site_id: string; host_name: string } | null;
			if (hubHostRow) {
				hub = { siteId: hubHostRow.site_id, hostName: hubHostRow.host_name };
			}

			return c.json({
				hosts,
				hub,
				syncState,
				localSiteId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get network status",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/models", (c) => {
		const STALE_THRESHOLD_MS = 5 * 60 * 1000;

		const localModels: ClusterModelInfo[] = (modelsConfig?.models ?? []).map((m) => ({
			id: m.id,
			provider: m.provider,
			host: hostName,
			via: "local" as const,
			status: "local" as const,
		}));

		// AC5.1: Query remote models from hosts table
		// Exclude local host by site_id (unique key) not host_name (not guaranteed unique)
		const remoteHosts = db
			.query(
				`SELECT host_name, models, online_at, modified_at
				 FROM hosts
				 WHERE deleted = 0 AND models IS NOT NULL AND site_id != ?`,
			)
			.all(siteId) as Array<{
			host_name: string;
			models: string;
			online_at: string | null;
			modified_at: string | null;
		}>;

		const remoteModels: ClusterModelInfo[] = [];
		for (const host of remoteHosts) {
			const modelsResult = parseJsonSafe(hostModelsSchema, host.models, "host.models");
			if (!modelsResult.ok) {
				log.warn("Invalid host models JSON", {
					hostName: host.host_name,
					error: modelsResult.error,
				});
				continue;
			}

			// Extract model IDs from HostModelEntry array or legacy string array
			const modelIds = modelsResult.value.map((entry) =>
				typeof entry === "string" ? entry : entry.id,
			);

			// AC5.3: Annotate stale models with "offline?"
			const freshTs = host.modified_at ?? host.online_at;
			const isStale = !freshTs || Date.now() - new Date(freshTs).getTime() > STALE_THRESHOLD_MS;

			// AC5.5: Same model ID on multiple hosts → separate entries
			for (const modelId of modelIds) {
				remoteModels.push({
					id: modelId,
					provider: "remote",
					host: host.host_name,
					via: "relay" as const,
					status: isStale ? ("offline?" as const) : ("online" as const),
				});
			}
		}

		return c.json({
			models: [...localModels, ...remoteModels],
			default: modelsConfig?.default ?? "",
		});
	});

	app.post("/cancel/:threadId", (c) => {
		try {
			const { threadId } = c.req.param();

			const thread = db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(threadId);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			// Get siteId and hostName for message persistence
			const localSiteId = getSiteId(db);

			const hostNameRow = db.query("SELECT value FROM host_meta WHERE key = 'host_name'").get() as
				| { value: string }
				| undefined;
			const hostNameValue = hostNameRow?.value ?? "unknown";

			// Read pending client tool calls BEFORE expiring them (AC3.1)
			const pendingBefore = getPendingClientToolCalls(db, threadId);

			// Expire any pending client tool calls for this thread (AC4.5)
			const cancelledToolCalls = cancelClientToolCalls(db, threadId);

			// Emit tool:cancel for cancelled entries (AC3.1)
			if (emitToolCancel && pendingBefore.length > 0) {
				emitToolCancel(pendingBefore, threadId, "thread_canceled");
			}

			if (cancelledToolCalls > 0) {
				log.info(
					`[cancel] Expired ${cancelledToolCalls} pending client tool call(s) for thread ${threadId}`,
				);

				// Inject interruption notice if client tool calls were cancelled
				insertRow(
					db,
					"messages",
					{
						id: randomUUID(),
						thread_id: threadId,
						role: "developer",
						content:
							"[Client tool calls cancelled] Pending client tool calls were cancelled by user request.",
						model_id: null,
						tool_name: null,
						created_at: new Date().toISOString(),
						modified_at: new Date().toISOString(),
						host_origin: hostNameValue,
						deleted: 0,
						exit_code: null,
						metadata: null,
					},
					localSiteId,
				);
			}

			// Persist cancellation message per spec R-E14
			const cancelMsgId = randomUUID();
			const now = new Date().toISOString();
			insertRow(
				db,
				"messages",
				{
					id: cancelMsgId,
					thread_id: threadId,
					role: "developer",
					content: `Agent cancelled by user on host ${hostNameValue}`,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostNameValue,
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
				siteId,
			);

			// Emit cancel event on eventBus to signal agent loop to stop
			eventBus.emit("agent:cancel", { thread_id: threadId });

			// AC6.4: Propagate cancel to delegated processing host
			const delegation = activeDelegations?.get(threadId);
			if (delegation) {
				const cancelEntry = createRelayOutboxEntry(
					delegation.targetSiteId,
					siteId,
					"cancel",
					JSON.stringify({}),
					30_000,
					delegation.processOutboxId, // ref_id matches the process message
				);
				try {
					writeOutbox(db, cancelEntry);
				} catch {
					// Non-fatal
				}
			}

			return c.json({
				cancelled: true,
				thread_id: threadId,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to cancel agent loop",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/consistency", async (c) => {
		if (!requestConsistency) {
			return c.json({ error: "Consistency check not available (not connected to hub)" }, 503);
		}

		try {
			const body = await c.req.json().catch(() => ({}));
			const tables = (body as { tables?: string[] }).tables ?? [];
			const remoteTables = await requestConsistency(tables);

			const diffs = compareAllTables(db, remoteTables);
			const localSiteId = getSiteId(db);
			const msgDiff = diffs.find((d) => d.table === "messages");
			const unsyncable = msgDiff ? countUnsyncableLocalOnly(db, msgDiff.localOnly) : [];

			return c.json({
				localSiteId,
				tables: diffs,
				unsyncable,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Consistency check failed", details: message }, 500);
		}
	});

	return app;
}
