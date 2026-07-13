#!/usr/bin/env bun
/**
 * Validates the outbox invariant: all writes to synced tables must go through
 * insertRow/updateRow/softDelete from @bound/core. Direct SQL mutations
 * (INSERT INTO, UPDATE, DELETE FROM) on synced tables are flagged as violations.
 *
 * Two sanctioned escapes:
 *  - "// outbox-routed": an explicit createChangeLogEntry follows the raw SQL in
 *    the same transaction (scheduler CAS task transitions, cluster_config CLI
 *    commands). The write DOES sync — the changelog row is emitted by hand.
 *  - dangerouslyExecuteRawWrite(db, { sql, params, reason }): the single
 *    sanctioned changelog-EXEMPT bypass. The SQL is allowed when it flows into a
 *    dangerouslyExecuteRawWrite call (inline literal, local `const sql`, or a
 *    named constant passed as the `sql` argument). This replaces the former
 *    per-line "// outbox-exempt" annotation + docs/invariants.md audit-table
 *    cross-check: every intentional bypass now funnels through one greppable
 *    seam whose mandatory `reason` self-documents why it skips the changelog.
 *
 * Run: bun run scripts/validate-outbox-invariant.ts
 * Wired into: bun check (pre-commit hook)
 */

import { readFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { Glob } from "bun";

const SYNCED_TABLES = [
	"users",
	"threads",
	"messages",
	"semantic_memory",
	"tasks",
	"files",
	"hosts",
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

const CHOKEPOINT_CALL_PATTERN = /dangerouslyExecuteRawWrite\s*\(/;

// How many lines below a chokepoint call its argument object can span. The
// call site is `dangerouslyExecuteRawWrite(db, { sql, params, reason })` — a
// generous window covers multi-line reason strings without reaching unrelated code.
const CHOKEPOINT_WINDOW = 10;

export function shouldExclude(filePath: string): boolean {
	return EXCLUDED_PATHS.some((exc) => path.normalize(filePath).includes(path.normalize(exc)));
}

export function shouldSkipLine(line: string): boolean {
	return line.includes("// outbox-routed");
}

export function findTableInLine(line: string): string | null {
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

export interface ChokepointInfo {
	/** Inclusive [start, end] line-index ranges spanned by each chokepoint call's arguments. */
	windows: Array<[number, number]>;
	/** Identifier names passed as the `sql` argument to a chokepoint call (incl. `sql` shorthand). */
	sqlIdentifiers: Set<string>;
}

/**
 * Scan a file for every dangerouslyExecuteRawWrite call. Records the argument
 * window of each (so inline `sql:` literals are recognized) and the set of
 * identifier names handed to the call as its `sql` argument (so a SQL string
 * assigned to a named constant elsewhere — e.g. STALE_TASK_RESET_SQL, or a
 * local `const sql` passed via object shorthand — is recognized too).
 */
export function collectChokepointInfo(lines: string[]): ChokepointInfo {
	const windows: Array<[number, number]> = [];
	const sqlIdentifiers = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		if (!CHOKEPOINT_CALL_PATTERN.test(lines[i])) continue;

		const start = i;
		const end = Math.min(lines.length - 1, i + CHOKEPOINT_WINDOW);
		windows.push([start, end]);

		for (let j = start; j <= end; j++) {
			// `sql: SOME_CONSTANT` — named-constant reference
			const named = lines[j].match(/\bsql\s*:\s*([A-Za-z_$][\w$]*)/);
			if (named) sqlIdentifiers.add(named[1]);
			// `sql,` / `sql` on its own line — object shorthand for a local `const sql`
			if (/^\s*sql\s*,?\s*$/.test(lines[j])) sqlIdentifiers.add("sql");
		}
	}

	return { windows, sqlIdentifiers };
}

/**
 * Returns true when a flagged SQL-mutation line is sanctioned because it flows
 * into a dangerouslyExecuteRawWrite call:
 *  - Case A: the line sits inside a chokepoint call's argument window (inline literal).
 *  - Case B: the line defines a const/let/var whose name is passed as the call's `sql`.
 */
export function isChokepointSanctioned(
	lines: string[],
	index: number,
	info: ChokepointInfo,
): boolean {
	for (const [start, end] of info.windows) {
		if (index >= start && index <= end) return true;
	}

	const def = lines[index].match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
	if (def && info.sqlIdentifiers.has(def[1])) return true;

	return false;
}

export async function main() {
	const root = resolve(import.meta.dir, "..");
	const glob = new Glob("packages/*/src/**/*.ts");
	const violations: Violation[] = [];

	for await (const relPath of glob.scan({ cwd: root })) {
		if (shouldExclude(relPath)) continue;

		const fullPath = resolve(root, relPath);
		const content = readFileSync(fullPath, "utf-8");
		const lines = content.split("\n");
		const chokepointInfo = collectChokepointInfo(lines);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Explicit createChangeLogEntry-in-transaction escape.
			if (shouldSkipLine(line)) continue;

			const table = findTableInLine(line);
			if (!table) continue;

			// Sanctioned changelog-exempt bypass via the single chokepoint.
			if (isChokepointSanctioned(lines, i, chokepointInfo)) continue;

			violations.push({
				file: relPath,
				line: i + 1,
				table,
				text: line.trim().slice(0, 100),
			});
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
		"\nFix: use insertRow/updateRow/softDelete from @bound/core for writes that must sync.",
	);
	console.error(
		"For an intentional changelog-exempt bypass, route the write through dangerouslyExecuteRawWrite(db, { sql, params, reason }).",
	);
	console.error(
		"Or use '// outbox-routed' if an explicit createChangeLogEntry follows in the same transaction.",
	);
	process.exit(1);
}

// Only run main if this is being executed directly
if (import.meta.main) {
	main();
}
