#!/usr/bin/env bun
/**
 * Runs the test suites for only the packages affected by the staged diff,
 * expanded across workspace reverse-dependencies so a change to a depended-on
 * package (e.g. @bound/shared) also tests its consumers.
 *
 * The full suite is serial and ~150s; gating every commit on all of it is a
 * non-starter. This scopes the pre-commit test gate to what the diff can break.
 *
 * Classification:
 *   - packages/<X>/...            -> package X is directly affected
 *   - a global file (bunfig.toml, root package.json, root tsconfig*, the test
 *     preload, this script, the hook itself) -> ALL packages affected
 *   - anything else (docs, .github, etc.) -> ignored
 *
 * The directly-affected set is expanded to include every package that
 * transitively depends on a directly-affected package, then `bun test` runs
 * once over the union of their source dirs.
 *
 * Run:           bun run scripts/test-affected.ts
 * Inspect only:  bun run scripts/test-affected.ts --dry-run
 * Wired into:    .githooks/pre-commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

export interface WorkspaceGraph {
	/** package name (e.g. "@bound/agent") -> package dir (e.g. "packages/agent") */
	nameToDir: Map<string, string>;
	/** package dir -> set of @bound/* package names it depends on */
	deps: Map<string, Set<string>>;
	/** package dir -> set of package dirs that depend on it (direct) */
	dependents: Map<string, Set<string>>;
}

/**
 * Files outside any package that invalidate every package's test outcome when
 * changed (test infrastructure, dependency versions, base compiler config).
 * Note: the hook script and this selector are deliberately NOT here — they
 * cannot change a package test's result, only which tests are selected, and
 * the selector's own behavior is guarded by the scripts test suite (run via
 * shouldRunScriptsTests).
 */
const GLOBAL_FILE_PATTERNS = [
	"bunfig.toml",
	"package.json",
	"bun.lock",
	"bun.lockb",
	"tsconfig.json",
	"tsconfig.base.json",
	"scripts/test-preload.ts",
];

export function buildWorkspaceGraph(root: string): WorkspaceGraph {
	const nameToDir = new Map<string, string>();
	const deps = new Map<string, Set<string>>();

	const pkgGlob = new Glob("packages/*/package.json");
	for (const rel of pkgGlob.scanSync({ cwd: root })) {
		const dir = rel.replace(/\/package\.json$/, "");
		const pkg = JSON.parse(readFileSync(resolve(root, rel), "utf8")) as {
			name?: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		if (!pkg.name) continue;
		nameToDir.set(pkg.name, dir);
		const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
		const boundDeps = new Set<string>();
		for (const depName of Object.keys(allDeps)) {
			if (depName.startsWith("@bound/") && depName !== pkg.name) {
				boundDeps.add(depName);
			}
		}
		deps.set(dir, boundDeps);
	}

	// Invert into a dir -> dependent-dirs map.
	const dependents = new Map<string, Set<string>>();
	for (const dir of deps.keys()) dependents.set(dir, new Set());
	for (const [dir, depNames] of deps) {
		for (const depName of depNames) {
			const depDir = nameToDir.get(depName);
			if (depDir) dependents.get(depDir)?.add(dir);
		}
	}

	return { nameToDir, deps, dependents };
}

/** True if a changed file forces the whole workspace to be retested. */
export function isGlobalFile(file: string): boolean {
	return GLOBAL_FILE_PATTERNS.includes(file);
}

/** Maps a changed file to its package dir, or null if it is not inside a package. */
export function packageDirForFile(file: string): string | null {
	const m = file.match(/^(packages\/[^/]+)\//);
	return m ? m[1] : null;
}

/**
 * True if any changed file lives under scripts/, meaning the scripts test
 * suite (which guards this selector itself) should run. Kept separate from the
 * package graph because scripts/ is not a workspace package.
 */
export function shouldRunScriptsTests(changedFiles: string[]): boolean {
	return changedFiles.some((f) => f.startsWith("scripts/"));
}

/**
 * Given the changed files and the workspace graph, returns the set of package
 * dirs whose tests should run. A global file change returns every package.
 * Otherwise, directly-changed packages are expanded across transitive
 * dependents.
 */
export function determineAffectedPackages(
	changedFiles: string[],
	graph: WorkspaceGraph,
): Set<string> {
	const allDirs = new Set(graph.deps.keys());

	if (changedFiles.some(isGlobalFile)) {
		return allDirs;
	}

	const directlyAffected = new Set<string>();
	for (const file of changedFiles) {
		const dir = packageDirForFile(file);
		if (dir && allDirs.has(dir)) directlyAffected.add(dir);
	}

	// Transitive closure over dependents: if X changed, anything depending on X
	// (and anything depending on those, etc.) must also be tested.
	const affected = new Set<string>(directlyAffected);
	const queue = [...directlyAffected];
	while (queue.length > 0) {
		const dir = queue.pop();
		if (!dir) continue;
		for (const dependent of graph.dependents.get(dir) ?? []) {
			if (!affected.has(dependent)) {
				affected.add(dependent);
				queue.push(dependent);
			}
		}
	}

	return affected;
}

function stagedFiles(root: string): string[] {
	const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
		cwd: root,
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git diff --cached failed: ${new TextDecoder().decode(proc.stderr)}`);
	}
	return new TextDecoder()
		.decode(proc.stdout)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

export function run(): void {
	const root = resolve(import.meta.dir, "..");
	const dryRun = process.argv.includes("--dry-run");

	const graph = buildWorkspaceGraph(root);
	const changed = stagedFiles(root);
	const affected = determineAffectedPackages(changed, graph);

	const dirs = [...affected].sort();
	if (shouldRunScriptsTests(changed)) dirs.push("scripts");

	if (dirs.length === 0) {
		console.log("test-affected: no testable sources staged — skipping tests.");
		process.exit(0);
	}

	const pkgCount = affected.size;
	const isFull = pkgCount === graph.deps.size;
	console.log(
		`test-affected: ${dirs.length} test dir(s)${
			isFull ? " (full package suite — a global file changed)" : ""
		}:`,
	);
	for (const dir of dirs) console.log(`  - ${dir}`);

	if (dryRun) {
		process.exit(0);
	}

	if (isFull) {
		// Global-file change: every package's tests need to run. Bun v1.3.14's
		// filter mode rejects a list of plain package dirs as "no test files
		// matched" (per CONTRIBUTING's "Common Gotchas" — tests need
		// `.test`/`_test_`/`.spec`/`_spec_` in the filename), so iterate per
		// dir: each `bun test <dir>` walks into `src/__tests__/` and runs
		// matches. Per-dir exit code is preserved; the partial case (3
		// packages) is unaffected — it never trips the global-file branch.
		let lastExit = 0;
		for (const dir of dirs) {
			const proc = Bun.spawnSync(["bun", "test", dir], {
				cwd: root,
				stdout: "inherit",
				stderr: "inherit",
			});
			if ((proc.exitCode ?? 1) !== 0) lastExit = proc.exitCode ?? 1;
		}
		process.exit(lastExit);
	}

	const proc = Bun.spawnSync(["bun", "test", ...dirs], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(proc.exitCode ?? 1);
}

if (import.meta.main) {
	run();
}
