/**
 * Static system parts builder. See `index.ts` for the
 * architectural rationale and post-condition contract.
 */

import type { Database } from "bun:sqlite";
import { getSyncedTableSchemas } from "@bound/core";
import type { CommandRegistryEntry } from "@bound/shared";

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
	"in parallel — including threads you spawn for yourself. Use `schedule` to fan work out " +
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
	/** Resolved persona body, or `null` when `config/persona.md` doesn't exist. */
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
	registry: ReadonlyArray<CommandRegistryEntry>,
	hostName: string | undefined,
	siteId: string | undefined,
	topologyRole: "hub" | "spoke" | undefined,
): string {
	const lines: string[] = ["## Orientation", ""];

	// MCP bridge commands are the only commands still in the registry.
	// Native agent tools are self-describing through their ToolDefinition schemas.
	if (registry.length > 0) {
		const commandList = [...registry]
			.sort((a, b) => a.name.localeCompare(b.name))
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
	return lines.join("\n");
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
