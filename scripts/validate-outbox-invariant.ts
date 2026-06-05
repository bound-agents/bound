#!/usr/bin/env bun
/**
 * Validates the outbox invariant: all writes to synced tables must go through
 * insertRow/updateRow/softDelete from @bound/core. Direct SQL mutations
 * (INSERT INTO, UPDATE, DELETE FROM) on synced tables are flagged as violations.
 *
 * Lines containing "// outbox-exempt" are cross-checked against CONTRIBUTING.md.
 * Lines containing "// outbox-routed" are skipped (explicit createChangeLogEntry pattern).
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

export function shouldExclude(filePath: string): boolean {
	return EXCLUDED_PATHS.some((exc) => path.normalize(filePath).includes(path.normalize(exc)));
}

export function shouldSkipLine(line: string): boolean {
	return line.includes("// outbox-routed") || line.includes("// outbox-exempt");
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

export function extractAuditSection(content: string): string {
	const match = content.match(
		/### Audit Disposition Table for `outbox-exempt` Annotations([\s\S]*?)(?=###|\z)/,
	);
	return match ? match[1] : "";
}

export function cleanLineNumber(linePart: string): number {
	// Strip trailing (REWRITTEN) or (REMOVED) markers before parsing
	return Number.parseInt(linePart.replace(/\s*\(.*?\)\s*$/, ""));
}

export function isExemptionDocumented(
	filePath: string,
	lineNumber: number,
	table: string,
	contributing: string,
): boolean {
	const auditSection = extractAuditSection(contributing);
	if (!auditSection) return false;

	// Check if the table is NOT in SYNCED_TABLES (category c)
	if (!SYNCED_TABLES.includes(table)) {
		return true;
	}

	// Glob uses OS-native separators; CONTRIBUTING.md always uses "/".
	// Normalise before comparison so the check works on Windows too.
	const normalizedPath = filePath.replace(/\\/g, "/");

	// Parse audit table rows (very basic markdown table parsing)
	const lines = auditSection.split("\n");
	for (const line of lines) {
		if (!line.includes("|")) continue;

		const cells = line.split("|").map((c) => c.trim());
		if (cells.length < 3) continue;

		const fileLoc = cells[1]; // File:Line or File
		const tableMatch = cells[2]; // Table write target

		if (!fileLoc || !tableMatch) continue;

		// Try to match file:line exactly
		if (fileLoc.includes(":")) {
			const [matchFile, matchLineStr] = fileLoc.split(":");
			const matchLine = cleanLineNumber(matchLineStr);
			if (
				normalizedPath.endsWith(matchFile.trim()) &&
				matchLine === lineNumber &&
				tableMatch.includes(table)
			) {
				return true;
			}
		} else if (normalizedPath.endsWith(fileLoc.trim()) && tableMatch.includes(table)) {
			// Match by file path only
			return true;
		}
	}

	return false;
}

export function hasToDoLink(lines: string[], centerIndex: number): boolean {
	return lines
		.slice(Math.max(0, centerIndex - 5), Math.min(lines.length, centerIndex + 6))
		.some((l) => l.includes("TODO"));
}

export async function main() {
	const root = resolve(import.meta.dir, "..");
	const glob = new Glob("packages/*/src/**/*.ts");
	const violations: Violation[] = [];

	// Read CONTRIBUTING.md once
	let contributing = "";
	try {
		contributing = readFileSync(resolve(root, "CONTRIBUTING.md"), "utf-8");
	} catch {
		console.warn("Warning: Could not read CONTRIBUTING.md for cross-check validation");
	}

	for await (const relPath of glob.scan({ cwd: root })) {
		if (shouldExclude(relPath)) continue;

		const fullPath = resolve(root, relPath);
		const content = readFileSync(fullPath, "utf-8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Skip outbox-routed and outbox-exempt lines (both are permitted)
			if (shouldSkipLine(line)) {
				// If it's outbox-exempt, validate it
				if (line.includes("// outbox-exempt")) {
					const table = findTableInLine(line);
					if (!table) continue;

					// Check for TODO link (category d validation)
					const hasTodoLink = hasToDoLink(lines, i);

					// Check if documented in CONTRIBUTING.md
					const isDocumented = isExemptionDocumented(relPath, i + 1, table, contributing);

					if (!isDocumented && !hasTodoLink) {
						violations.push({
							file: relPath,
							line: i + 1,
							table,
							text: line.trim().slice(0, 100),
						});
					}
				}
				continue;
			}

			const table = findTableInLine(line);
			if (!table) continue;

			// No annotation: violation
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
		"\nFix: use insertRow/updateRow/softDelete from @bound/core, or add '// outbox-exempt' with CONTRIBUTING.md entry.",
	);
	console.error(
		"Or use '// outbox-routed' if explicit createChangeLogEntry follows in the transaction.",
	);
	process.exit(1);
}

// Only run main if this is being executed directly
if (import.meta.main) {
	main();
}
