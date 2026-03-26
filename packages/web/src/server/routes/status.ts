import { getSiteId, writeOutbox } from "@bound/core";
import { createRelayOutboxEntry } from "@bound/agent";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
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
): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const uptime = process.uptime();
			const activeLoops = db
				.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'running'")
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
			const hosts = db.query("SELECT * FROM hosts ORDER BY host_name ASC").all() as Array<
				Record<string, unknown>
			>;

			const hubRow = db.query("SELECT value FROM cluster_config WHERE key = 'hub'").get() as {
				value: string;
			} | null;
			const hub = hubRow?.value ?? null;

			const syncState = db.query("SELECT * FROM sync_state").all() as Array<
				Record<string, unknown>
			>;

			return c.json({
				hosts,
				hub,
				syncState,
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
				`SELECT host_name, models, online_at
				 FROM hosts
				 WHERE deleted = 0 AND models IS NOT NULL AND site_id != ?`,
			)
			.all(siteId) as Array<{ host_name: string; models: string; online_at: string | null }>;

		const remoteModels: ClusterModelInfo[] = [];
		for (const host of remoteHosts) {
			let modelIds: string[];
			try {
				modelIds = JSON.parse(host.models);
			} catch {
				continue;
			}
			// AC5.3: Annotate stale models with "offline?"
			const isStale =
				!host.online_at || Date.now() - new Date(host.online_at).getTime() > STALE_THRESHOLD_MS;

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
			const siteId = getSiteId(db);

			const hostNameRow = db.query("SELECT value FROM host_meta WHERE key = 'host_name'").get() as
				| { value: string }
				| undefined;
			const hostNameValue = hostNameRow?.value ?? "unknown";

			// Persist cancellation message per spec R-E14
			const cancelMsgId = randomUUID();
			const now = new Date().toISOString();
			insertRow(
				db,
				"messages",
				{
					id: cancelMsgId,
					thread_id: threadId,
					role: "system",
					content: `Agent cancelled by user on host ${hostNameValue}`,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: hostNameValue,
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
					"cancel",
					JSON.stringify({}),
					30_000,
					delegation.processOutboxId, // ref_id matches the process message
				);
				try {
					writeOutbox(db, cancelEntry);
					eventBus.emit("sync:trigger", { reason: "delegation-cancel" });
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

	return app;
}
