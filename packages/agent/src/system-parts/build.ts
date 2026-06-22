/**
 * Static system parts builder. See `index.ts` for the
 * architectural rationale and post-condition contract.
 */

import type { Database } from "bun:sqlite";
import { getSyncedTableSchemas } from "@bound/core";
import type { CommandRegistryEntry } from "@bound/shared";
import { compareBytewise } from "@bound/shared";

export const ENVIRONMENT_PARAGRAPH =
	"**Environment.** You run inside **bound**, a persistent, model-agnostic personal agent " +
	"daemon. Bound owns a local SQLite database that is the source of truth for your memory — " +
	"semantic memory entries, thread summaries, activated skills, and advisories all persist " +
	"across conversations, hosts, and user-facing surfaces, which is what lets you stay " +
	"coherent with the user between sessions. You read and write that memory through commands " +
	"like `memorize`, `memory`, and `query` (read-only SQL and read-only PRAGMAs). Users can " +
	"reach you through several surfaces: the bound web UI, Discord (via a platform " +
	"connector), or **boundless** — a terminal coding client that connects to a bound daemon " +
	"over WebSocket and renders your responses in an Ink-based TUI. Boundless provides its " +
	"own filesystem tools (`boundless_read`, `boundless_write`, `boundless_edit`, " +
	"`boundless_bash`) scoped to the user's local working directory; those tools are only " +
	"present when the current thread is a boundless thread. You may also be invoked " +
	"indirectly through `bound-mcp`, a stdio MCP proxy that forwards a single `bound_chat` " +
	"tool call into a bound thread. Which surface originated the current turn is noted in " +
	"the volatile context that follows this prompt.";

export const CONCURRENCY_PARAGRAPH =
	"**Concurrency model.** Each conversation is a *thread*, and bound can run many threads " +
	"in parallel — including threads you spawn for yourself. Use `task` (action=schedule) to fan work out " +
	"into sibling threads (deferred `--in`, recurring `--every`, or event-driven `--on`); " +
	"each scheduled task runs in its own thread with its own context window, so they don't " +
	"consume this conversation's budget. Use `--after` to chain dependencies, `--inject " +
	"results|all|file` to feed a child thread's output back into this one, and `await` to " +
	"block on specific task IDs when you need their results before proceeding. Treat " +
	"parallel threads as a primary tool for long-running research, exploration, and " +
	"multi-step plans: fan out first, synthesize later. This is an implementation detail of " +
	"how you operate — don't narrate it to the user unless they ask how the work is being " +
	"done.";

export interface BuildStaticSystemPartsParams {
	db: Database;
	/** Resolved persona body, or `null` when the `cluster_config['persona']` row is absent. */
	persona: string | null;
	commandRegistry: ReadonlyArray<CommandRegistryEntry>;
	hostName: string | undefined;
	siteId: string | undefined;
	/**
	 * Cluster topology role of this host: `"hub"` (no `sync.hub` configured) or
	 * `"spoke"` (a hub URL is configured). Rendered inline on the Host Identity
	 * line so cross-host reasoning has the role alongside the site_id. Omitted
	 * when undefined (e.g. tests, hub/spoke not yet resolved). See issue #68.
	 */
	topologyRole?: "hub" | "spoke";
}

export function buildStaticSystemParts(params: BuildStaticSystemPartsParams): string[] {
	const parts: string[] = [];

	parts.push(ENVIRONMENT_PARAGRAPH);
	parts.push(CONCURRENCY_PARAGRAPH);

	if (params.persona) {
		parts.push(params.persona);
	}

	parts.push(
		buildOrientationBlock(
			params.db,
			params.commandRegistry,
			params.hostName,
			params.siteId,
			params.topologyRole,
		),
	);

	const schemaBlock = buildSchemaBlock(params.db);
	if (schemaBlock !== null) {
		parts.push(schemaBlock);
	}

	return parts;
}

function buildOrientationBlock(
	db: Database,
	registry: ReadonlyArray<CommandRegistryEntry>,
	hostName: string | undefined,
	siteId: string | undefined,
	topologyRole: "hub" | "spoke" | undefined,
): string {
	const lines: string[] = ["## Orientation", ""];

	// MCP bridge commands are the only commands still in the registry.
	// Native agent tools are self-describing through their ToolDefinition schemas.
	if (registry.length > 0) {
		// Bytewise: the orientation section rides the stable system prompt, so
		// sort order lands in cached prefix bytes shared across hosts.
		const commandList = [...registry]
			.sort((a, b) => compareBytewise(a.name, b.name))
			.map((c) => `  ${c.name} — ${c.description}`)
			.join("\n");
		lines.push(
			"### Additional MCP Commands",
			commandList,
			"",
			"These are MCP server commands dispatched through the bash tool. Run `<server-name> --help` for details.",
			"",
		);
	}

	// #68: pre-resolve the host_name -> site_id join and the hub/spoke topology
	// role onto a single line so all three land in the same privileged-attention
	// slot. The role is omitted when not resolved (kept stable for tests).
	const host = hostName || "unknown";
	const site = siteId || "unknown";
	const roleSuffix = topologyRole ? `, role: ${topologyRole}` : "";
	lines.push(`### Host Identity\nHost: ${host} (site ${site}${roleSuffix})`);

	const capabilities = buildHostCapabilitiesBlock(db, siteId);
	if (capabilities !== null) {
		lines.push("", capabilities);
	}
	return lines.join("\n");
}

/**
 * Render a `### Host Capabilities` overview for the current host, sourced from
 * its row in the synced `hosts` table. Grounds host self-assessment ("can this
 * host serve inference locally? which connectors does it carry?") in declared
 * topology rather than inference from whether a given test/relay happened to
 * reach a peer.
 *
 * Returns `null` (block omitted) when `siteId` is undefined or no matching
 * `hosts` row exists — matching the graceful-degradation posture of the schema
 * block on a partial test DB.
 *
 * Cache stability (R-VC25): this block rides the system-level cache breakpoint,
 * so it reads ONLY the slow-moving capability columns (`models`,
 * `mcp_servers`, `platforms`) and deliberately NOT `online_at`, which flaps on
 * every heartbeat. Topology shifts only when a host's configured capability set
 * changes — the same posture `loadClusterModels` takes for the `<stable-context>`
 * model topology. All lists are bytewise-sorted for locale-independent
 * determinism.
 *
 * The cluster-inference count answers the resilience question the local-backend
 * line raises ("if this host can't serve inference, who can?") — it counts
 * OTHER hosts whose `models` set is non-empty, so a backendless host's
 * "routes to cluster peers" line has a number behind it.
 */
function buildHostCapabilitiesBlock(db: Database, siteId: string | undefined): string | null {
	if (!siteId) return null;

	let rows: Array<{
		site_id: string;
		models: string | null;
		mcp_servers: string | null;
		platforms: string | null;
	}>;
	try {
		rows = db
			.prepare("SELECT site_id, models, mcp_servers, platforms FROM hosts WHERE deleted = 0")
			.all() as Array<{
			site_id: string;
			models: string | null;
			mcp_servers: string | null;
			platforms: string | null;
		}>;
	} catch {
		// Non-fatal — synthetic test DB missing the hosts table.
		return null;
	}

	const row = rows.find((r) => r.site_id === siteId);
	if (!row) return null;

	const models = parseModelNames(row.models);
	const servers = parseStringList(row.mcp_servers);
	const platforms = parseStringList(row.platforms);
	const otherInferenceHosts = rows.filter(
		(r) => r.site_id !== siteId && parseModelNames(r.models).length > 0,
	).length;

	const lines: string[] = ["### Host Capabilities"];
	lines.push(
		models.length > 0
			? `Local inference backends: ${models.join(", ")}`
			: "Local inference backends: none (inference routes to cluster peers)",
	);
	lines.push(
		otherInferenceHosts > 0
			? `Other hosts with inference backends configured: ${otherInferenceHosts} (declared topology, not live reachability — run hostinfo for online/stale status)`
			: "Other hosts with inference backends configured: none (this host is the only declared inference provider — run hostinfo for live status)",
	);
	if (servers.length > 0) {
		lines.push(`MCP servers: ${servers.join(", ")}`);
	}
	if (platforms.length > 0) {
		lines.push(`Platform connectors: ${platforms.join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Parse the `hosts.models` JSON column into a bytewise-sorted, de-duplicated
 * list of model ids. The column is either `string[]` (logical aliases) or
 * `{ id: string }[]`; mirrors the entry-shape handling in
 * `stable-prefix/collect.ts`'s `loadClusterModels`.
 */
function parseModelNames(raw: string | null): string[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const names = new Set<string>();
	for (const entry of parsed) {
		const name =
			typeof entry === "string"
				? entry
				: entry && typeof entry === "object" && "id" in entry
					? String((entry as { id: unknown }).id)
					: null;
		if (name) names.add(name);
	}
	return [...names].sort(compareBytewise);
}

/**
 * Parse a `hosts` JSON column holding a `string[]` (`mcp_servers`,
 * `platforms`) into a bytewise-sorted, de-duplicated list.
 */
function parseStringList(raw: string | null): string[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const values = new Set<string>();
	for (const entry of parsed) {
		if (typeof entry === "string" && entry.length > 0) values.add(entry);
	}
	return [...values].sort(compareBytewise);
}

function buildSchemaBlock(db: Database): string | null {
	try {
		const schemaInfos = getSyncedTableSchemas(db);
		const schemaLines: string[] = [
			"## Database Schema",
			"",
			"Synced tables available via the `query` command:",
			"",
		];
		for (const info of schemaInfos) {
			// Skip tables that aren't materialized in this DB yet (e.g.,
			// partial test setup that skipped applyMetricsSchema). Emitting
			// a table header with zero columns is noise.
			if (info.columns.length === 0) continue;
			schemaLines.push(`### ${info.table}`);
			for (const col of info.columns) {
				const colParts: string[] = [col.name, col.type || "TEXT"];
				if (col.pk) colParts.push("PK");
				if (col.notnull) colParts.push("NOT NULL");
				schemaLines.push(`- ${colParts.join(" ")}`);
			}
			schemaLines.push("");
		}
		return schemaLines.join("\n").trimEnd();
	} catch {
		// Non-fatal: synthetic test DB missing a table or PRAGMA failure.
		return null;
	}
}
