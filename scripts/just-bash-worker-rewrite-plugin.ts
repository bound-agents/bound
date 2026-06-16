/**
 * just-bash worker-path rewrite plugin.
 *
 * just-bash's `python3-*.js`, `js-exec-*.js`, and sqlite3 worker chunks each
 * compute their Worker entry via `new Worker(new URL("./<worker>.js",
 * import.meta.url))`, which resolves to the raw on-disk worker inside
 * `node_modules/just-bash/dist/bundle/chunks/`. Two problems with using those
 * raw paths directly:
 *
 *   1. Under `bun build --compile`, the `/$bunfs/.../chunks/worker.js` path the
 *      chunk would compute is never populated, so Worker spawn fails.
 *   2. The raw js-exec worker's top-level `import { stripTypeScriptTypes } from
 *      "node:module"` cannot be linked by Bun, so even from source (`bun test`)
 *      the Worker dies on spawn and the command hangs to its deadman timer
 *      (bound#157).
 *
 * This plugin rewrites the chunks so their `new URL(...)` consults
 * `globalThis.__boundSandboxWorkerPath__(kind)` — populated by
 * `materializeSandboxRuntime()` — which points at the shimmed, materialized
 * worker on real disk. It also threads piped stdin into the python3/js-exec
 * command chunks (which otherwise drop it on the floor; bound#157).
 *
 * The SAME plugin object is used in two places so the binary and `bun test`
 * resolve workers identically with zero drift:
 *   - `scripts/build.ts` passes it to `Bun.build({ plugins })` for the `bound`
 *     binary (compile-time onLoad).
 *   - `scripts/test-preload.ts` registers it via `Bun.plugin()` so `bun test`
 *     applies the same rewrite at runtime (lazy onLoad when a sandbox command
 *     first imports the chunk).
 */

import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { injectJsExecCommandStdin, injectPythonCommandStdin } from "./sandbox-runtime-transforms";

export function justBashWorkerRewritePlugin(): BunPlugin {
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
					let contents = src.replace(needle, replacement);
					// The python3 chunk also drops piped stdin on the floor:
					// it captures e.stdin only to pick the script source and
					// never forwards it to the worker, so sys.stdin / fd-0 reads
					// hang on the worker's empty TTY until the deadman timer
					// (bound#157). Thread it into the worker input object.
					if (kind === "python") {
						contents = injectPythonCommandStdin(contents);
					} else if (kind === "jsExec") {
						// Same stdin-on-the-floor bug on the js-exec face: the
						// chunk reads e.stdin only to pick the script source and
						// never forwards it, so the QuickJS guest's fd 0 /
						// process.stdin are starved (bound#157). Thread it in.
						contents = injectJsExecCommandStdin(contents);
					}
					return {
						contents,
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
				// Return the file unchanged otherwise: an identity `{ contents }`
				// rather than `undefined`, because a runtime `Bun.plugin()` onLoad
				// (the test-preload path) rejects an `undefined` return with
				// "onLoad() expects an object returned" — unlike a `Bun.build`
				// plugin, where `undefined` means "fall through to the default
				// loader". This broad `chunk-*.js` filter matches many shared
				// chunks, so the no-op return is the common case.
				if (!src.includes('"sqlite3-worker.js"')) {
					return { contents: src, loader: "js" };
				}

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
