#!/usr/bin/env bun
// Build script for Bound
// Builds web assets (with embedded SPA) and compiles all binaries.
//
// The `bound` binary is compiled programmatically via `Bun.build` (not the
// CLI) so we can pass a plugin that rewrites just-bash's worker-spawn
// sites. See packages/sandbox/src/runtime/materialize.ts and
// scripts/build-sandbox-runtime.ts for the full rationale. The other
// binaries don't spawn just-bash Workers and keep the simpler CLI call.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Compile the `bound` binary with a plugin that rewrites just-bash's
 * `python3-*.js` and `js-exec-*.js` chunks so their `new Worker(...)`
 * calls target our materialized on-disk workers instead of the
 * `/$bunfs/.../chunks/worker.js` paths the chunks would otherwise
 * compute (which Bun-compile does not populate; see fix/sandbox-worker-assets).
 *
 * The rewrite replaces one specific pattern both chunks use identically:
 *   fileURLToPath(new URL("./worker.js", import.meta.url))
 * with a call into the global bridge installed by
 * materializeSandboxRuntime(), which returns the on-disk worker path.
 */
async function compileBound(outfile: string): Promise<void> {
	const manifestPath = resolve("packages/sandbox/src/_runtime/manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error(
			`Sandbox runtime manifest missing at ${manifestPath}. Run scripts/build-sandbox-runtime.ts first.`,
		);
	}

	const result = await Bun.build({
		entrypoints: [resolve("packages/cli/src/bound.ts")],
		compile: {
			target: `bun-${process.platform}-${process.arch}` as `bun-${string}-${string}`,
			outfile,
		},
		// Force @opentelemetry packages to resolve their "esnext" exports condition.
		// This handles packages that have an `exports` map with an "esnext" entry
		// (e.g., @opentelemetry/otlp-exporter-base).
		conditions: ["esnext"],
		plugins: [
			{
				name: "otel-esnext-resolver",
				setup(build) {
					// Many @opentelemetry packages lack an `exports` field and only
					// declare top-level `main`/`module`/`esnext` fields. Bun picks
					// `module` (build/esm/) which is ES5-downcompiled and uses
					// __extends + _super.call(this). When the parent class comes from
					// a package that DOES have exports (resolved to native ES class via
					// conditions above), calling it without `new` throws:
					//   "Cannot call a class constructor without |new|"
					// Fix: when loading any file from an otel build/esm/ directory,
					// substitute the content from the equivalent build/esnext/ file
					// which uses native class syntax throughout.
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
			},
			{
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
			},
		],
	});

	if (!result.success) {
		const logs = result.logs.map((l) => String(l)).join("\n");
		// Also dump each log object — Bun's BuildMessage stringifies to a
		// short summary, but the .message / .position fields have the
		// detail we need when the plugin throws.
		for (const l of result.logs) console.error(l);
		throw new Error(`bound build failed:\n${logs}`);
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

	// Step 3: Compile bound (main agent binary) — programmatic Bun.build
	// so we can inject the just-bash path-rewrite plugin.
	console.log("\n3. Compiling bound binary...");
	try {
		await compileBound("dist/bound");
	} catch (e) {
		console.error("Binary compilation failed:", e instanceof Error ? e.message : e);
		console.log("Use 'bun packages/cli/src/bound.ts' to run directly");
	}

	// Step 4: Compile boundctl (management CLI)
	console.log("\n4. Compiling boundctl binary...");
	try {
		execSync("bun build --compile packages/cli/src/boundctl.ts --outfile dist/boundctl", {
			stdio: "inherit",
		});
	} catch {
		console.error("boundctl compilation failed");
		console.log("Use 'bun packages/cli/src/boundctl.ts' to run directly");
	}

	// Step 5: Compile bound-mcp (MCP stdio server)
	console.log("\n5. Compiling bound-mcp binary...");
	try {
		execSync("bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp", {
			stdio: "inherit",
		});
	} catch {
		console.error("bound-mcp compilation failed");
		console.log("Use 'bun packages/mcp-server/src/server.ts' to run directly");
	}

	// Step 6: Compile boundless (terminal client)
	console.log("\n6. Compiling boundless binary...");
	try {
		execSync("bun build --compile packages/less/src/boundless.tsx --outfile dist/boundless", {
			stdio: "inherit",
		});
	} catch {
		console.error("boundless compilation failed (expected - entrypoint not yet implemented)");
		console.log("Use 'bun packages/less/src/boundless.tsx' to run directly");
	}

	// Summary
	console.log("\n--- Build summary ---");
	for (const binary of ["dist/bound", "dist/boundctl", "dist/bound-mcp", "dist/boundless"]) {
		if (existsSync(binary)) {
			const sizeMB = (statSync(binary).size / (1024 * 1024)).toFixed(2);
			console.log(`  ${binary} (${sizeMB} MB)`);
		} else {
			console.log(`  ${binary} (not built)`);
		}
	}
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
