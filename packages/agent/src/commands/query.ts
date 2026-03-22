import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const query: CommandDefinition = {
	name: "query",
	args: [{ name: "query", required: true, description: "SQL SELECT query to execute" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const sql = args.query;

			// Validate query is SELECT-only
			const trimmed = sql.trim().toUpperCase();
			if (!trimmed.startsWith("SELECT")) {
				return {
					stdout: "",
					stderr: "Error: only SELECT-only queries are allowed\n",
					exitCode: 1,
				};
			}

			// Execute query
			const stmt = ctx.db.prepare(sql);
			const results = stmt.all() as Array<Record<string, unknown>>;

			// Format results
			const lines: string[] = [];
			if (results.length > 0) {
				// Get column names from first row
				const columns = Object.keys(results[0]);
				lines.push(columns.join("\t"));

				// Add data rows
				for (const row of results) {
					const values = columns.map((col) => {
						const val = row[col];
						return val === null || val === undefined ? "" : String(val);
					});
					lines.push(values.join("\t"));
				}
			}

			return {
				stdout: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				stdout: "",
				stderr: `Query error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
