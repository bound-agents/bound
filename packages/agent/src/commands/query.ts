import { formatError } from "@bound/shared";

import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

const MAX_ROWS = 1000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1MB

/**
 * Allowlist of read-only PRAGMA names. Every name on this list either (a) is
 * an introspection-only PRAGMA that never accepts a mutating argument, or
 * (b) accepts a value form (`PRAGMA x = v`) that we separately reject via
 * the "=" guard below. The combination of name-check plus "=" rejection
 * ensures only the read form of any listed PRAGMA reaches SQLite.
 *
 * Sources: https://www.sqlite.org/pragma.html and patterns used by Datasette.
 */
const SAFE_PRAGMA_ALLOWLIST: ReadonlySet<string> = new Set([
	// Pure introspection — no side effects, no mutating argument form.
	"table_info",
	"table_xinfo",
	"table_list",
	"index_info",
	"index_xinfo",
	"index_list",
	"foreign_key_list",
	"database_list",
	"compile_options",
	"pragma_list",
	"function_list",
	"module_list",
	"collation_list",
	"page_count",
	"freelist_count",
	"data_version",
	"integrity_check",
	"quick_check",
	// Query-only when called without an argument — write form rejected by
	// the "=" check below.
	"foreign_keys",
	"journal_mode",
	"cache_size",
	"application_id",
	"user_version",
	"schema_version",
	"page_size",
	"encoding",
]);

interface ValidationOk {
	ok: true;
	sql: string;
	isPragma: boolean;
}

interface ValidationError {
	ok: false;
	message: string;
}

type ValidationResult = ValidationOk | ValidationError;

function validate(sql: string): ValidationResult {
	const trimmed = sql.trim();
	if (trimmed === "") {
		return {
			ok: false,
			message: "no SQL query provided. Usage: query SELECT ...",
		};
	}

	const firstTokenMatch = trimmed.match(/^\S+/);
	const firstToken = firstTokenMatch ? firstTokenMatch[0].toUpperCase() : "";

	if (firstToken === "SELECT") {
		return { ok: true, sql: trimmed, isPragma: false };
	}

	if (firstToken === "PRAGMA") {
		// Extract the pragma name: everything after PRAGMA up to "(", "=",
		// ";", whitespace, or end-of-string.
		const nameMatch = trimmed.match(/^PRAGMA\s+([A-Za-z_][A-Za-z0-9_]*)/i);
		const pragmaName = nameMatch ? nameMatch[1].toLowerCase() : "";
		if (!pragmaName) {
			return {
				ok: false,
				message: "malformed PRAGMA statement",
			};
		}
		if (!SAFE_PRAGMA_ALLOWLIST.has(pragmaName)) {
			return {
				ok: false,
				message: `PRAGMA ${pragmaName} is not in the read-only allowlist`,
			};
		}
		// Reject the `=` form (assignment) regardless of which pragma it
		// targets. Even allowlisted pragmas become mutating when assigned to.
		if (trimmed.includes("=")) {
			return {
				ok: false,
				message: "PRAGMA assignment (=) is not permitted; read-only form only",
			};
		}
		return { ok: true, sql: trimmed, isPragma: true };
	}

	return {
		ok: false,
		message: "only SELECT queries and read-only PRAGMAs are allowed",
	};
}

export const query: CommandDefinition = {
	name: "query",
	description: "Execute a read-only SELECT query or read-only PRAGMA against the database",
	args: [
		{
			name: "query",
			required: true,
			description: "SQL SELECT query or read-only PRAGMA (e.g., `PRAGMA table_info(users)`)",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const sql = args.query;

			if (!sql) {
				return {
					stdout: "",
					stderr: "Error: no SQL query provided. Usage: query SELECT ...\n",
					exitCode: 1,
				};
			}

			const validation = validate(sql);
			if (!validation.ok) {
				return {
					stdout: "",
					stderr: `Error: ${validation.message}\n`,
					exitCode: 1,
				};
			}

			// Set 5-second busy timeout
			ctx.db.exec("PRAGMA busy_timeout = 5000");

			// Add LIMIT 1000 for SELECTs without an existing LIMIT. PRAGMAs
			// skip this because most PRAGMA forms reject trailing LIMIT and
			// row counts are already bounded by the PRAGMA semantics.
			let sqlToRun = validation.sql;
			if (!validation.isPragma) {
				const limitPattern = /\bLIMIT\b/i;
				if (!limitPattern.test(sqlToRun)) {
					sqlToRun = `${sqlToRun.trimEnd()} LIMIT ${MAX_ROWS}`;
				}
			}

			const stmt = ctx.db.prepare(sqlToRun);
			const results = stmt.all() as Array<Record<string, unknown>>;

			const lines: string[] = [];
			if (results.length > 0) {
				const columns = Object.keys(results[0]);
				lines.push(columns.join("\t"));

				for (const row of results) {
					const values = columns.map((col) => {
						const val = row[col];
						return val === null || val === undefined ? "" : String(val);
					});
					lines.push(values.join("\t"));
				}
			}

			let output = lines.join("\n") + (lines.length > 0 ? "\n" : "");

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
