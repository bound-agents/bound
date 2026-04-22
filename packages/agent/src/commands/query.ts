import { formatError } from "@bound/shared";

import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

const MAX_ROWS = 1000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1MB

export const query: CommandDefinition = {
	name: "query",
	description: "Execute a SELECT query against the database",
	args: [{ name: "query", required: true, description: "SQL SELECT query to execute" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const sql = args.query;

			// Validate query is provided
			if (!sql || sql.trim() === "") {
				return {
					stdout: "",
					stderr: "Error: no SQL query provided. Usage: query SELECT ...\n",
					exitCode: 1,
				};
			}

			// Validate query is SELECT-only
			const trimmed = sql.trim().toUpperCase();
			if (!trimmed.startsWith("SELECT")) {
				return {
					stdout: "",
					stderr: "Error: only SELECT-only queries are allowed\n",
					exitCode: 1,
				};
			}

			// Set 5-second busy timeout
			ctx.db.exec("PRAGMA busy_timeout = 5000");

			// Add LIMIT 1000 if no LIMIT clause is present
			const limitPattern = /\bLIMIT\b/i;
			const sqlWithLimit = limitPattern.test(sql) ? sql : `${sql.trimEnd()} LIMIT ${MAX_ROWS}`;

			// Execute query
			const stmt = ctx.db.prepare(sqlWithLimit);
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

			let output = lines.join("\n") + (lines.length > 0 ? "\n" : "");

			// Truncate output to 1MB cap
			if (output.length > MAX_OUTPUT_BYTES) {
				output = output.slice(0, MAX_OUTPUT_BYTES);
				output += "\n[output truncated at 1MB]\n";
			}

			return {
				stdout: output,
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = formatError(error);
			return {
				stdout: "",
				stderr: `Query error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
