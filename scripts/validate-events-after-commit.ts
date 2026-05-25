#!/usr/bin/env bun
/**
 * Validates Critical Invariant #6 (CONTRIBUTING.md): events
 * (`file:changed`, `changelog:written`, etc.) MUST fire AFTER
 * `db.exec("COMMIT")`, never during a transaction.
 *
 * Static check: scan source for `eventBus.emit(...)` calls inside
 * blocks bracketed by `db.exec("BEGIN")` / `BEGIN IMMEDIATE` and
 * `db.exec("COMMIT")`.
 *
 * Limitations: this is a textual heuristic. A determined refactor
 * could place an emit inside a helper called from within a
 * transaction and the script wouldn't catch it. The check covers
 * the common case where BEGIN/COMMIT and emit live in the same
 * function body.
 *
 * Run: bun run scripts/validate-events-after-commit.ts
 * Wired into: bun check (pre-commit hook)
 */

import { readFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { Glob } from "bun";

const EXCLUDED_PATHS = ["__tests__", "node_modules", "dist", "scripts/"];

interface Violation {
	file: string;
	beginLine: number;
	emitLine: number;
	snippet: string;
}

function shouldExclude(filePath: string): boolean {
	return EXCLUDED_PATHS.some((exc) => path.normalize(filePath).includes(path.normalize(exc)));
}

function findViolations(filePath: string, content: string): Violation[] {
	const lines = content.split("\n");
	const violations: Violation[] = [];

	// Find all BEGIN / COMMIT pairs by scanning line by line.
	// Track depth so nested transactions still work.
	let beginLine: number | null = null;
	let depth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip comments
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

		// db.exec("BEGIN ...") opens a transaction
		if (/db\.(exec|run)\(['"`]BEGIN(\s+IMMEDIATE)?['"`]/.test(line)) {
			if (depth === 0) beginLine = i + 1;
			depth++;
			continue;
		}

		// db.exec("COMMIT") closes a transaction
		if (/db\.(exec|run)\(['"`]COMMIT['"`]/.test(line)) {
			depth = Math.max(0, depth - 1);
			if (depth === 0) beginLine = null;
			continue;
		}

		// db.exec("ROLLBACK") also closes
		if (/db\.(exec|run)\(['"`]ROLLBACK['"`]/.test(line)) {
			depth = Math.max(0, depth - 1);
			if (depth === 0) beginLine = null;
			continue;
		}

		// emit inside an open transaction is a violation
		if (depth > 0 && beginLine !== null && /eventBus\.emit\s*\(/.test(line)) {
			violations.push({
				file: filePath,
				beginLine,
				emitLine: i + 1,
				snippet: line.trim().slice(0, 100),
			});
		}
	}

	return violations;
}

async function main() {
	const root = resolve(import.meta.dir, "..");
	const glob = new Glob("packages/*/src/**/*.ts");
	const violations: Violation[] = [];

	for await (const relPath of glob.scan({ cwd: root })) {
		if (shouldExclude(relPath)) continue;

		const fullPath = resolve(root, relPath);
		const content = readFileSync(fullPath, "utf-8");
		violations.push(...findViolations(relPath, content));
	}

	if (violations.length === 0) {
		console.log("invariant #6 (events after commit): clean");
		process.exit(0);
	}

	console.error(
		`invariant #6 (events after commit) violated: ${violations.length} emit(s) inside transactions\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.emitLine} (transaction opened at line ${v.beginLine})`);
		console.error(`    ${v.snippet}`);
	}
	console.error(
		"\nFix: hoist the emit AFTER the COMMIT call. Listeners must not observe uncommitted state.",
	);
	process.exit(1);
}

main();
