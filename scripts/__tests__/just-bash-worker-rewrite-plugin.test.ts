import { describe, expect, it } from "bun:test";
import { justBashWorkerRewritePlugin } from "../just-bash-worker-rewrite-plugin";

/**
 * The plugin gates each rewrite behind a `build.onLoad({ filter })` regex
 * matched against the module path Bun hands the loader. Bun yields OS-native
 * path separators — backslashes on Windows, the same root cause as the
 * Bun.Glob bug fixed in c3cd4122 — so a forward-slash-only
 * `dist/bundle/chunks/...` filter never matches on Windows. When it misses,
 * the rewrite is skipped, the raw just-bash worker loads, its top-level
 * `import { stripTypeScriptTypes } from "node:module"` cannot be linked, the
 * worker dies on spawn, and the js-exec command hangs to its deadman timer.
 * On the Windows CI lane that surfaced as a 6-hour job timeout wedged in
 * js-exec-execution.test.ts. These assertions exercise both separator styles
 * as plain strings so the regression is caught without a Windows runner.
 */
function collectOnLoadFilters(): RegExp[] {
	const filters: RegExp[] = [];
	const build = {
		onLoad(opts: { filter: RegExp }) {
			filters.push(opts.filter);
		},
	};
	const plugin = justBashWorkerRewritePlugin();
	(plugin.setup as (b: unknown) => void)(build);
	return filters;
}

const filters = collectOnLoadFilters();
const matchesAny = (path: string) => filters.some((f) => f.test(path));

describe("just-bash-worker-rewrite-plugin: onLoad filters match OS-native separators", () => {
	const chunks = [
		["js-exec", "node_modules/just-bash/dist/bundle/chunks/js-exec-VXN6TZ7U.js"],
		["python3", "node_modules/just-bash/dist/bundle/chunks/python3-ABCD1234.js"],
		["sqlite3 impl", "node_modules/just-bash/dist/bundle/chunks/chunk-CWQS3NFK.js"],
	] as const;

	for (const [label, posixPath] of chunks) {
		it(`matches the ${label} chunk with POSIX separators`, () => {
			expect(matchesAny(posixPath)).toBe(true);
		});

		it(`matches the ${label} chunk with Windows separators`, () => {
			const winPath = `C:\\Users\\runneradmin\\${posixPath.replaceAll("/", "\\")}`;
			expect(matchesAny(winPath)).toBe(true);
		});
	}
});
