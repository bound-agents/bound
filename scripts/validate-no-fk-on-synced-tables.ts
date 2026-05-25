#!/usr/bin/env bun
/**
 * Validates Critical Invariant #20 (CONTRIBUTING.md): synced tables
 * MUST NOT declare `REFERENCES` or `FOREIGN KEY` constraints.
 *
 * Rationale (paraphrased from CONTRIBUTING.md): changelog replay,
 * snapshot seeding, and backfill all insert rows in non-deterministic
 * order — a message may arrive before its parent thread, a memory
 * edge before its source node. FK constraints would cause intermittent
 * hard failures during sync that depend on network timing.
 *
 * The check scans `packages/core/src/schema.ts` and `metrics-schema.ts`
 * for `CREATE TABLE` statements naming a synced table, then verifies
 * the table body contains neither `REFERENCES` nor `FOREIGN KEY`
 * (case-insensitive).
 *
 * Run: bun run scripts/validate-no-fk-on-synced-tables.ts
 * Wired into: bun check (pre-commit hook)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SYNCED_TABLES = [
	"users",
	"threads",
	"messages",
	"semantic_memory",
	"tasks",
	"files",
	"hosts",
	"overlay_index",
	"cluster_config",
	"advisories",
	"skills",
	"memory_edges",
	"connector_handles",
	"webhooks",
	"turns",
];

const SCHEMA_FILES = ["packages/core/src/schema.ts", "packages/core/src/metrics-schema.ts"];

interface Violation {
	file: string;
	table: string;
	keyword: string;
	snippet: string;
}

function findSyncedTableBodies(content: string): Array<{ table: string; body: string }> {
	const out: Array<{ table: string; body: string }> = [];
	for (const table of SYNCED_TABLES) {
		// Match `CREATE TABLE [IF NOT EXISTS] <table> (` and capture body
		// up to the matching `)` STRICT?. Naive paren-matching is enough
		// since these schemas don't nest parens deeply.
		const pattern = new RegExp(
			`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["']?${table}["']?\\s*\\(([\\s\\S]*?)\\)\\s*(?:STRICT|;|$)`,
			"gi",
		);
		let match = pattern.exec(content);
		while (match !== null) {
			out.push({ table, body: match[1] });
			match = pattern.exec(content);
		}
	}
	return out;
}

function main(): void {
	const root = resolve(import.meta.dir, "..");
	const violations: Violation[] = [];

	for (const relPath of SCHEMA_FILES) {
		const fullPath = resolve(root, relPath);
		const content = readFileSync(fullPath, "utf-8");
		const bodies = findSyncedTableBodies(content);
		for (const { table, body } of bodies) {
			const fkMatch = body.match(/\bFOREIGN\s+KEY\b/i);
			const refMatch = body.match(/\bREFERENCES\b/i);
			if (fkMatch) {
				violations.push({
					file: relPath,
					table,
					keyword: "FOREIGN KEY",
					snippet:
						body
							.split("\n")
							.find((l) => /FOREIGN\s+KEY/i.test(l))
							?.trim() ?? "",
				});
			}
			if (refMatch) {
				violations.push({
					file: relPath,
					table,
					keyword: "REFERENCES",
					snippet:
						body
							.split("\n")
							.find((l) => /REFERENCES/i.test(l))
							?.trim() ?? "",
				});
			}
		}
	}

	if (violations.length === 0) {
		console.log("invariant #20 (no FK on synced tables): clean");
		process.exit(0);
	}

	console.error(
		`invariant #20 (no FK on synced tables) violated: ${violations.length} occurrence(s)\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file} [${v.table}] ${v.keyword}`);
		console.error(`    ${v.snippet.slice(0, 100)}`);
	}
	console.error(
		"\nFix: drop the FK clause. Sync replay inserts rows in non-deterministic order (CONTRIBUTING.md #20).",
	);
	process.exit(1);
}

main();
