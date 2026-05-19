import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type Plugin, defineConfig } from "vite";

/**
 * Stub Node.js builtins and server-only npm packages for the browser build.
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

	// Server-only packages that access Node globals (process, Buffer) without
	// importing from node:* — stubbing them prevents ReferenceError at runtime.
	const serverOnlyPackages = new Set([
		"pino",
		"pino-pretty",
		"sonic-boom",
		"thread-stream",
		"on-exit-leak-free",
	]);
	const pkgStubPrefix = "\0pkg-stub:";

	return {
		name: "node-stubs",
		enforce: "pre",
		resolveId(id) {
			if (id.startsWith(nodePrefix)) {
				return stubPrefix + id;
			}
			// Stub server-only npm packages (exact match or sub-path import)
			const pkgName = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
			if (serverOnlyPackages.has(pkgName)) {
				return pkgStubPrefix + id;
			}
		},
		load(id) {
			if (id.startsWith(pkgStubPrefix)) {
				// Pino-compatible no-op logger for browser: exposes the minimal API
				// surface that @bound/shared/logger.ts uses (child, debug, info, warn, error).
				return `const noop = () => {};
const noopLogger = new Proxy({}, { get: () => (...args) => noopLogger });
export default noopLogger;
export const destination = () => ({ write: noop, end: noop, flush: noop, on: noop });
export const multistream = () => ({ write: noop });
export const transport = () => ({ write: noop });`;
			}
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
	define: {
		// Shim the `process` global for server-only code that leaks into the
		// browser bundle via transitive dependencies (OpenTelemetry SDK, etc.).
		"process.env": JSON.stringify({}),
		"process.versions": JSON.stringify({}),
		"process.version": JSON.stringify(""),
		"process.stdout": "undefined",
		"process.nextTick": "queueMicrotask",
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
