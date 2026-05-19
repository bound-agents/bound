import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type Plugin, defineConfig } from "vite";

/**
 * Stub Node.js builtins for the browser build.
 * Workspace packages (@bound/client, @bound/shared) contain Node-only code paths
 * (tracing, event emitter, logger) that are never executed in the browser but still
 * get pulled into the bundle by Rollup's static analysis. This plugin resolves those
 * imports to empty modules so the build succeeds without runtime impact.
 *
 * Uses `enforce: "pre"` to intercept before Vite's built-in resolver externalizes
 * these as `__vite-browser-external` (which breaks named imports).
 */
function nodeStubsPlugin(): Plugin {
	const nodePrefix = "node:";
	const stubPrefix = "\0node-stub:";

	return {
		name: "node-stubs",
		enforce: "pre",
		resolveId(id) {
			if (id.startsWith(nodePrefix)) {
				return stubPrefix + id;
			}
		},
		load(id) {
			if (id.startsWith(stubPrefix)) {
				// Return a module that exposes a Proxy as both default and named exports
				// via module namespace. Rollup needs static named exports for known imports,
				// so we use a wildcard re-export from a virtual helper.
				return `const handler = { get: () => () => ({}) };
const stub = new Proxy({}, handler);
export default stub;
export const EventEmitter = class { on() { return this; } off() { return this; } once() { return this; } emit() { return false; } };
export const createHash = () => ({ update() { return this; }, digest() { return Buffer.alloc(20); } });
export const mkdirSync = () => {};
export const existsSync = () => false;
export const readFileSync = () => "";
export const writeFileSync = () => {};
export const join = (...args) => args.join("/");
export const resolve = (...args) => args.join("/");
export const dirname = (p) => p;
export const basename = (p) => p;
export const Readable = class {};
export const Writable = class {};
export const Transform = class {};
export const Stream = class {};
export const isMainThread = true;
export const parentPort = null;
export const Worker = class {};`;
			}
		},
	};
}

export default defineConfig({
	plugins: [
		nodeStubsPlugin(),
		svelte({
			compilerOptions: {
				generate: "client",
			},
		}),
	],
	root: ".",
	resolve: {
		conditions: ["browser", "import", "module"],
	},
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
		minify: true,
	},
	server: {
		proxy: {
			"/api": "http://localhost:3000",
			"/ws": {
				target: "ws://localhost:3000",
				ws: true,
			},
		},
	},
});
