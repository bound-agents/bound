import { createChangeLogEntry, softDelete } from "@bound/core";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

const cacheSchema = z.object({
	action: z.enum(["warm", "pin", "unpin", "evict"]).describe("Cache operation to perform"),
	path: z.string().optional().describe("File path (for pin, unpin)"),
	pattern: z.string().optional().describe("Glob pattern (for warm, evict)"),
});

/**
 * Helper to update cluster_config with proper change-log entry.
 * cluster_config uses 'key' as primary key (not 'id'), so we handle it specially.
 */
function updateClusterConfig(ctx: ToolContext, key: string, value: string): void {
	const now = new Date().toISOString();
	const txFn = ctx.db.transaction(() => {
		ctx.db.run(
			"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at", // outbox-exempt: createChangeLogEntry called below
			[key, value, now],
		);

		// Fetch the full row for change_log
		const row = ctx.db.query("SELECT * FROM cluster_config WHERE key = ?").get(key) as Record<
			string,
			unknown
		>;

		// Create change_log entry using key as row_id
		createChangeLogEntry(ctx.db, "cluster_config", key, ctx.siteId, row);
	});

	txFn();
}

function handleWarm(_args: z.infer<typeof cacheSchema>, _ctx: ToolContext): string {
	return "cache-warm: requires remote host connectivity configured via mcp.json (MCP proxy not yet implemented)\nTo enable MCP proxy, add remote host configuration to your mcp.json file.";
}

function handlePin(args: z.infer<typeof cacheSchema>, ctx: ToolContext): string {
	if (!args.path) {
		return "Error: pin requires 'path' parameter";
	}

	// Find the file by path
	const file = ctx.db
		.prepare("SELECT id FROM files WHERE path = ? AND deleted = 0")
		.get(args.path) as {
		id: string;
	} | null;

	if (!file) {
		return `Error: File not found: ${args.path}`;
	}

	// Read current pinned_files from cluster_config
	const configRow = ctx.db
		.query("SELECT value FROM cluster_config WHERE key = ?")
		.get("pinned_files") as { value: string } | null;

	let pinnedFiles: string[] = [];
	if (configRow) {
		try {
			pinnedFiles = JSON.parse(configRow.value);
			if (!Array.isArray(pinnedFiles)) {
				pinnedFiles = [];
			}
		} catch {
			pinnedFiles = [];
		}
	}

	// Add the path if not already pinned
	if (!pinnedFiles.includes(args.path)) {
		pinnedFiles.push(args.path);
		updateClusterConfig(ctx, "pinned_files", JSON.stringify(pinnedFiles));
	}

	return `File pinned: ${args.path}`;
}

function handleUnpin(args: z.infer<typeof cacheSchema>, ctx: ToolContext): string {
	if (!args.path) {
		return "Error: unpin requires 'path' parameter";
	}

	// Find the file by path
	const file = ctx.db
		.prepare("SELECT id FROM files WHERE path = ? AND deleted = 0")
		.get(args.path) as {
		id: string;
	} | null;

	if (!file) {
		return `Error: File not found: ${args.path}`;
	}

	// Read current pinned_files from cluster_config
	const configRow = ctx.db
		.query("SELECT value FROM cluster_config WHERE key = ?")
		.get("pinned_files") as { value: string } | null;

	if (!configRow) {
		return `Error: File not pinned: ${args.path}`;
	}

	let pinnedFiles: string[] = [];
	try {
		pinnedFiles = JSON.parse(configRow.value);
		if (!Array.isArray(pinnedFiles)) {
			pinnedFiles = [];
		}
	} catch {
		pinnedFiles = [];
	}

	// Remove the path if it exists
	const filteredFiles = pinnedFiles.filter((p) => p !== args.path);
	if (filteredFiles.length === pinnedFiles.length) {
		return `Error: File not pinned: ${args.path}`;
	}

	updateClusterConfig(ctx, "pinned_files", JSON.stringify(filteredFiles));

	return `File unpinned: ${args.path}`;
}

function handleEvict(args: z.infer<typeof cacheSchema>, ctx: ToolContext): string {
	if (!args.pattern) {
		return "Error: evict requires 'pattern' parameter";
	}

	// Simple pattern matching (% for SQL LIKE)
	const sqlPattern = args.pattern.replace(/\*/g, "%").replace(/\?/g, "_");

	// Find files matching the pattern
	const files = ctx.db
		.prepare("SELECT id FROM files WHERE path LIKE ? AND deleted = 0")
		.all(sqlPattern) as Array<{ id: string }>;

	if (files.length === 0) {
		return "Evicted 0 cached file(s)";
	}

	// Soft-delete matching files
	for (const file of files) {
		softDelete(ctx.db, "files", file.id, ctx.siteId);
	}

	return `Evicted ${files.length} cached file(s)`;
}

export function createCacheTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(cacheSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "cache",
				description: "Cache operations: warm, pin, unpin, evict",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(cacheSchema, raw, "cache");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				switch (input.action) {
					case "warm":
						return handleWarm(input, ctx);
					case "pin":
						return handlePin(input, ctx);
					case "unpin":
						return handleUnpin(input, ctx);
					case "evict":
						return handleEvict(input, ctx);
					default:
						return `Error: Unknown action "${input.action}". Valid actions: warm, pin, unpin, evict`;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
