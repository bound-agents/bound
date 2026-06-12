#!/usr/bin/env bun
// Build script for Bound
// Builds web assets (with embedded SPA) and compiles all binaries.
//
// All binaries are compiled programmatically via `Bun.build` (not the CLI)
// because every binary that imports `@opentelemetry/exporter-trace-otlp-http`
// (transitively via `@bound/shared`'s telemetry init) needs the
// `otel-esnext-resolver` plugin, and `bun build --compile` does not accept
// plugin config. The `bound` binary additionally needs the just-bash worker
// path rewrite — see materializeSandboxRuntime() and
// scripts/build-sandbox-runtime.ts.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";

/**
 * Many @opentelemetry packages lack an `exports` field and only declare
 * top-level `main`/`module`/`esnext` fields. Bun picks `module` (build/esm/)
 * which is ES5-downcompiled and uses `__extends` + `_super.call(this)`. When
 * the parent class comes from a package that DOES have `exports` (resolved to
 * a native ES `class` via the `esnext` condition), calling it without `new`
 * throws:
 *
 *   "Cannot call a class constructor OTLPExporterBase without |new|"
 *
 * Fix: when loading any file from an otel `build/esm/` directory, substitute
 * the contents from the equivalent `build/esnext/` file which uses native
 * class syntax throughout. Required by every binary that initializes OTel
 * (see `initTelemetry` in `@bound/shared`).
 */
function otelEsnextResolverPlugin(): BunPlugin {
	return {
		name: "otel-esnext-resolver",
		setup(build) {
			build.onLoad({ filter: /@opentelemetry\/[^/]+\/build\/esm\// }, (args) => {
				const esnextPath = args.path.replace("/build/esm/", "/build/esnext/");
				if (existsSync(esnextPath)) {
					return {
						contents: readFileSync(esnextPath, "utf8"),
						loader: "js",
					};
				}
			});
		},
	};
}

/**
 * Rewrite just-bash's `python3-*.js`, `js-exec-*.js`, and sqlite3 worker
 * spawn sites so `new Worker(...)` calls target our materialized on-disk
 * workers instead of the `/$bunfs/.../chunks/worker.js` paths the chunks
 * would otherwise compute (which Bun-compile does not populate; see
 * fix/sandbox-worker-assets). Only the `bound` binary spawns these workers.
 */
function justBashWorkerRewritePlugin(): BunPlugin {
	return {
		name: "rewrite-just-bash-worker-paths",
		setup(build) {
			// Filter by chunks/ path pattern rather than absolute path
			// so the build works identically on fresh clones and in CI.
			// Chunks have Bun's content-hash suffix (uppercase alnum);
			// this excludes literal siblings like `js-exec-worker.js`
			// that lack the hash suffix.
			const filterFor = (prefix: string) =>
				new RegExp(`dist/bundle/chunks/${prefix}-[A-Z0-9]+\\.js$`);

			const rewriteChunk = (
				kind: "python" | "jsExec",
				chunkPrefix: string,
				workerFilenames: string[],
			) => {
				build.onLoad({ filter: filterFor(chunkPrefix) }, (args) => {
					const src = readFileSync(args.path, "utf8");
					// Each chunk constructs the worker URL via
					//   new URL("./<workerFile>", import.meta.url)
					// (possibly wrapped in a minified fileURLToPath
					// binding that we can't match by name). We target
					// just the URL construction and swap it for a
					// file:// URL pointing at our materialized worker.
					// The downstream fileURLToPath wrapper then
					// correctly converts it back to an OS path.
					const candidates = workerFilenames.flatMap((f) => [
						`new URL("./${f}",import.meta.url)`,
						`new URL("./${f}", import.meta.url)`,
					]);
					const needle = candidates.find((c) => src.includes(c));
					if (!needle) {
						throw new Error(
							`just-bash ${kind} chunk at ${args.path} no longer contains a recognized new URL("./...", import.meta.url) pattern; upstream layout changed. Searched for: ${workerFilenames.join(", ")}`,
						);
					}
					// Build a file:// URL from the materialized path at
					// runtime. Using pathToFileURL would be cleaner but
					// we don't want to inject another import into the
					// minified chunk — a simple string concat is fine
					// since materialized paths are always absolute and
					// have no characters requiring escape on macOS/Linux.
					const replacement = `new URL("file://" + (globalThis.__boundSandboxWorkerPath__?.("${kind}") ?? (()=>{throw new Error("sandbox worker path not materialized; createSandbox() must run before just-bash commands")})()))`;
					return {
						contents: src.replace(needle, replacement),
						loader: "js",
					};
				});
			};
			rewriteChunk("python", "python3", ["worker.js"]);
			rewriteChunk("jsExec", "js-exec", ["worker.js", "js-exec-worker.js"]);

			// sqlite3's impl chunk uses a different pattern: a
			// `findWorkerPath` function that searches candidate paths
			// via existsSync. We inject a global bridge check at the
			// top of that function so it returns the materialized path
			// immediately.
			//
			// The regex matches the structural shape of findWorkerPath:
			//   function <id>(<param> = <fn>(<fn>(import.meta.url))) {
			// This is resilient to identifier renaming by minifiers
			// while anchoring on `import.meta.url` (syntax, not an
			// identifier) and the function-with-default-param shape.
			build.onLoad({ filter: /dist\/bundle\/chunks\/chunk-[A-Z0-9]+\.js$/ }, (args) => {
				const src = readFileSync(args.path, "utf8");
				// Only target the chunk that contains the sqlite3 worker spawner.
				if (!src.includes('"sqlite3-worker.js"')) return undefined;

				// Match: function <id>(<param>=<fn>(<fn>(import.meta.url))){
				// The double-wrap (dirname(fileURLToPath(import.meta.url)))
				// is the structural signature of findWorkerPath.
				const pattern =
					/(function\s+\w+\s*\(\s*\w+\s*=\s*\w+\s*\(\s*\w+\s*\(\s*import\.meta\.url\s*\)\s*\)\s*\)\s*\{)/;
				const match = pattern.exec(src);
				if (!match) {
					throw new Error(
						`sqlite3 impl chunk at ${args.path} no longer contains the expected findWorkerPath pattern (function with import.meta.url default param); upstream layout changed`,
					);
				}
				// Inject early-return from the global bridge immediately
				// after the function's opening brace.
				const injection =
					'const __bp=globalThis.__boundSandboxWorkerPath__?.("sqlite3");if(__bp)return __bp;';
				return {
					contents: src.replace(match[1], match[1] + injection),
					loader: "js",
				};
			});
		},
	};
}

/**
 * Stub out `node-pty` so the bare `import pty from 'node-pty'` in
 * `@microsoft/mxc-sdk` resolves to a no-op module instead of the real one.
 *
 * Why this is necessary: the mxc SDK imports node-pty at module top level
 * (sandbox.js:3, state-aware.js:3). node-pty's index.js, at module-eval,
 * loads its native addon via `loadNativeModule('pty')` (lib/utils.js), which
 * does a DYNAMIC, string-concatenated `require("prebuilds/<plat>-<arch>/pty.node")`.
 * `bun build --compile` only embeds `.node` files it can resolve statically,
 * so that concatenated path is invisible to it and `pty.node` never rides into
 * the binary. At runtime the require resolves against `/$bunfs/root/` and
 * throws `Failed to load native module: pty.node` — crashing boundless at
 * startup, before any `usePty:false` runtime decision can route around it.
 *
 * Why a stub is correct (not a workaround): boundless ALWAYS spawns sandboxed
 * commands via child_process (`spawnSandboxFromConfig(config, { usePty: false })`
 * in packages/less/src/tools/sandbox.ts), so the PTY path is never taken — the
 * SDK only dereferences `pty.spawn` inside the PTY function, never at
 * module-eval. node-pty is pure dead weight in the binary; it only needs to not
 * crash on import. node-pty is reachable solely via mxc-sdk (`bun pm why`
 * confirms the single chain), so nothing else in boundless is affected. The
 * stub's `spawn` throws loudly if the PTY path is ever taken.
 */
function stubNodePtyPlugin(): BunPlugin {
	return {
		name: "stub-node-pty",
		setup(build) {
			build.onResolve({ filter: /^node-pty$/ }, () => ({
				path: "node-pty",
				namespace: "stub-node-pty",
			}));
			build.onLoad({ filter: /.*/, namespace: "stub-node-pty" }, () => ({
				contents: `
const unavailable = () => {
	throw new Error(
		"node-pty is stubbed in the boundless binary; PTY-mode sandbox spawning is unavailable. The mxc filesystem sandbox spawns via child_process (usePty:false).",
	);
};
export const spawn = unavailable;
export default { spawn: unavailable };
`,
				loader: "js",
			}));
		},
	};
}

interface CompileBinaryOptions {
	/**
	 * Apply the just-bash / sqlite3 worker rewrite plugin. Only `bound`
	 * spawns these workers; other binaries don't import the sandbox.
	 */
	rewriteJustBashWorkers?: boolean;
	/**
	 * Stub out `node-pty`. Only `boundless` imports it (transitively via
	 * `@microsoft/mxc-sdk`), and its native addon can't ride into a
	 * `bun build --compile` binary — see `stubNodePtyPlugin`.
	 */
	stubNodePty?: boolean;
}

async function compileBinary(
	entrypoint: string,
	outfile: string,
	options: CompileBinaryOptions = {},
): Promise<void> {
	const plugins: BunPlugin[] = [otelEsnextResolverPlugin()];
	if (options.rewriteJustBashWorkers) {
		const manifestPath = resolve("packages/sandbox/src/_runtime/manifest.json");
		if (!existsSync(manifestPath)) {
			throw new Error(
				`Sandbox runtime manifest missing at ${manifestPath}. Run scripts/build-sandbox-runtime.ts first.`,
			);
		}
		plugins.push(justBashWorkerRewritePlugin());
	}
	if (options.stubNodePty) {
		plugins.push(stubNodePtyPlugin());
	}

	const result = await Bun.build({
		entrypoints: [resolve(entrypoint)],
		compile: {
			target: `bun-${process.platform}-${process.arch}` as `bun-${string}-${string}`,
			outfile,
		},
		// Force @opentelemetry packages to resolve their "esnext" exports condition.
		// This handles packages that have an `exports` map with an "esnext" entry
		// (e.g., @opentelemetry/otlp-exporter-base).
		conditions: ["esnext"],
		plugins,
	});

	if (!result.success) {
		const logs = result.logs.map((l) => String(l)).join("\n");
		// Also dump each log object — Bun's BuildMessage stringifies to a
		// short summary, but the .message / .position fields have the
		// detail we need when the plugin throws.
		for (const l of result.logs) console.error(l);
		throw new Error(`build failed for ${outfile}:\n${logs}`);
	}

	// On macOS, re-sign with a plain adhoc signature. Bun's linker emits an
	// `adhoc, linker-signed` signature (CodeDirectory flags 0x20002), and on
	// macOS 26+ AMFI's lazy page-by-page validation will SIGKILL processes
	// launched from a freshly-copied linker-signed binary when the kernel
	// page cache holds pages from an older instance at the same path.
	// Symptom is a bare `[1] <pid> killed boundless ...` with no other output;
	// the crash report under ~/Library/Logs/DiagnosticReports/ shows
	// `SIGKILL (Code Signature Invalid)` with `Taskgated Invalid Signature`.
	// Re-signing with `codesign --force --sign -` produces a non-linker-signed
	// adhoc signature (flags 0x2) that is robust against this race.
	if (process.platform === "darwin") {
		try {
			execSync(`codesign --force --sign - ${JSON.stringify(outfile)}`, {
				stdio: ["ignore", "ignore", "pipe"],
			});
		} catch (e) {
			throw new Error(
				`codesign --force --sign - failed for ${outfile}: ${e instanceof Error ? e.message : e}`,
			);
		}
	}
}

async function build() {
	console.log("Building Bound...\n");

	// Step 0: Generate build metadata (commit hash, timestamp)
	console.log("0. Generating build metadata...");
	try {
		execSync("bun run scripts/generate-build-info.ts", { stdio: "inherit" });
	} catch {
		console.warn("Warning: Failed to generate build info (non-fatal)");
	}

	// Step 0b: Embed bundled skills (skill-authoring, bound-reference, …) so the
	// compiled binary can seed them with no FS access at runtime.
	console.log("0b. Embedding bundled skills...");
	try {
		execSync("bun run scripts/embed-bundled-skills.ts", { stdio: "inherit" });
	} catch {
		console.error("Failed to embed bundled skills");
		process.exit(1);
	}

	// Step 1: Build web assets + embed for binary
	console.log("1. Building web UI...");
	try {
		execSync("cd packages/web && bun run build", { stdio: "inherit" });
	} catch {
		console.error("Failed to build web assets");
		process.exit(1);
	}

	// Step 2: Stage sandbox worker runtime for embedding into the bound binary
	console.log("\n2. Preparing sandbox worker runtime...");
	try {
		execSync("bun run scripts/build-sandbox-runtime.ts", { stdio: "inherit" });
	} catch {
		console.error("Failed to prepare sandbox runtime (python/js-exec will not work at runtime)");
		process.exit(1);
	}

	// Step 2b: Stage mxc sandbox binary for embedding into the boundless binary.
	// Non-fatal: a missing/unsupported binary degrades to passthrough at runtime
	// rather than breaking the build.
	console.log("\n2b. Preparing mxc sandbox runtime...");
	try {
		execSync("bun run scripts/build-mxc-runtime.ts", { stdio: "inherit" });
	} catch {
		console.warn("mxc runtime staging failed; boundless filesystem sandbox will be unavailable.");
	}

	// Step 3: Compile bound (main agent binary) — needs both OTel esnext
	// resolution and the just-bash worker rewrite.
	console.log("\n3. Compiling bound binary...");
	try {
		await compileBinary("packages/cli/src/bound.ts", "dist/bound", {
			rewriteJustBashWorkers: true,
		});
	} catch (e) {
		console.error("bound compilation failed:", e instanceof Error ? e.message : e);
		console.log("Use 'bun packages/cli/src/bound.ts' to run directly");
	}

	// Step 4: Compile boundctl (management CLI)
	console.log("\n4. Compiling boundctl binary...");
	try {
		await compileBinary("packages/cli/src/boundctl.ts", "dist/boundctl");
	} catch (e) {
		console.error("boundctl compilation failed:", e instanceof Error ? e.message : e);
		console.log("Use 'bun packages/cli/src/boundctl.ts' to run directly");
	}

	// Step 5: Compile bound-mcp (MCP stdio server)
	console.log("\n5. Compiling bound-mcp binary...");
	try {
		await compileBinary("packages/mcp-server/src/server.ts", "dist/bound-mcp");
	} catch (e) {
		console.error("bound-mcp compilation failed:", e instanceof Error ? e.message : e);
		console.log("Use 'bun packages/mcp-server/src/server.ts' to run directly");
	}

	// Step 6: Compile boundless (terminal client)
	console.log("\n6. Compiling boundless binary...");
	try {
		await compileBinary("packages/less/src/boundless.tsx", "dist/boundless", {
			stubNodePty: true,
		});
	} catch (e) {
		console.error("boundless compilation failed:", e instanceof Error ? e.message : e);
		console.log("Use 'bun packages/less/src/boundless.tsx' to run directly");
	}

	// Summary
	console.log("\n--- Build summary ---");
	// Bun.compile appends ".exe" on Windows, so the summary check must
	// look for the platform-correct file name.
	const binaryExt = process.platform === "win32" ? ".exe" : "";
	for (const binary of ["dist/bound", "dist/boundctl", "dist/bound-mcp", "dist/boundless"]) {
		const binaryPath = binary + binaryExt;
		if (existsSync(binaryPath)) {
			const sizeMB = (statSync(binaryPath).size / (1024 * 1024)).toFixed(2);
			console.log(`  ${binaryPath} (${sizeMB} MB)`);
		} else {
			console.log(`  ${binary} (not built)`);
		}
	}
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
