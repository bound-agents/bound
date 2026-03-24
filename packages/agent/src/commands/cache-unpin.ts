import { formatError } from "@bound/shared";

import { createChangeLogEntry } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

/**
 * Helper to update cluster_config with proper change-log entry.
 * cluster_config uses 'key' as primary key (not 'id'), so we handle it specially.
 */
function updateClusterConfig(ctx: CommandContext, key: string, value: string): void {
	const now = new Date().toISOString();
	const txFn = ctx.db.transaction(() => {
		ctx.db.run(
			"INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at",
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

export const cacheUnpin: CommandDefinition = {
	name: "cache-unpin",
	args: [{ name: "path", required: true, description: "File path to unpin" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const path = args.path;

			// Find the file by path
			const file = ctx.db
				.prepare("SELECT id FROM files WHERE path = ? AND deleted = 0")
				.get(path) as { id: string } | null;

			if (!file) {
				return {
					stdout: "",
					stderr: `File not found: ${path}\n`,
					exitCode: 1,
				};
			}

			// Read current pinned_files from cluster_config
			const configRow = ctx.db
				.query("SELECT value FROM cluster_config WHERE key = ?")
				.get("pinned_files") as { value: string } | null;

			if (!configRow) {
				return {
					stdout: "",
					stderr: `File not pinned: ${path}\n`,
					exitCode: 1,
				};
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
			const filteredFiles = pinnedFiles.filter((p) => p !== path);
			if (filteredFiles.length === pinnedFiles.length) {
				return {
					stdout: "",
					stderr: `File not pinned: ${path}\n`,
					exitCode: 1,
				};
			}

			updateClusterConfig(ctx, "pinned_files", JSON.stringify(filteredFiles));

			return {
				stdout: `File unpinned: ${path}\n`,
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
