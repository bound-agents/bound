import { formatError } from "@bound/shared";

import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

interface HostRow {
	site_id: string;
	host_name: string;
	version: string | null;
	sync_url: string | null;
	mcp_servers: string | null;
	mcp_tools: string | null;
	models: string | null;
	overlay_root: string | null;
	online_at: string | null;
	modified_at: string;
	platforms: string | null;
}

const STALE_THRESHOLD_S = 120; // 2 minutes

function relativeTime(iso: string | null): string {
	if (!iso) return "never";
	const diffMs = Date.now() - new Date(iso).getTime();
	if (diffMs < 0) return "just now";
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function lookupStats<T>(map: Map<string, T>, host: HostRow): T | undefined {
	return map.get(host.site_id) || map.get(host.host_name);
}

interface ModelInfo {
	id: string;
	tier?: number;
	capabilities?: { max_context?: number };
}

export const hostinfo: CommandDefinition = {
	name: "hostinfo",
	args: [],
	handler: async (_args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const hosts = ctx.db
				.prepare("SELECT * FROM hosts WHERE deleted = 0 ORDER BY host_name ASC")
				.all() as HostRow[];

			if (hosts.length === 0) {
				return {
					stdout: "No hosts registered.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			// Local site_id for marking local node
			const localMeta = ctx.db
				.prepare("SELECT value FROM host_meta WHERE key = 'site_id'")
				.get() as { value: string } | null;
			const localSiteId = localMeta?.value;

			// Sync state by peer
			const syncStates = ctx.db
				.prepare("SELECT peer_site_id, sync_errors, last_sync_at FROM sync_state")
				.all() as { peer_site_id: string; sync_errors: number; last_sync_at: string | null }[];
			const syncByPeer = new Map(syncStates.map((s) => [s.peer_site_id, s]));

			// Task stats by claimed_by
			const taskStats = ctx.db
				.prepare(
					`SELECT claimed_by,
						COUNT(*) as total,
						SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END) as failing
					 FROM tasks
					 WHERE status = 'pending' AND deleted = 0
					 GROUP BY claimed_by`,
				)
				.all() as { claimed_by: string; total: number; failing: number }[];
			const tasksByHost = new Map(taskStats.map((t) => [t.claimed_by, t]));

			// Message counts per host_origin in last hour
			const cutoff = new Date(Date.now() - 3600_000).toISOString();
			const msgStats = ctx.db
				.prepare(
					`SELECT host_origin,
						COUNT(*) as count,
						MAX(created_at) as latest
					 FROM messages
					 WHERE created_at > ?
						AND host_origin IS NOT NULL
						AND host_origin != ''
					 GROUP BY host_origin`,
				)
				.all(cutoff) as { host_origin: string; count: number; latest: string }[];

			// Advisory counts per created_by
			const advisoryStats = ctx.db
				.prepare(
					`SELECT created_by, COUNT(*) as count
					 FROM advisories
					 WHERE deleted = 0 AND status = 'proposed'
					 GROUP BY created_by`,
				)
				.all() as { created_by: string; count: number }[];
			const advisoriesByNode = new Map(advisoryStats.map((a) => [a.created_by, a]));

			// --- Phase 3: Cluster topology summary ---
			const clusterModels = new Map<string, string[]>();
			const clusterTools = new Map<string, string[]>();
			let onlineCount = 0;
			let staleCount = 0;

			for (const host of hosts) {
				const staleSec = (Date.now() - new Date(host.modified_at).getTime()) / 1000;
				if (staleSec < STALE_THRESHOLD_S) {
					onlineCount++;
				} else {
					staleCount++;
				}

				// Parse models
				if (host.models) {
					try {
						const models: ModelInfo[] | string[] = JSON.parse(host.models);
						for (const m of models) {
							const id = typeof m === "string" ? m : m.id;
							const arr = clusterModels.get(id) ?? [];
							arr.push(host.host_name);
							clusterModels.set(id, arr);
						}
					} catch {
						// Malformed JSON — skip
					}
				}

				// Parse MCP servers
				if (host.mcp_servers) {
					try {
						const servers: string[] = JSON.parse(host.mcp_servers);
						for (const s of servers) {
							const arr = clusterTools.get(s) ?? [];
							arr.push(host.host_name);
							clusterTools.set(s, arr);
						}
					} catch {
						// Malformed JSON — skip
					}
				}
			}

			const lines: string[] = [];

			// Topology header
			const statusParts: string[] = [];
			if (onlineCount > 0) statusParts.push(`${onlineCount} online`);
			if (staleCount > 0) statusParts.push(`${staleCount} stale`);
			lines.push(`═══ Cluster: ${hosts.length} nodes, ${statusParts.join(", ")} ═══`);
			lines.push("");

			// Model distribution
			if (clusterModels.size > 0) {
				lines.push("Models:");
				const maxLen = Math.max(...[...clusterModels.keys()].map((k) => k.length));
				for (const [id, hostNames] of clusterModels) {
					lines.push(`  ${id.padEnd(maxLen)} → ${hostNames.join(", ")}`);
				}
				lines.push("");
			}

			// MCP distribution
			if (clusterTools.size > 0) {
				lines.push("MCP Servers:");
				const maxLen = Math.max(...[...clusterTools.keys()].map((k) => k.length));
				for (const [name, hostNames] of clusterTools) {
					lines.push(`  ${name.padEnd(maxLen)} → ${hostNames.join(", ")}`);
				}
				lines.push("");
			}

			// Sync mesh (only if multiple hosts)
			if (hosts.length > 1 && syncStates.length > 0) {
				lines.push("Sync Mesh:");
				const localName =
					hosts.find((h) => h.site_id === localSiteId)?.host_name ?? localSiteId ?? "local";
				for (const sync of syncStates) {
					const peerHost = hosts.find((h) => h.site_id === sync.peer_site_id);
					const peerName = peerHost?.host_name ?? sync.peer_site_id;
					lines.push(
						`  ${localName} ↔ ${peerName} (${sync.sync_errors} errors, last ${relativeTime(sync.last_sync_at)})`,
					);
				}
				lines.push("");
			}

			// SPOF detection (only for multi-node clusters)
			if (hosts.length > 1) {
				const spofs: string[] = [];
				for (const [model, hostNames] of clusterModels) {
					if (hostNames.length === 1) spofs.push(`model:${model} (only on ${hostNames[0]})`);
				}
				for (const [server, hostNames] of clusterTools) {
					if (hostNames.length === 1) spofs.push(`mcp:${server} (only on ${hostNames[0]})`);
				}
				if (spofs.length > 0) {
					lines.push("⚠ Single points of failure:");
					for (const spof of spofs) {
						lines.push(`  ${spof}`);
					}
					lines.push("");
				}
			}

			if (hosts.length > 1 || clusterModels.size > 0 || clusterTools.size > 0) {
				lines.push("═══ Nodes ═══");
				lines.push("");
			}

			// --- Per-node details ---
			for (const host of hosts) {
				const isLocal = host.site_id === localSiteId;
				const staleSec = (Date.now() - new Date(host.modified_at).getTime()) / 1000;
				const status = staleSec < STALE_THRESHOLD_S ? "ONLINE" : "STALE";

				lines.push(
					`Host: ${host.host_name}${isLocal ? " (local)" : ""} — ${status} (${relativeTime(host.modified_at)})`,
				);
				lines.push(`  site_id:     ${host.site_id}`);

				if (host.version) lines.push(`  version:     ${host.version}`);
				if (host.sync_url) lines.push(`  sync_url:    ${host.sync_url}`);

				// Display parsed model IDs instead of raw JSON
				if (host.models) {
					try {
						const models: ModelInfo[] | string[] = JSON.parse(host.models);
						const ids = models.map((m) => (typeof m === "string" ? m : m.id));
						lines.push(`  models:      ${ids.join(", ")}`);
					} catch {
						lines.push(`  models:      ${host.models}`);
					}
				}
				if (host.mcp_servers) {
					try {
						const servers: string[] = JSON.parse(host.mcp_servers);
						lines.push(`  mcp_servers: ${servers.join(", ")}`);
					} catch {
						lines.push(`  mcp_servers: ${host.mcp_servers}`);
					}
				}

				// Sync health (for remote peers)
				const sync = syncByPeer.get(host.site_id);
				if (sync) {
					lines.push(
						`  sync:        ${sync.sync_errors} errors, last ${relativeTime(sync.last_sync_at)}`,
					);
				}

				// Tasks
				const tasks = lookupStats(tasksByHost, host);
				if (tasks) {
					lines.push(`  tasks:       ${tasks.total} claimed, ${tasks.failing} failing`);
				} else {
					lines.push("  tasks:       0 claimed");
				}

				// Messages — aggregate across hostname and site_id variants
				const matchingMsgs = [host.host_name, host.site_id]
					.map((id) => msgStats.find((m) => m.host_origin === id))
					.filter(Boolean);
				const totalMsgs = matchingMsgs.reduce((sum, m) => sum + (m?.count ?? 0), 0);
				const latestMsg = matchingMsgs
					.map((m) => m?.latest ?? "")
					.sort()
					.pop();
				lines.push(
					`  messages:    ${totalMsgs}/hr${latestMsg ? `, latest ${relativeTime(latestMsg)}` : ""}`,
				);

				// Advisories
				const advCount =
					(advisoriesByNode.get(host.site_id)?.count ?? 0) +
					(advisoriesByNode.get(host.host_name)?.count ?? 0);
				if (advCount > 0) {
					lines.push(`  advisories:  ${advCount} open`);
				}

				lines.push("");
			}

			return {
				stdout: lines.join("\n"),
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = formatError(error);
			return {
				stdout: "",
				stderr: `Error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
