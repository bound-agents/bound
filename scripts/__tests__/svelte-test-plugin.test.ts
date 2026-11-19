import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSvelteModule, loadSvelteCompiler } from "../svelte-test-plugin";

const root = resolve(import.meta.dir, "..", "..");
const btn = join(root, "packages/web/src/client/components/Btn.svelte");

describe("svelte-test-plugin", () => {
	it("makes a .svelte import a real component module under bun test", async () => {
		// Without the preloaded plugin, Bun's file loader resolves this import to
		// the file's path string and no component code runs.
		const module = await import("../../packages/web/src/client/components/Btn.svelte");
		expect(typeof module.default).toBe("function");
	});

	it("compiles with an inline source map back to the component source", async () => {
		const compile = await loadSvelteCompiler(root);
		const js = compileSvelteModule(compile, btn, readFileSync(btn, "utf8"));
		const map = js.match(/sourceMappingURL=data:application\/json;base64,(.+)$/)?.[1];
		expect(map).toBeDefined();
		const decoded = JSON.parse(Buffer.from(map ?? "", "base64").toString("utf8"));
		expect(decoded.mappings.length).toBeGreaterThan(0);
	});
});
