import type { Database } from "bun:sqlite";
import type { EligibleHost } from "./relay-router.js";
import type { ModelRouter } from "@bound/llm";
import { resolveModel } from "./model-resolution.js";

/**
 * Returns the counts of recent tool calls in a thread.
 * Tool names are stored in messages.tool_name (e.g., "server-toolName").
 */
export function getRecentToolCalls(
	db: Database,
	threadId: string,
	limit = 20,
): { toolName: string; count: number }[] {
	const rows = db
		.query(
			`SELECT tool_name, COUNT(*) as count
			 FROM messages
			 WHERE thread_id = ? AND tool_name IS NOT NULL
			 GROUP BY tool_name
			 ORDER BY MAX(created_at) DESC
			 LIMIT ?`,
		)
		.all(threadId, limit) as Array<{ tool_name: string; count: number }>;

	return rows.map((r) => ({ toolName: r.tool_name, count: r.count }));
}

/**
 * Determines whether to delegate the agent loop to a remote host.
 *
 * Returns the target EligibleHost if all AC6.1 conditions hold:
 * 1. Model resolves to a single remote host
 * 2. That host has ≥50% of the thread's recent tool calls in its mcp_tools
 *
 * Returns null to run locally (AC6.5).
 */
export function getDelegationTarget(
	db: Database,
	threadId: string,
	modelId: string | undefined,
	modelRouter: ModelRouter,
	localSiteId: string,
): EligibleHost | null {
	const resolution = resolveModel(modelId, modelRouter, db, localSiteId);

	// Condition 1: model must be remote
	if (resolution.kind !== "remote") return null;

	// Condition 1b: exactly one host has the model
	if (resolution.hosts.length !== 1) return null;

	const targetHost = resolution.hosts[0];

	// Condition 2: ≥50% of recent tools on that host
	const recentTools = getRecentToolCalls(db, threadId, 20);
	const totalToolCalls = recentTools.reduce((sum, t) => sum + t.count, 0);

	// AC6.7: vacuous match — no tool call history → delegate
	if (totalToolCalls === 0) return targetHost;

	// Look up target host's mcp_tools
	const hostRow = db
		.query("SELECT mcp_tools FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(targetHost.site_id) as { mcp_tools: string | null } | null;

	if (!hostRow?.mcp_tools) return null; // Host has no tools — can't match 50%

	let targetMcpTools: string[];
	try {
		targetMcpTools = JSON.parse(hostRow.mcp_tools);
	} catch {
		return null;
	}

	const targetToolCalls = recentTools
		.filter((t) => targetMcpTools.includes(t.toolName))
		.reduce((sum, t) => sum + t.count, 0);

	if (targetToolCalls / totalToolCalls < 0.5) return null; // AC6.5: condition unmet

	return targetHost;
}
