#!/usr/bin/env bun
/**
 * Builds tree-sitter-kotlin's native addon AFTER dependency linking completes.
 *
 * Context (release run 45222779309, CI runs 44634982514 / 44642575960):
 * tree-sitter-kotlin@0.3.8 ships NO prebuilds, so its `install: node-gyp-build`
 * lifecycle script falls through to `node-gyp rebuild`. tree-sitter-kotlin is in
 * Bun's default-trusted list (`bun pm default-trusted`), so Bun's isolated linker
 * runs that install script DURING linking — before node-gyp's own dependencies
 * (`tar`, `env-paths`, `nopt`) are symlinked into place. The build then dies with
 * `Cannot find module 'tar'` and `bun install --frozen-lockfile` fails. Every
 * other Tree-sitter grammar ships linux/darwin/win32 prebuilds, so node-gyp-build
 * resolves a prebuild and never invokes node-gyp during linking.
 *
 * The fix removes tree-sitter-kotlin from the trusted set (an explicit
 * `trustedDependencies` in the root package.json that reproduces the rest of the
 * currently-running set) so Bun never runs its install script at link time, and
 * builds the addon here instead. Bun 1.4.5 runs the root `postinstall` only after
 * every dependency is linked, so node-gyp's own dependencies exist by the time
 * this runs and the build cannot race the linker.
 *
 * This is deliberately a plain `node-gyp-build` invocation (the same command the
 * package's own `install` script would have run), not the release staging logic
 * in `scripts/tree-sitter-native-staging.ts`. Staging is Linux-only and rebuilds
 * against pinned Node headers with `NODE_GYP_NODEDIR` for the compiled binary's
 * ABI; this script just reproduces the ordinary dev/CI-test build so
 * `read-structure.ts` can `require("node-gyp-build")(root)` on macOS, Linux, and
 * Windows. On the Linux release path the staging step still rebuilds kotlin
 * deterministically afterward, overwriting whatever this produced — so this must
 * be idempotent and must not conflict with staging.
 *
 * Idempotent: if a `build/Release/*.node` already exists for kotlin, skip. A
 * cold install has none, so the build runs exactly once per fresh install.
 *
 * Run: bun run scripts/build-tree-sitter-kotlin.ts
 * Wired into: root `postinstall`.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");

/**
 * Resolve the installed tree-sitter-kotlin package directory the same way the
 * runtime loader does — through Node resolution from packages/shared, where it
 * is a declared dependency. This follows Bun's isolated-linker symlink into
 * `node_modules/.bun/...`, so the version suffix never has to be hardcoded.
 */
function resolveKotlinPackageRoot(): string | undefined {
	const requireFromShared = createRequire(join(workspaceRoot, "packages/shared/package.json"));
	try {
		return dirname(requireFromShared.resolve("tree-sitter-kotlin/package.json"));
	} catch {
		return undefined;
	}
}

function hasBuiltAddon(packageRoot: string): boolean {
	const releaseDir = join(packageRoot, "build", "Release");
	if (!existsSync(releaseDir)) return false;
	try {
		return readdirSync(releaseDir).some((name) => name.endsWith(".node"));
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	const packageRoot = resolveKotlinPackageRoot();
	if (!packageRoot) {
		// Not installed (e.g. --omit=optional in some context): nothing to build.
		console.log("[build-tree-sitter-kotlin] tree-sitter-kotlin not resolvable; skipping");
		return;
	}
	if (hasBuiltAddon(packageRoot)) {
		console.log(`[build-tree-sitter-kotlin] addon already built at ${packageRoot}; skipping`);
		return;
	}

	// node-gyp-build's bin builds from source when no prebuild/build is present.
	// Resolve it from the kotlin package so we use kotlin's own node-gyp-build.
	const requireFromKotlin = createRequire(join(packageRoot, "package.json"));
	let nodeGypBuildBin: string;
	try {
		nodeGypBuildBin = requireFromKotlin.resolve("node-gyp-build/bin.js");
	} catch {
		throw new Error(
			"[build-tree-sitter-kotlin] node-gyp-build not resolvable from tree-sitter-kotlin; linking incomplete?",
		);
	}

	console.log(`[build-tree-sitter-kotlin] building native addon in ${packageRoot}`);
	const child = Bun.spawn([process.execPath, nodeGypBuildBin], {
		cwd: packageRoot,
		stdout: "inherit",
		stderr: "inherit",
		env: process.env,
	});
	const code = await child.exited;
	if (code !== 0) throw new Error(`[build-tree-sitter-kotlin] node-gyp-build exited ${code}`);
	if (!hasBuiltAddon(packageRoot))
		throw new Error("[build-tree-sitter-kotlin] build produced no build/Release/*.node");
	console.log("[build-tree-sitter-kotlin] native addon built");
}

if (import.meta.main) await main();
