#!/usr/bin/env bun
/**
 * Validates read centralization: inline SQL reads (`db.query(...)` /
 * `db.prepare(...)`) should live in the read repository layer
 * (packages/core/src/repositories/), not be scattered across feature code.
 *
 * Enforced as a ratchet against a checked-in baseline
 * (scripts/read-centralization-baseline.json), keyed by file with a per-file
 * count of permitted inline reads:
 *  - A file NOT in the baseline may have ZERO inline reads (new raw reads fail CI).
 *  - A file IN the baseline may have AT MOST its baselined count (the count only
 *    ratchets down — adding a read fails CI).
 *  - When a file is fully migrated to the repository layer, delete its entry.
 *
 * Per-file counts (not file:line) so the baseline survives the line drift that a
 * large read migration produces. Regenerate after bulk migration with:
 *   bun run scripts/validate-read-centralization.ts --write-baseline
 *
 * Run: bun run scripts/validate-read-centralization.ts
 * Wired into: bun check (pre-commit hook)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { Glob } from "bun";

const BASELINE_PATH = "scripts/read-centralization-baseline.json";

/**
 * Locations permitted to issue inline reads: the repository layer itself, the
 * core DB internals that legitimately read raw (change-log snapshots, relay /
 * dispatch local-queue wrappers, schema introspection, sync replay), tests, and
 * the scripts directory.
 */
const EXCLUDED_PATHS = [
	"__tests__",
	"node_modules",
	"dist",
	"packages/core/src/repositories/",
	"packages/core/src/change-log.ts",
	"packages/core/src/relay.ts",
	"packages/core/src/relay-metrics.ts",
	"packages/core/src/dispatch.ts",
	"packages/core/src/schema.ts",
	"packages/core/src/schema-introspection.ts",
	"packages/core/src/metrics-schema.ts",
	"packages/core/src/consistency.ts",
	"packages/sync/src/reducers.ts",
	"scripts/",
];

// Inline SQL read entry points. `db.query(` covers .get()/.all()/.values();
// `db.prepare(` covers prepared reads. Writes are governed by the outbox guard.
// A genuinely raw read may be preceded immediately by a one-line
// `Raw read justification:` comment; that comment exempts exactly one call site.
const READ_PATTERN = /\bdb\.(query|prepare)\s*\(/;
const RAW_READ_JUSTIFICATION_PATTERN = /^\/\/\s*Raw read justification:\s*\S/;

export function shouldExclude(filePath: string): boolean {
	return EXCLUDED_PATHS.some((exc) => path.normalize(filePath).includes(path.normalize(exc)));
}

export function countInlineReads(content: string): number {
	let count = 0;
	let justifiedNextRead = false;
	for (const line of content.split("\n")) {
		const trimmed = line.trimStart();
		if (RAW_READ_JUSTIFICATION_PATTERN.test(trimmed)) {
			justifiedNextRead = true;
			continue;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
		if (!READ_PATTERN.test(line)) {
			if (trimmed !== "") justifiedNextRead = false;
			continue;
		}
		if (justifiedNextRead) {
			justifiedNextRead = false;
			continue;
		}
		count++;
	}
	return count;
}

export type Baseline = Record<string, number>;

export interface ReadCounts {
	[relPath: string]: number;
}

export async function collectCounts(root: string): Promise<ReadCounts> {
	const glob = new Glob("packages/*/src/**/*.ts");
	const counts: ReadCounts = {};
	for await (const relPath of glob.scan({ cwd: root })) {
		if (shouldExclude(relPath)) continue;
		const content = readFileSync(resolve(root, relPath), "utf-8");
		const n = countInlineReads(content);
		if (n > 0) counts[relPath.replace(/\\/g, "/")] = n;
	}
	return counts;
}

export interface Finding {
	file: string;
	count: number;
	allowed: number;
}

export function diffAgainstBaseline(counts: ReadCounts, baseline: Baseline): Finding[] {
	const findings: Finding[] = [];
	for (const [file, count] of Object.entries(counts)) {
		const allowed = baseline[file] ?? 0;
		if (count > allowed) findings.push({ file, count, allowed });
	}
	return findings;
}

export async function main() {
	const root = resolve(import.meta.dir, "..");
	const writeBaseline = process.argv.includes("--write-baseline");

	const counts = await collectCounts(root);

	if (writeBaseline) {
		const sorted = Object.fromEntries(
			Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
		);
		writeFileSync(resolve(root, BASELINE_PATH), `${JSON.stringify(sorted, null, "\t")}\n`);
		const total = Object.values(sorted).reduce((s, n) => s + n, 0);
		console.log(
			`read-centralization baseline written: ${Object.keys(sorted).length} file(s), ${total} inline read(s)`,
		);
		process.exit(0);
	}

	let baseline: Baseline = {};
	try {
		baseline = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf-8")) as Baseline;
	} catch {
		console.warn(`Warning: could not read ${BASELINE_PATH}; treating baseline as empty.`);
	}

	const findings = diffAgainstBaseline(counts, baseline);

	if (findings.length === 0) {
		const remaining = Object.values(baseline).reduce((s, n) => s + n, 0);
		console.log(
			`read centralization: no new inline reads (${remaining} baselined read(s) remaining to migrate)`,
		);
		process.exit(0);
	}

	console.error(
		`read centralization violated: ${findings.length} file(s) exceed their inline-read baseline\n`,
	);
	for (const f of findings) {
		console.error(`  ${f.file}: ${f.count} inline read(s), baseline allows ${f.allowed}`);
	}
	console.error(
		"\nFix: move the new SELECT into packages/core/src/repositories/ (a per-table module, or " +
			"./repositories/queries/ for a cross-table JOIN) and call the typed finder instead.",
	);
	console.error(
		"The baseline only ratchets DOWN — migrate a read out of a file, don't add one in.",
	);
	process.exit(1);
}

if (import.meta.main) {
	main();
}
