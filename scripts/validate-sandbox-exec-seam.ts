#!/usr/bin/env bun
/**
 * Validates the sandbox exec seam (#308, #319): `createSandbox` in
 * packages/sandbox/src/sandbox-factory.ts is the only place that constructs a
 * just-bash `Bash`, and it forces `rawScript: true` on every exec. just-bash's
 * default script normalization `trimStart()`s every non-heredoc line without
 * tracking quotes, so a `Bash` built anywhere else silently drops indentation
 * inside quoted multiline arguments.
 *
 * Fails on, in packages/*\/src (excluding __tests__):
 *  - any `new Bash(` outside the seam file;
 *  - any `rawScript` / `withRawScript` reference outside the seam file (the flag
 *    is the seam's job; a caller-side flag means a second, forgettable seam).
 *
 * The allowlist is empty by design. Fix a violation by routing the caller
 * through `createSandbox`, not by allowlisting it.
 *
 * Run: bun run scripts/validate-sandbox-exec-seam.ts
 * Wired into: bun check (pre-commit hook)
 */

import { readFileSync } from "node:fs";
import path, { resolve } from "node:path";
import { Glob } from "bun";

export const SEAM_PATH = "packages/sandbox/src/sandbox-factory.ts";

/** Files permitted to construct `Bash` or reference `rawScript`. Keep empty. */
export const ALLOWLIST: readonly string[] = [];

const EXCLUDED_PATHS = ["__tests__", "node_modules", "dist"];

const NEW_BASH_PATTERN = /\bnew\s+Bash\s*\(/;
const RAW_SCRIPT_PATTERN = /\b(withRawScript|rawScript)\b/;

export type ViolationKind = "new-bash" | "raw-script";

export interface Violation {
	file: string;
	line: number;
	kind: ViolationKind;
	text: string;
}

function normalize(p: string): string {
	return p.replace(/\\/g, "/");
}

export function shouldExclude(filePath: string): boolean {
	return EXCLUDED_PATHS.some((exc) => path.normalize(filePath).includes(path.normalize(exc)));
}

export function isPermitted(relPath: string): boolean {
	const p = normalize(relPath);
	return p === SEAM_PATH || ALLOWLIST.includes(p);
}

export function findViolations(relPath: string, content: string): Violation[] {
	if (isPermitted(relPath)) return [];
	const file = normalize(relPath);
	const out: Violation[] = [];
	content.split("\n").forEach((text, i) => {
		if (NEW_BASH_PATTERN.test(text)) out.push({ file, line: i + 1, kind: "new-bash", text });
		if (RAW_SCRIPT_PATTERN.test(text)) out.push({ file, line: i + 1, kind: "raw-script", text });
	});
	return out;
}

export async function collectViolations(root: string): Promise<Violation[]> {
	const glob = new Glob("packages/*/src/**/*.{ts,tsx}");
	const violations: Violation[] = [];
	for await (const relPath of glob.scan({ cwd: root })) {
		if (shouldExclude(relPath)) continue;
		const content = readFileSync(resolve(root, relPath), "utf-8");
		violations.push(...findViolations(relPath, content));
	}
	return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export async function main() {
	const root = resolve(import.meta.dir, "..");
	const violations = await collectViolations(root);

	if (violations.length === 0) {
		console.log(`sandbox exec seam: every just-bash Bash is built by ${SEAM_PATH}`);
		process.exit(0);
	}

	console.error(`sandbox exec seam violated: ${violations.length} finding(s)\n`);
	for (const v of violations) {
		const what = v.kind === "new-bash" ? "constructs just-bash Bash" : "references rawScript";
		console.error(`  ${v.file}:${v.line}: ${what}: ${v.text.trim()}`);
	}
	console.error(
		"\nFix: get the shell from createSandbox() in @bound/sandbox. It forces rawScript: true " +
			"on every exec (#308); a Bash built elsewhere drops quoted indentation silently.",
	);
	process.exit(1);
}

if (import.meta.main) {
	main();
}
