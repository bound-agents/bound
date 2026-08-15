import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { runYardProgram } from "../driver";

/**
 * Deployment regression: the daemon is a standalone Bun binary. The default
 * quickjs-emscripten RELEASE_SYNC variant loads `emscripten-module.wasm` from
 * disk; Bun rewrites that path to `/$bunfs/root/emscripten-module.wasm`, but
 * the build ships no sidecar, so every deployed Yard failed before guest
 * execution with ENOENT while source tests stayed green.
 *
 * Pin BOTH halves:
 *  - driver really runs through the single-file variant in source; and
 *  - a Bun-compiled standalone probe can instantiate QuickJS and execute a
 *    Yard program after the source tree is unavailable.
 */
describe("Yard bundled runtime", () => {
	it("executes through the bundle-safe single-file QuickJS variant", async () => {
		const out = await runYardProgram({
			program: "function* main() { return 42; }",
			host: {
				dispatchTool: async () => "unused",
				dispatchInference: async () => "unused",
			},
		});
		expect(out.result).toBe(42);
	});

	it("does not import quickjs-emscripten's separate-WASM singleton", async () => {
		const source = await readFile(join(import.meta.dir, "..", "driver.ts"), "utf8");
		expect(source).toContain("quickjs-singlefile-cjs-release-sync");
		expect(source).not.toMatch(/from\s+["']quickjs-emscripten["']/);
	});

	it("runs from a standalone Bun binary with no emscripten-module.wasm sidecar", async () => {
		const tmpRoot = join(process.cwd(), ".tmp-yard-bundle-test");
		await Bun.$`rm -rf ${tmpRoot}`.quiet();
		await Bun.$`mkdir -p ${tmpRoot}`.quiet();
		const entry = join(tmpRoot, "probe.ts");
		const binary = join(tmpRoot, "yard-probe");
		await Bun.write(
			entry,
			`import { runYardProgram } from ${JSON.stringify(join(import.meta.dir, "..", "driver.ts"))};
const out = await runYardProgram({
  program: "function* main() { return 42; }",
  host: { dispatchTool: async () => "unused", dispatchInference: async () => "unused" },
});
process.stdout.write(JSON.stringify(out.result));
`,
		);
		try {
			const built = await Bun.$`bun build --compile --minify --outfile ${binary} ${entry}`.quiet();
			expect(built.exitCode).toBe(0);
			// Assert the regression setup itself: no WASM sidecar exists beside
			// the binary. The single-file package has to carry the bytes inside.
			const names = Array.from(new Bun.Glob("*").scanSync(tmpRoot)).map((path) => basename(path));
			expect(names).not.toContain("emscripten-module.wasm");
			const ran = await Bun.$`${binary}`.quiet();
			expect(ran.exitCode).toBe(0);
			expect(ran.stdout.toString()).toBe("42");
		} finally {
			await Bun.$`rm -rf ${tmpRoot}`.quiet();
		}
	}, 30_000);
});
