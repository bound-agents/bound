#!/usr/bin/env bun
/**
 * Validates the outbox invariant: all writes to synced tables must go through
 * insertRow/updateRow/softDelete from @bound/core. Direct SQL mutations
 * (INSERT INTO, UPDATE, DELETE FROM) on synced tables are flagged as violations.
 *
 * Lines containing "// outbox-exempt" are skipped (for cluster_config writes
 * that use manual createChangeLogEntry).
 *
 * Run: bun run scripts/validate-outbox-invariant.ts
 * Wired into: bun check (pre-commit hook)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

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
	"turns",
];

const EXCLUDED_PATHS = [
	"__tests__",
	"node_modules",
	"dist",
	"packages/sync/src/reducers.ts",
	"packages/core/src/change-log.ts",
	"packages/core/src/schema.ts",
	"packages/core/src/metrics-schema.ts",
	"packages/web/src/server/embedded-assets.ts",
	"scripts/",
];

const SQL_MUTATION_PATTERN = /["'`]\s*(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+/i;

function shouldExclude(filePath: string): boolean {
	return EXCLUDED_PATHS.some((exc) => filePath.includes(exc));
}

function findTableInLine(line: string): string | null {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return null;

	const match = line.match(SQL_MUTATION_PATTERN);
	if (!match) return null;

	const afterKeyword = line.slice((match.index ?? 0) + match[0].length);
	for (const table of SYNCED_TABLES) {
		const tablePattern = new RegExp(`\\b${table}\\b`);
		if (tablePattern.test(afterKeyword)) return table;
	}
	return null;
}

interface Violation {
	file: string;
	line: number;
	table: string;
	text: string;
}

async function main() {
	const root = resolve(import.meta.dir, "..");
	const glob = new Glob("packages/*/src/**/*.ts");
	const violations: Violation[] = [];

	for await (const relPath of glob.scan({ cwd: root })) {
		if (shouldExclude(relPath)) continue;

		const fullPath = resolve(root, relPath);
		const content = readFileSync(fullPath, "utf-8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.includes("// outbox-exempt")) continue;

			const table = findTableInLine(line);
			if (table) {
				violations.push({
					file: relPath,
					line: i + 1,
					table,
					text: line.trim().slice(0, 100),
				});
			}
		}
	}

	if (violations.length === 0) {
		console.log("outbox invariant: all synced-table writes go through the outbox");
		process.exit(0);
	}

	console.error(
		`outbox invariant violated: ${violations.length} direct write(s) to synced tables\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line} [${v.table}]`);
		console.error(`    ${v.text}`);
	}
	console.error(
		"\nFix: use insertRow/updateRow/softDelete from @bound/core, or add '// outbox-exempt' with justification.",
	);
	process.exit(1);
}

main();
