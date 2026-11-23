#!/usr/bin/env bun
/**
 * Validates that tree-sitter-kotlin's native addon is NOT built during Bun's
 * isolated-linking phase, so it can never race the linker.
 *
 * Context (release run 45222779309, CI runs 44634982514 / 44642575960):
 * tree-sitter-kotlin@0.3.8 ships NO prebuilds and is in Bun's default-trusted
 * list (`bun pm default-trusted`). With no explicit `trustedDependencies`, Bun
 * runs its `install: node-gyp-build` script during linking; with no prebuild to
 * resolve, node-gyp-build falls through to `node-gyp rebuild`, which the linker
 * starts before node-gyp's own dependencies (`tar`, `env-paths`, `nopt`) are
 * symlinked — so the build dies with `Cannot find module 'tar'` and
 * `bun install --frozen-lockfile` fails intermittently on cold caches.
 *
 * The fix declares an explicit `trustedDependencies` in the root package.json.
 * That list REPLACES Bun's default-trusted list entirely (verified against Bun
 * 1.4.5), so any scripted dependency not named in it has its lifecycle script
 * blocked at link time. By reproducing the rest of the currently-running set and
 * omitting tree-sitter-kotlin, kotlin's install script no longer runs during
 * linking. kotlin's native addon is instead built from the root `postinstall`
 * (via `scripts/build-tree-sitter-kotlin.ts`), which Bun runs only after every
 * dependency is linked.
 *
 * This script guards the invariant statically (no install, no agent loop):
 *   1. `trustedDependencies` exists and does NOT contain tree-sitter-kotlin.
 *   2. The root `postinstall` invokes the kotlin native build script, so the
 *      addon still gets built after linking.
 *
 * If a future change re-adds tree-sitter-kotlin to the trusted set, or drops the
 * postinstall build, this fails loudly with the reason.
 *
 * Run: bun run scripts/validate-kotlin-not-link-built.ts
 * Wired into: bun check (pre-commit / CI gate).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const packageJsonPath = resolve(workspaceRoot, "package.json");

interface RootPackageJson {
	trustedDependencies?: unknown;
	scripts?: Record<string, string>;
}

function fail(message: string): never {
	console.error(`[validate-kotlin-not-link-built] ${message}`);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as RootPackageJson;

const trusted = pkg.trustedDependencies;
if (!Array.isArray(trusted))
	fail(
		"package.json must declare an explicit `trustedDependencies` array. Without it, Bun's " +
			"default-trusted list runs tree-sitter-kotlin's install script during linking, racing node-gyp " +
			"against still-linking dependencies.",
	);

if (trusted.includes("tree-sitter-kotlin"))
	fail(
		"tree-sitter-kotlin must NOT be in `trustedDependencies`: it ships no prebuilds, so its install " +
			"script runs `node-gyp rebuild` during linking and races node-gyp's own dependencies. Build it " +
			"from the root postinstall instead (scripts/build-tree-sitter-kotlin.ts).",
	);

const postinstall = pkg.scripts?.postinstall ?? "";
if (!postinstall.includes("scripts/build-tree-sitter-kotlin.ts"))
	fail(
		"root `postinstall` must run scripts/build-tree-sitter-kotlin.ts so kotlin's native addon is built " +
			"after linking completes (it is no longer built at link time).",
	);

console.log(
	"[validate-kotlin-not-link-built] OK: tree-sitter-kotlin excluded from trustedDependencies; " +
		"postinstall builds it after linking",
);
