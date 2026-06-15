import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	injectJsExecCommandStdin,
	injectJsExecWorkerStdin,
	injectJsExecWorkerStdout,
	injectPythonCommandStdin,
	injectPythonWorkerStdin,
} from "./sandbox-runtime-transforms";

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
const jsExecWorkerPath = join(chunksDir, "js-exec-worker.js");
const jsExecChunkPath = (() => {
	// The uppercase/digit content hash naturally excludes the literal
	// `js-exec-worker.js` (lowercase), so this matches only the command chunk.
	const hit = readdirSync(chunksDir).find((f) => /^js-exec-[A-Z0-9]+\.js$/.test(f));
	if (!hit) throw new Error("js-exec command chunk not found in just-bash dist");
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

describe("injectJsExecWorkerStdin", () => {
	const src = readFileSync(jsExecWorkerPath, "utf8");

	test("the pristine js-exec worker reads no stdin anywhere (the bug)", () => {
		// Baseline #157: the worker input carries no stdin field, nothing
		// marshals stdin into the QuickJS context, and fd 0 / process.stdin
		// are unwired — so reads fail loud (ENOENT / undefined).
		expect(src.includes("__boundStdin")).toBe(false);
		expect(src.includes("input.stdin")).toBe(false);
		// The two real anchors the transform hangs on must be present.
		expect(src.includes('context.setProp(context.global, "env", envObj)')).toBe(true);
		expect(src.includes("_fs.readFileSync = function(path, opts) {")).toBe(true);
		expect(src.includes("_p.version = 'v22.0.0';")).toBe(true);
	});

	test("marshals stdin into the context and wires fd 0 + /dev/stdin + process.stdin", () => {
		const out = injectJsExecWorkerStdin(src);
		expect(out).not.toBe(src);
		// 1. A __boundStdin global string sourced from input.stdin crosses the
		//    host->context boundary alongside the existing env injection.
		expect(out.includes("input.stdin")).toBe(true);
		expect(/context\.setProp\(context\.global, "__boundStdin"/.test(out)).toBe(true);
		// 2. fs.readFileSync special-cases the three canonical stdin handles
		//    before the normal path, returning Buffer or string by encoding.
		expect(out.includes("path === 0")).toBe(true);
		expect(out.includes("/dev/stdin")).toBe(true);
		expect(out.includes("/proc/self/fd/0")).toBe(true);
		// 3. process.stdin is no longer undefined.
		expect(/_p\.stdin\s*=/.test(out)).toBe(true);
		// The original env injection and fs body survive (idempotent anchors).
		expect(out.includes('context.setProp(context.global, "env", envObj)')).toBe(true);
		expect(out.includes("Buffer.from(orig.readFileBuffer(path))")).toBe(true);
	});

	test("throws on upstream drift (env-injection anchor gone)", () => {
		expect(() => injectJsExecWorkerStdin("function noop(){}")).toThrow(/js-exec worker/i);
	});
});

describe("injectJsExecWorkerStdout", () => {
	// The stdout graft runs AFTER the stdin graft in the build pipeline, but
	// its two anchors (the console wiring and _p.versions) are upstream
	// just-bash lines untouched by the stdin transform — so it applies to the
	// pristine worker just the same. Run it on the raw source here.
	const src = readFileSync(jsExecWorkerPath, "utf8");

	test("the pristine js-exec worker leaves process.stdout/stderr unwired (the bug)", () => {
		// just-bash's in-guest process shim has no stdout/stderr, and there is
		// no raw (no-newline) host writer — only console.log/error, which append
		// a newline. So process.stdout.write(...) throws on undefined.
		expect(src.includes("__boundWriteStdout")).toBe(false);
		expect(src.includes("__boundWriteStderr")).toBe(false);
		expect(/_p\.stdout\s*=/.test(src)).toBe(false);
		expect(/_p\.stderr\s*=/.test(src)).toBe(false);
		// The two real anchors the transform hangs on must be present.
		expect(src.includes('context.setProp(context.global, "console", consoleObj);')).toBe(true);
		expect(src.includes("_p.versions = { node: '22.0.0', quickjs: '2024' };")).toBe(true);
	});

	test("exposes raw host writers and defines process.stdout/stderr over them", () => {
		const out = injectJsExecWorkerStdout(src);
		expect(out).not.toBe(src);
		// 1. Two raw writers cross the host->guest boundary, routing to the SAME
		//    captured sink console.log/error use (backend.writeStdout/writeStderr)
		//    minus the appended newline — not the host's real process.stdout.
		expect(/context\.setProp\(context\.global, "__boundWriteStdout"/.test(out)).toBe(true);
		expect(/context\.setProp\(context\.global, "__boundWriteStderr"/.test(out)).toBe(true);
		expect(out.includes("backend.writeStdout(context.getString(argHandle))")).toBe(true);
		expect(out.includes("backend.writeStderr(context.getString(argHandle))")).toBe(true);
		// 2. process.stdout / process.stderr are no longer undefined, built over
		//    the writers with fd 1 / fd 2.
		expect(out.includes("_p.stdout = __mkWritable(globalThis.__boundWriteStdout, 1);")).toBe(true);
		expect(out.includes("_p.stderr = __mkWritable(globalThis.__boundWriteStderr, 2);")).toBe(true);
		// The console wiring the writers anchor on survives (idempotent anchor).
		expect(out.includes('context.setProp(context.global, "console", consoleObj);')).toBe(true);
		// Guest-eval template-literal hygiene: the injected guest block must not
		// smuggle a backtick or a ${...} into the surrounding template literal.
		const guestBlock = out.slice(
			out.indexOf("function __mkWritable("),
			out.indexOf("_p.stderr = __mkWritable"),
		);
		expect(guestBlock.includes("`")).toBe(false);
		expect(guestBlock.includes("${")).toBe(false);
	});

	test("composes with the stdin graft (both grafts coexist)", () => {
		// In the real pipeline stdin runs first; the stdout graft must apply
		// cleanly to its output and leave the stdin wiring intact.
		const out = injectJsExecWorkerStdout(injectJsExecWorkerStdin(src));
		expect(out.includes("_p.stdin =")).toBe(true);
		expect(out.includes("_p.stdout = __mkWritable(globalThis.__boundWriteStdout, 1);")).toBe(true);
		expect(out.includes("_p.stderr = __mkWritable(globalThis.__boundWriteStderr, 2);")).toBe(true);
		expect(out.includes("__boundStdin")).toBe(true);
	});

	test("throws on upstream drift (console anchor gone)", () => {
		expect(() => injectJsExecWorkerStdout("function noop(){}")).toThrow(/js-exec worker/i);
	});

	test("throws on upstream drift (process-version anchor gone)", () => {
		// Console anchor present, _p.versions anchor absent — second edit must throw.
		const consoleOnly = [
			'  context.setProp(context.global, "console", consoleObj);',
			"  consoleObj.dispose();",
		].join("\n");
		expect(() => injectJsExecWorkerStdout(consoleOnly)).toThrow(/_p\.versions|process\.stdout/i);
	});
});

describe("injectJsExecCommandStdin", () => {
	const src = readFileSync(jsExecChunkPath, "utf8");

	test("the pristine chunk builds a worker input with no stdin field", () => {
		// The js-exec worker input has the python keys plus bootstrapCode/
		// isModule/stripTypes between scriptPath and timeoutMs.
		expect(
			/scriptPath:\w+,bootstrapCode:\w+,isModule:\w+,stripTypes:\w+,timeoutMs:\w+\}/.test(src),
		).toBe(true);
		expect(src.includes(",stdin:")).toBe(false);
	});

	test("threads stdin into the worker input as data, EOF when stdin is the program", () => {
		const out = injectJsExecCommandStdin(src);
		expect(out).not.toBe(src);
		// stdin rides in as the piped DATA for -c / a script file, and EOF ("")
		// when stdin ITSELF was the program (bare piped program -> scriptPath
		// label "<stdin>"), matching how the worker labels that case.
		expect(
			/scriptPath:(\w+),bootstrapCode:\w+,isModule:\w+,stripTypes:\w+,timeoutMs:\w+,stdin:\(\1==="<stdin>"\)\?"":\w+\.stdin\}/.test(
				out,
			),
		).toBe(true);
	});

	test("throws on upstream drift (worker input shape changed)", () => {
		expect(() => injectJsExecCommandStdin("const x = {a:1,b:2};")).toThrow(/worker input/i);
	});
});
