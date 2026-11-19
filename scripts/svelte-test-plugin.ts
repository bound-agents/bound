import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BunPlugin } from "bun";

type SvelteCompiler = typeof import("svelte/compiler");
type SvelteCompile = SvelteCompiler["compile"];

let cachedCompile: SvelteCompile | undefined;

/**
 * The svelte compiler, resolved from packages/web (the only package that
 * depends on svelte) and loaded on first use.
 */
export async function loadSvelteCompiler(root: string): Promise<SvelteCompile> {
	if (!cachedCompile) {
		const entry = Bun.resolveSync("svelte/compiler", join(root, "packages/web"));
		const compiler: SvelteCompiler = await import(entry);
		cachedCompile = compiler.compile;
	}
	return cachedCompile;
}

/**
 * Compiles one component the way the Vite build does (`generate: "client"`),
 * returning JS with an inline source map back to the `.svelte` source.
 */
export function compileSvelteModule(compile: SvelteCompile, path: string, source: string): string {
	const result = compile(source, { filename: path, generate: "client" });
	const map = Buffer.from(JSON.stringify(result.js.map)).toString("base64");
	return `${result.js.code}\n//# sourceMappingURL=data:application/json;base64,${map}`;
}

/**
 * svelte's server entry points (the package exports' `default` condition).
 * Bun's test runner resolves these where the Vite build resolves the
 * `browser` builds, and `mount` / lifecycle functions in them throw
 * `lifecycle_function_unavailable`. Components compiled with
 * `generate: "client"` need the browser build, so under test each server
 * entry re-exports its client sibling. bound renders no svelte on the server.
 */
export const SVELTE_SERVER_ENTRY =
	/[\\/]svelte[\\/]src[\\/](store[\\/]|reactivity[\\/])?index-server\.js$/;

/**
 * Compiles `.svelte` imports under `bun test`. Without it Bun's default file
 * loader resolves a `.svelte` import to its path string: the import
 * "succeeds", no component code runs, and coverage never sees the file. With
 * it, component modules execute and appear in Bun's coverage. Bun attributes
 * the compiled JS's lines to the `.svelte` path without applying the source
 * map, so reported line numbers are compiled-JS lines; the map still serves
 * stack traces.
 */
export function svelteTestPlugin(root: string): BunPlugin {
	return {
		name: "bound-svelte-test",
		setup(build) {
			build.onLoad({ filter: SVELTE_SERVER_ENTRY }, () => ({
				contents: 'export * from "./index-client.js";',
				loader: "js",
			}));
			build.onLoad({ filter: /\.svelte$/ }, async (args) => {
				const compile = await loadSvelteCompiler(root);
				return {
					contents: compileSvelteModule(compile, args.path, readFileSync(args.path, "utf8")),
					loader: "js",
				};
			});
		},
	};
}
