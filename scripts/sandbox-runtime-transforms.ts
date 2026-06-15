/**
 * Pure string transforms that wire piped stdin into just-bash's WASM
 * CPython runtime. Factored out of the build scripts so they are
 * unit-testable in isolation (no build side effects on import) and so a
 * single drift guard covers both the `bound` binary path (build.ts chunk
 * rewrite) and the materialized worker path (build-sandbox-runtime.ts).
 *
 * THE BUG (bound-agents/bound#157): just-bash never installs a stdin
 * device on fd 0 of the sandboxed runtimes. The js-exec face fails loud
 * (`process.stdin` undefined, `fs.readFileSync(0)` -> ENOENT). The python3
 * face fails SILENT: any read of `sys.stdin` (or fd 0) blocks on
 * emscripten's empty default TTY — no data, no EOF — until the worker's
 * 10s deadman timer kills the process with EXIT=124, which misreads as a
 * network timeout. The silent variant is the more dangerous one.
 *
 * THE FIX is two cooperating edits:
 *   1. Worker side (injectPythonWorkerStdin): install a Module.stdin byte
 *      reader. Emscripten's `FS.init` does `input ??= Module["stdin"]` and
 *      hands it to `createStandardStreams`, which registers it as fd 0's
 *      char device. The reader returns one byte (0-255) per call and
 *      `null` at EOF. `null` is load-bearing: the emscripten read loop
 *      treats `undefined` with zero bytes read as EAGAIN and re-blocks,
 *      while `null` is a clean EOF. This alone converts the silent hang
 *      into an immediate empty read.
 *   2. Command side (injectPythonCommandStdin): thread the piped bytes
 *      from the exec context into the worker input object so reads return
 *      actual DATA, not just EOF.
 */

/**
 * Worker-side: inject a `Module.stdin` byte reader as the first option of
 * the `createPythonModule({...})` call, sourced from the worker `input`
 * object's `stdin` field. Throws if the call site is gone (upstream drift).
 */
export function injectPythonWorkerStdin(workerSrc: string): string {
	const needle = "createPythonModule({";
	if (!workerSrc.includes(needle)) {
		throw new Error(
			"just-bash python worker no longer contains a createPythonModule({ ... }) call; upstream layout changed — cannot wire the stdin device (see bound#157)",
		);
	}
	// Returns a byte (0-255) per call, null at EOF. UTF-8 bytes so Python
	// decodes multibyte input from the raw stream. `input` is the worker
	// input object already in scope at this call site.
	const stdinReader =
		'stdin: (() => { const __jbStdin = new TextEncoder().encode(typeof input.stdin === "string" ? input.stdin : ""); let __jbPos = 0; return () => __jbPos < __jbStdin.length ? __jbStdin[__jbPos++] : null; })(),';
	return workerSrc.replace(needle, `${needle}\n      ${stdinReader}`);
}

/**
 * Command-side: thread piped stdin into the python3 worker input object.
 *
 * The object's KEYS (protocolToken/sharedBuffer/pythonCode/cwd/env/args/
 * scriptPath/timeoutMs) are the worker protocol contract and survive
 * minification; the VALUE identifiers are minified, so they are captured
 * by pattern (with a backreference tying `env`'s receiver to `cwd`'s) and
 * reused — robust to upstream variable renames.
 *
 * stdin is the piped DATA for `-c` / `-m` / a script file. It is EOF ("")
 * when stdin itself WAS the program (`python3 -` or a bare piped program),
 * matching real CPython, which leaves fd 0 exhausted after reading the
 * script from it. The script-source label var (`"-"` / `"<stdin>"` /
 * `"-c"` / module / filename) is what disambiguates the two cases.
 */
export function injectPythonCommandStdin(chunkSrc: string): string {
	const re = /cwd:(\w+)\.cwd,env:\w+\(\1\.env\),args:\w+,scriptPath:(\w+),timeoutMs:(\w+)\}/;
	const m = re.exec(chunkSrc);
	if (!m) {
		throw new Error(
			"just-bash python3 command chunk no longer builds the expected worker input object (cwd/env/args/scriptPath/timeoutMs keys); upstream layout changed — cannot thread stdin (see bound#157)",
		);
	}
	const ctxVar = m[1]; // exec context; ctxVar.stdin holds the piped bytes
	const labelVar = m[2]; // script-source label
	const injected = `${m[0].slice(0, -1)},stdin:(${labelVar}==="-"||${labelVar}==="<stdin>")?"":${ctxVar}.stdin}`;
	return chunkSrc.replace(m[0], injected);
}
