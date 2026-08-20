import {
	cancelClientToolCalls,
	compareAllTables,
	countRunningTasks,
	countUnsyncableLocalOnly,
	findHostSiteIdAndNameById,
	findLiveThreadById,
	getHostMetaHostName,
	getPeerSiteId,
	getPendingClientToolCalls,
	getSiteId,
	insertRow,
	listHostsOrderedByName,
	listRemoteHostModelLiveness,
	listSyncState,
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
	modelsConfig?: ModelsConfig | (() => ModelsConfig | undefined),
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
			const activeLoops = countRunningTasks(db);

			const status = {
				host_info: {
					uptime_seconds: Math.floor(uptime),
					active_loops: activeLoops?.count ?? 0,
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
			const hosts = listHostsOrderedByName(db);

			const syncState = listSyncState(db);

			const localSiteId = getSiteId(db);

			// Determine hub: if we have a sync_state peer, that's our hub (spoke mode).
			// Otherwise we ARE the hub.
			let hub: { siteId: string; hostName: string } | null = null;
			const hubSiteId = getPeerSiteId(db) ?? localSiteId;
			const hubHostRow = findHostSiteIdAndNameById(db, hubSiteId);
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

		// modelsConfig may be a live getter (so SIGHUP reloads propagate to the
		// discovery endpoint) or a static snapshot — resolve per request.
		const resolved = typeof modelsConfig === "function" ? modelsConfig() : modelsConfig;

		const localModels: ClusterModelInfo[] = (resolved?.models ?? []).map((m) => ({
			id: m.id,
			provider: m.provider,
			host: hostName,
			via: "local" as const,
			status: "local" as const,
		}));

		// AC5.1: Query remote models from hosts table
		// Exclude local host by site_id (unique key) not host_name (not guaranteed unique)
		const remoteHosts = listRemoteHostModelLiveness(db, siteId);

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
			default: resolved?.default ?? "",
		});
	});

	app.post("/cancel/:threadId", (c) => {
		try {
			const { threadId } = c.req.param();

			const thread = findLiveThreadById(db, threadId);

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

			const hostNameValue = getHostMetaHostName(db) ?? "unknown";

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

			// Emit cancel event on eventBus to signal agent loop to stop. The loop
			// runs locally on the trigger host (single delegation path, R-UD1), so
			// the local agent:cancel event reaches it; there is no whole-loop
			// delegation to propagate a cancel to anymore. In-flight relayed
			// inference is cancelled by the loop's own relay cancel path.
			eventBus.emit("agent:cancel", { thread_id: threadId });

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
