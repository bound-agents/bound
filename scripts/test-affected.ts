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
 * Two-layer selection. The package set above comes from the STAGED diff and is
 * the correctness floor. Within it, `bun test --changed` drops test files the
 * change cannot reach through the import graph — the file-level filter a
 * package-level graph walk cannot express (a one-line edit in @bound/shared
 * expands to all 12 packages by dependency, while only a couple of test files
 * import the touched module: measured 2/535 files vs 12 whole packages).
 *
 * `--changed` compares the WORKING TREE, not the index, so it is only ever a
 * narrowing layer over the staged determination. Partial staging (`git add -p`)
 * leaves the working tree a superset of the index, erring toward running MORE
 * tests. A global-file change skips the narrowing entirely: when bunfig or the
 * lockfile moves, every test is in scope regardless of what imports what.
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

/**
 * Derives a package dir from a `packages/*\/package.json` glob match. Bun.Glob
 * yields OS-native separators — backslashes on Windows — so normalize to forward
 * slashes before stripping. This keeps graph keys consistent with git's
 * always-forward-slash paths (which `packageDirForFile` matches against) and with
 * `toTestPathArg`'s `./`-prefixed args; without it, every Windows graph key keeps
 * its `\package.json` suffix, `allDirs.has("packages/x")` always misses, and the
 * global-file branch emits `bun test ./packages\x\package.json` (matches nothing).
 */
export function pkgDirFromGlobMatch(rel: string): string {
	return rel.replaceAll("\\", "/").replace(/\/package\.json$/, "");
}

export function buildWorkspaceGraph(root: string): WorkspaceGraph {
	const nameToDir = new Map<string, string>();
	const deps = new Map<string, Set<string>>();

	const pkgGlob = new Glob("packages/*/package.json");
	for (const rel of pkgGlob.scanSync({ cwd: root })) {
		const dir = pkgDirFromGlobMatch(rel);
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
 * `bun test <arg>` treats a bare arg as a NAME filter unless it already looks
 * like a path. A single-segment dir such as "scripts" therefore matches no
 * test files ("did not match any test files: scripts") and the gate exits 1,
 * while "packages/foo" happens to work only because the embedded slash makes
 * bun read it as a path. Prefix every dir with "./" so it is unambiguously a
 * path regardless of segment count — a no-op for the package dirs and the fix
 * for "scripts". Absolute / already-relative paths pass through untouched.
 */
export function toTestPathArg(dir: string): string {
	return dir.startsWith("./") || dir.startsWith("/") ? dir : `./${dir}`;
}

/**
 * True if a package directory contains any test files (files with `.test`,
 * `_test_`, `.spec`, or `_spec_` in the name). Package dirs without test files
 * (e.g. `packages/docs`) are skipped so `bun test` doesn't exit non-zero
 * on "did not match any test files".
 */
export function hasTestFiles(dir: string, root: string): boolean {
	const glob = new Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
	for (const _ of glob.scanSync({ cwd: resolve(root, dir) })) return true;
	return false;
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

	const testableDirs = dirs.filter((d) => hasTestFiles(d, root));
	const scriptsHaveTests = shouldRunScriptsTests(changed) && hasTestFiles("scripts", root);
	if (scriptsHaveTests) testableDirs.push("scripts");

	if (testableDirs.length === 0) {
		console.log("test-affected: no testable sources staged — skipping tests.");
		process.exit(0);
	}

	const pkgCount = affected.size;
	const isFull = pkgCount === graph.deps.size;
	const skipped = dirs.filter((d) => !testableDirs.includes(d));
	console.log(
		`test-affected: ${testableDirs.length} test dir(s)${
			isFull ? " (full package suite — a global file changed)" : ""
		}:`,
	);
	for (const dir of testableDirs) console.log(`  - ${dir}`);
	if (skipped.length > 0) {
		console.log(`test-affected: ${skipped.length} dir(s) skipped (no test files):`);
		for (const dir of skipped) console.log(`  - ${dir}`);
	}

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
		for (const dir of testableDirs) {
			const proc = Bun.spawnSync(["bun", "test", toTestPathArg(dir)], {
				cwd: root,
				stdout: "inherit",
				stderr: "inherit",
			});
			const exitCode = proc.exitCode ?? 1;
			if (exitCode !== 0) {
				console.error(`test-affected: ${dir} exited ${exitCode}`);
				lastExit = exitCode;
			}
		}
		process.exit(lastExit);
	}

	// Narrow within the selected dirs by import-graph reachability. The dirs come
	// from the STAGED diff (authoritative for what this commit ships); `--changed`
	// then drops test files in those dirs that the change cannot reach, which is a
	// file-level filter the package-level graph walk above cannot express: a
	// one-line edit in @bound/shared expands to all 12 packages by dependency, but
	// only a couple of test files actually import the touched module.
	//
	// `--changed` reads the WORKING TREE, not the index, so it is a narrowing
	// layer and never the gate itself. Partial staging (`git add -p`) leaves the
	// working tree a superset of the index, so it errs toward running MORE tests.
	// The global-file branch above deliberately skips it: when bunfig/lockfile
	// moves, every test is in scope regardless of what imports what.
	//
	// "no test files are affected" exits 0, so a dir whose tests are all
	// unreachable is not a failure.
	const proc = Bun.spawnSync(["bun", "test", ...testableDirs.map(toTestPathArg), "--changed"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(proc.exitCode ?? 1);
}

if (import.meta.main) {
	run();
}
