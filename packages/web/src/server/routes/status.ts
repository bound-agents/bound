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
	isHostFresh,
	listDrainedRouteIds,
	listHostSiteIdNameAndModels,
	listHostsOrderedByName,
	listRemoteHostModelLiveness,
	listSyncState,
} from "@bound/core";
import type { EmitToolCancel, RequestConsistency } from "../lib/handler-types";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	type TypedEventEmitter,
	createLogger,
	hostModelsSchema,
	parseJsonSafe,
} from "@bound/shared";
import { Hono } from "hono";
import {
	collectSupply,
	disambiguateDisplayNames,
	resolveModelDisplayName,
} from "../lib/model-supply";

export interface ModelInfo {
	id: string;
	provider: string;
}

export interface ClusterModelInfo {
	id: string;
	/** Logical model this backend serves (spec §2.1); the picker's selection key. Falls back to the id. */
	logical_model: string;
	/** User-facing display name (spec §2.1) of the logical model; never a backend id when a logical model is known. */
	display_name: string;
	provider: string;
	host: string;
	via: "local" | "relay";
	status: "local" | "online" | "offline?";
	/** True when every advertised route of this logical model is drained by an operator. */
	drained: boolean;
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
	emitToolCancel?: EmitToolCancel,
	requestConsistency?: RequestConsistency,
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
		// modelsConfig may be a live getter (so SIGHUP reloads propagate to the
		// discovery endpoint) or a static snapshot — resolve per request.
		const resolved = typeof modelsConfig === "function" ? modelsConfig() : modelsConfig;

		// Backend id → logical model, harvested from every host's hosts.models
		// advertisement. Display names come from the same ranked resolution the
		// Settings › Models page uses, so every picker shows one name per model.
		const logicalByModelId = new Map<string, string>();
		for (const host of listHostSiteIdNameAndModels(db)) {
			if (host.models === null) continue;
			const parsed = parseJsonSafe(hostModelsSchema, host.models, "host.models");
			if (!parsed.ok) continue;
			for (const raw of parsed.value) {
				if (typeof raw === "string") continue;
				const logical = raw.logical_model ?? raw.id;
				if (!logicalByModelId.has(raw.id)) logicalByModelId.set(raw.id, logical);
			}
		}
		const supply = collectSupply(db);
		const drainedIds = new Set(listDrainedRouteIds(db));
		const named = [...supply].map(([logical, routes]) => ({
			logical_model: logical,
			display_name: resolveModelDisplayName(logical, routes),
			routes,
		}));
		disambiguateDisplayNames(named);
		const nameByLogical = new Map(named.map((n) => [n.logical_model, n.display_name]));
		const logicalFor = (modelId: string): string => logicalByModelId.get(modelId) ?? modelId;
		const displayNameFor = (modelId: string): string => {
			const logical = logicalFor(modelId);
			return nameByLogical.get(logical) ?? logical;
		};
		const isDrained = (modelId: string): boolean => {
			const routes = supply.get(logicalFor(modelId)) ?? [];
			return routes.length > 0 && routes.every((r) => drainedIds.has(r.route_id));
		};

		const localModels: ClusterModelInfo[] = (resolved?.models ?? []).map((m) => ({
			id: m.id,
			logical_model: logicalFor(m.id),
			display_name: displayNameFor(m.id),
			provider: m.provider,
			host: hostName,
			via: "local" as const,
			status: "local" as const,
			drained: isDrained(m.id),
		}));

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

			const isStale = !isHostFresh(host);

			// #271: same-id models across hosts (or local+remote) collapse to one
			// entry in the final dedup below. The router resolves the provider
			// dynamically per call, so the display list carries one row per id.
			for (const modelId of modelIds) {
				remoteModels.push({
					id: modelId,
					logical_model: logicalFor(modelId),
					display_name: displayNameFor(modelId),
					provider: "remote",
					host: host.host_name,
					via: "relay" as const,
					status: isStale ? ("offline?" as const) : ("online" as const),
					drained: isDrained(modelId),
				});
			}
		}

		// #271 / spec §9.1: one row per LOGICAL model. Expanded backends of the same
		// logical model (pooled providers, several hosts, local + remote) collapse
		// to the first-seen entry; localModels come first so a locally servable
		// model keeps the local annotation. Presentational only — routing re-picks
		// an eligible provider per call.
		const deduped: ClusterModelInfo[] = [];
		const seenModelIds = new Set<string>();
		for (const model of [...localModels, ...remoteModels]) {
			if (seenModelIds.has(model.logical_model)) continue;
			seenModelIds.add(model.logical_model);
			deduped.push(model);
		}
		deduped.sort((a, b) =>
			a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }),
		);

		return c.json({
			models: deduped,
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

			// Read pending client tool calls BEFORE expiring them: expiry clears the rows tool:cancel needs.
			const pendingBefore = getPendingClientToolCalls(db, threadId);

			const cancelledToolCalls = cancelClientToolCalls(db, threadId);

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
