import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { injectPythonCommandStdin, injectPythonWorkerStdin } from "./sandbox-runtime-transforms";

// Resolve the real just-bash artifacts so these tests double as an
// upstream-drift guard: if just-bash restructures the worker or the
// python3 command chunk, the needle-anchored transforms throw and these
// tests fail loudly rather than the binary silently regressing.
const justBashDir = dirname(require.resolve("just-bash/package.json", { paths: [process.cwd()] }));
const chunksDir = join(justBashDir, "dist/bundle/chunks");
const workerPath = join(chunksDir, "worker.js");
const python3ChunkPath = (() => {
	const hit = readdirSync(chunksDir).find((f) => /^python3-[A-Z0-9]+\.js$/.test(f));
	if (!hit) throw new Error("python3 command chunk not found in just-bash dist");
	return join(chunksDir, hit);
})();

describe("injectPythonWorkerStdin", () => {
	const src = readFileSync(workerPath, "utf8");

	test("the pristine worker has no stdin device wired (the bug)", () => {
		// Baseline: this is exactly why fd 0 reads hang — nothing feeds
		// Module.stdin, and the worker input carries no stdin field.
		expect(src.includes("input.stdin")).toBe(false);
		expect(/createPythonModule\(\{\s*stdin:/.test(src)).toBe(false);
	});

	test("injects a Module.stdin byte-reader sourced from input.stdin", () => {
		const out = injectPythonWorkerStdin(src);
		expect(out).not.toBe(src);
		// stdin must be the FIRST option inside createPythonModule({ ... })
		// so emscripten's FS.init picks it up (input??=Module["stdin"]).
		expect(/createPythonModule\(\{\s*stdin:/.test(out)).toBe(true);
		// The reader pulls from the worker input object.
		expect(out.includes("input.stdin")).toBe(true);
		// EOF sentinel: emscripten expects null when input is exhausted.
		expect(out.includes("null")).toBe(true);
		// The original options survive.
		expect(out.includes("noInitialRun: true")).toBe(true);
		expect(out.includes("preRun: [onPreRun]")).toBe(true);
	});

	test("throws on upstream drift (needle gone)", () => {
		expect(() => injectPythonWorkerStdin("function noop(){}")).toThrow(/createPythonModule/);
	});
});

describe("injectPythonCommandStdin", () => {
	const src = readFileSync(python3ChunkPath, "utf8");

	test("the pristine chunk builds a worker input with no stdin field", () => {
		expect(/scriptPath:\w+,timeoutMs:\w+\}/.test(src)).toBe(true);
		expect(src.includes(",stdin:")).toBe(false);
	});

	test("threads stdin into the worker input as data, EOF when stdin is the program", () => {
		const out = injectPythonCommandStdin(src);
		expect(out).not.toBe(src);
		// A stdin field now rides in the worker input object. It must:
		//  - be EOF ("") when the script source came FROM stdin
		//    (python3 - / bare piped program; real CPython leaves fd 0 at EOF)
		//  - be the piped data otherwise (-c / -m / script file)
		// Anchored on the script-source label var captured from the chunk.
		expect(
			/scriptPath:(\w+),timeoutMs:\w+,stdin:\(\1==="-"\|\|\1==="<stdin>"\)\?"":\w+\.stdin\}/.test(
				out,
			),
		).toBe(true);
	});

	test("throws on upstream drift (worker input shape changed)", () => {
		expect(() => injectPythonCommandStdin("const x = {a:1,b:2};")).toThrow(/worker input/i);
	});
});
