#!/usr/bin/env bun
/**
 * Prepares sandbox worker assets for embedding in the compiled `bound` binary.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `just-bash` ships Python and JavaScript commands that run inside Node
 * `Worker` threads. At build-time the worker entry points are referenced via
 * `new URL("./worker.js", import.meta.url)` patterns inside its own chunk
 * files. `bun build --compile` does NOT auto-embed files referenced through
 * that pattern when the references live inside `node_modules/` — only files
 * in the project tree trigger the asset-embedding heuristic.
 *
 * Result: the compiled binary knows the worker PATH but not the worker
 * CONTENT. Spawning the Worker fails with
 *   BuildMessage: ModuleNotFound resolving "/$bunfs<path>"
 * (the `<path>` is a path-sanitizer redaction).
 *
 * The fix is in three parts:
 *   1) (this script) Copy worker files and their companion assets out of
 *      just-bash's node_modules into the project tree at
 *      packages/sandbox/src/_runtime/.
 *   2) (runtime/assets.ts) Re-import those files via the explicit
 *      `with { type: "file" }` syntax so bun's compile step embeds them.
 *   3) (build.ts plugin) Rewrite just-bash's chunk sources so they spawn
 *      Workers using our embedded paths instead of their own `new URL(...)`
 *      construction.
 *
 * Python and js-exec get different treatment:
 *   - Python's worker uses only `node:*` APIs that Bun supports, so we
 *     copy it as-is and preserve the original relative-path layout for
 *     its sibling CPython WASM/stdlib assets.
 *   - js-exec's worker statically imports `stripTypeScriptTypes` from
 *     `node:module`, which Bun 1.3.x does not implement. We bundle it
 *     with `Bun.build` (inlines quickjs-emscripten) and patch the import
 *     to fall back to Bun.Transpiler when `stripTypeScriptTypes` is
 *     unavailable.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const OUT_DIR = join(ROOT, "packages/sandbox/src/_runtime");

/**
 * Locate the just-bash install. Bun's flat layout puts it under
 * node_modules/.bun/just-bash@<version>/node_modules/just-bash, but we'll
 * also accept a direct node_modules/just-bash for toolchains that lay
 * things out more conventionally.
 */
function findJustBashDir(): string {
	const direct = join(ROOT, "node_modules/just-bash");
	if (existsSync(join(direct, "package.json"))) return direct;

	const bunCache = join(ROOT, "node_modules/.bun");
	if (existsSync(bunCache)) {
		const entries = readdirSync(bunCache).filter((n) => n.startsWith("just-bash@"));
		if (entries.length > 0) {
			// Pick the first (there should be only one); Bun hoists to a single version.
			const candidate = join(bunCache, entries[0], "node_modules/just-bash");
			if (existsSync(join(candidate, "package.json"))) return candidate;
		}
	}
	throw new Error("Could not locate just-bash in node_modules. Run `bun install` first.");
}

/**
 * Find one of just-bash's lazy-loaded chunks by its unhashed name prefix.
 * Chunk filenames include a Bun content-hash suffix that changes across
 * upstream versions (e.g. `python3-SG3DOKBZ.js`), so we can't hardcode.
 * The pattern also excludes literal names like `js-exec-worker.js` that
 * happen to share a prefix but lack the hash suffix.
 */
function findChunk(justBashDir: string, prefix: string): string {
	const pattern = new RegExp(`^${prefix}-[A-Z0-9]+\\.js$`);
	const chunksDir = join(justBashDir, "dist/bundle/chunks");
	const candidates = readdirSync(chunksDir).filter((n) => pattern.test(n));
	if (candidates.length === 0) {
		throw new Error(`No chunk matching ${pattern} in ${chunksDir}`);
	}
	if (candidates.length > 1) {
		throw new Error(
			`Expected exactly one chunk matching ${pattern} but found ${candidates.length}: ${candidates.join(", ")}`,
		);
	}
	return join(chunksDir, candidates[0]);
}

/**
 * Bundle the js-exec worker and patch the `stripTypeScriptTypes` import.
 *
 * Bun 1.3.x does not export `stripTypeScriptTypes` from `node:module`, so a
 * static ESM import of it throws "Export named 'stripTypeScriptTypes' not
 * found in module 'node:module'" at worker-load time. We replace the import
 * with a dynamic resolver that tries node:module first (future-proof for
 * when Bun implements it), falls back to Bun.Transpiler, and finally to a
 * no-op if neither is available.
 */
async function bundleJsExecWorker(sourcePath: string, outPath: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [sourcePath],
		target: "node",
		format: "esm",
		external: ["node:*"],
		plugins: [
			{
				name: "strip-ts-shim",
				setup(build) {
					build.onLoad({ filter: /js-exec-worker\.js$/ }, (args) => {
						const src = readFileSync(args.path, "utf8");
						const needle = `import { stripTypeScriptTypes } from "node:module";`;
						if (!src.includes(needle)) {
							throw new Error(
								`js-exec-worker.js no longer contains expected stripTypeScriptTypes import; upstream layout changed at ${args.path}`,
							);
						}
						// Replace with a dynamic resolver. Top-level await is fine inside an
						// ESM worker; the two use sites (TS source loading and `stripTypes`
						// input option) are both reached from async code paths that run
						// after module evaluation completes.
						const shim = [
							"// Bun compat: stripTypeScriptTypes is not yet available from node:module in Bun 1.3.x.",
							"// Fall back to Bun.Transpiler (which handles TypeScript natively), then to a no-op.",
							"const stripTypeScriptTypes = await (async () => {",
							"  try {",
							`    const m = await import("node:module");`,
							`    if (typeof m.stripTypeScriptTypes === "function") return m.stripTypeScriptTypes;`,
							"  } catch {}",
							"  try {",
							"    const B = globalThis.Bun;",
							`    if (B && typeof B.Transpiler === "function") {`,
							`      const t = new B.Transpiler({ loader: "ts" });`,
							"      return (src) => t.transformSync(src);",
							"    }",
							"  } catch {}",
							"  return (src) => src;",
							"})();",
						].join("\n");
						return { contents: src.replace(needle, shim), loader: "js" };
					});
				},
			},
		],
	});
	if (!result.success) {
		const msg = result.logs.map((l) => String(l)).join("\n");
		throw new Error(`Failed to bundle js-exec-worker: ${msg}`);
	}
	if (result.outputs.length !== 1) {
		throw new Error(`Expected exactly 1 bundler output, got ${result.outputs.length}`);
	}
	const bundled = await result.outputs[0].text();
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, bundled);
}

async function main() {
	console.log("Preparing sandbox worker runtime...");
	const justBashDir = findJustBashDir();
	console.log(`  just-bash: ${justBashDir}`);

	// Wipe + recreate the output dir so stale copies from previous versions
	// don't leak into the embedded bundle.
	if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
	mkdirSync(OUT_DIR, { recursive: true });

	// ── Python worker (copy as-is; uses only Bun-compatible node:* APIs) ──
	const pyWorkerSrc = join(justBashDir, "dist/bundle/chunks/worker.js");
	const pyWorkerDst = join(OUT_DIR, "worker-python.js");
	copyFileSync(pyWorkerSrc, pyWorkerDst);
	console.log(`  python worker: ${pyWorkerDst}`);

	// ── CPython vendor assets (python.cjs, python.wasm, python313.zip) ──
	const vendorSrc = join(justBashDir, "vendor/cpython-emscripten");
	for (const name of ["python.cjs", "python.wasm", "python313.zip"]) {
		copyFileSync(join(vendorSrc, name), join(OUT_DIR, name));
	}
	console.log("  cpython vendor: python.cjs + python.wasm + python313.zip");

	// ── js-exec worker (bundle + patch) ──
	const jsExecWorkerSrc = join(justBashDir, "dist/bundle/chunks/js-exec-worker.js");
	const jsExecWorkerDst = join(OUT_DIR, "worker-js-exec.js");
	await bundleJsExecWorker(jsExecWorkerSrc, jsExecWorkerDst);
	console.log(`  js-exec worker: ${jsExecWorkerDst} (bundled + stripTS shim)`);

	// ── quickjs wasm (sibling of the bundled js-exec worker) ──
	const bunCache = join(ROOT, "node_modules/.bun");
	const qjsPkg = readdirSync(bunCache).find((n) =>
		n.startsWith("@jitl+quickjs-wasmfile-release-sync@"),
	);
	if (!qjsPkg) throw new Error("Could not locate @jitl/quickjs-wasmfile-release-sync");
	const qjsWasmSrc = join(
		bunCache,
		qjsPkg,
		"node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
	);
	copyFileSync(qjsWasmSrc, join(OUT_DIR, "emscripten-module.wasm"));
	console.log("  quickjs wasm: emscripten-module.wasm");

	// ── Locate the outer command chunks so the build.ts plugin can target ──
	// them precisely. Hashes change across upstream versions so we write
	// the resolved paths to a manifest the plugin reads at build time.
	const pythonChunk = findChunk(justBashDir, "python3");
	const jsExecChunk = findChunk(justBashDir, "js-exec");

	// ── Write a manifest with file hashes for runtime cache-keying ──
	// The runtime materializer uses this hash to pick a stable on-disk
	// location and skip re-materialization when the embedded assets haven't
	// changed between releases.
	const files = [
		"worker-python.js",
		"python.cjs",
		"python.wasm",
		"python313.zip",
		"worker-js-exec.js",
		"emscripten-module.wasm",
	];
	const hasher = createHash("sha256");
	for (const f of files) {
		hasher.update(f);
		hasher.update("\0");
		hasher.update(readFileSync(join(OUT_DIR, f)));
		hasher.update("\0");
	}
	const manifestHash = hasher.digest("hex").slice(0, 16);

	const manifest = {
		// Hash keys a stable materialization directory; regenerated on every
		// asset change so old runtimes aren't reused after upstream bumps.
		hash: manifestHash,
		files,
		// Chunk paths consumed by the build.ts plugin to rewrite worker spawns.
		chunks: {
			python3: pythonChunk,
			jsExec: jsExecChunk,
		},
	};
	writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
	console.log(`  manifest: hash=${manifestHash}`);

	console.log("Sandbox runtime prepared.\n");
}

main().catch((err) => {
	console.error("Failed to prepare sandbox runtime:", err);
	process.exit(1);
});
