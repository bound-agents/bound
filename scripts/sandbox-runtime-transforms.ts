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

/**
 * Command-side: thread piped stdin into the js-exec worker input object.
 *
 * Same shape as the python3 chunk but with three extra keys
 * (bootstrapCode/isModule/stripTypes) between scriptPath and timeoutMs. The
 * worker-protocol KEYS survive minification; the VALUE identifiers are
 * captured by pattern (env's receiver backreferenced to cwd's) and reused.
 *
 * stdin is the piped DATA for `-c` / a script file. It is EOF ("") when stdin
 * ITSELF was the program (a bare piped program, which the chunk labels
 * `scriptPath: "<stdin>"`), matching real `node`, which leaves fd 0 exhausted
 * after reading the script from it. js-exec has no `-` REPL form, so
 * `"<stdin>"` is the only stdin-as-program label to guard.
 */
export function injectJsExecCommandStdin(chunkSrc: string): string {
	const re =
		/jsCode:\w+,cwd:(\w+)\.cwd,env:\w+\(\1\.env\),args:\w+,scriptPath:(\w+),bootstrapCode:\w+,isModule:\w+,stripTypes:\w+,timeoutMs:\w+\}/;
	const m = re.exec(chunkSrc);
	if (!m) {
		throw new Error(
			"just-bash js-exec command chunk no longer builds the expected worker input object (jsCode/cwd/env/args/scriptPath/bootstrapCode/isModule/stripTypes/timeoutMs keys); upstream layout changed — cannot thread stdin (see bound#157)",
		);
	}
	const ctxVar = m[1]; // exec context; ctxVar.stdin holds the piped bytes
	const labelVar = m[2]; // script-source label
	const injected = `${m[0].slice(0, -1)},stdin:(${labelVar}==="<stdin>")?"":${ctxVar}.stdin}`;
	return chunkSrc.replace(m[0], injected);
}

/**
 * Worker-side: wire piped stdin into the js-exec QuickJS guest. Three
 * cooperating edits, each anchored on a stable upstream call site that
 * throws on drift.
 *
 * Unlike the python worker (one emscripten `Module.stdin` seam that FS.init
 * auto-mates onto fd 0), the js-exec guest is a QuickJS context behind a
 * hand-written Node-compat shim with no fd table, so stdin has to be grafted
 * onto every read surface a guest script actually uses:
 *
 *   1. Marshal the bytes across the host->guest boundary as a
 *      `globalThis.__boundStdin` string, sourced from the worker `input`
 *      object's `stdin` field, right where `input.env` is already injected.
 *   2. Special-case the three canonical stdin handles (fd `0`, `/dev/stdin`,
 *      `/proc/self/fd/0`) in `fs.readFileSync` so `readFileSync(0)` returns
 *      the data (Buffer, or string when an encoding is given) instead of
 *      ENOENT-ing on a path that does not exist in the guest FS.
 *   3. Define `process.stdin` (it was `undefined`) as a minimal readable over
 *      the same buffered string: the `data`/`end` event pattern, async
 *      iteration, `.read()`, `.setEncoding()`, and `.pipe()` — the surfaces a
 *      script reaching for `process.stdin` actually consumes. The data is
 *      already fully buffered, so the stream just flushes once on a microtask
 *      after the first consumer attaches.
 *
 * Edits 2 and 3 land inside a guest-eval'd template literal, so the injected
 * source must avoid backticks and `${...}` (it would interpolate at build
 * time, not run in the guest).
 */
export function injectJsExecWorkerStdin(workerSrc: string): string {
	// --- Edit 1: marshal input.stdin into the guest as __boundStdin ---
	const envAnchor = 'context.setProp(context.global, "env", envObj);\n  envObj.dispose();';
	if (!workerSrc.includes(envAnchor)) {
		throw new Error(
			'just-bash js-exec worker no longer injects input.env via setProp(context.global, "env", envObj); upstream layout changed — cannot marshal stdin into the guest (see bound#157)',
		);
	}
	const stdinMarshal = [
		envAnchor,
		'  const __boundStdinHandle = context.newString(typeof input.stdin === "string" ? input.stdin : "");',
		'  context.setProp(context.global, "__boundStdin", __boundStdinHandle);',
		"  __boundStdinHandle.dispose();",
	].join("\n");
	let out = workerSrc.replace(envAnchor, stdinMarshal);

	// --- Edit 2: serve fd 0 / /dev/stdin / /proc/self/fd/0 from readFileSync ---
	const fsAnchor = "_fs.readFileSync = function(path, opts) {";
	if (!out.includes(fsAnchor)) {
		throw new Error(
			"just-bash js-exec worker no longer defines _fs.readFileSync; upstream layout changed — cannot wire fd-0 reads (see bound#157)",
		);
	}
	const fsGuard = [
		fsAnchor,
		"    if (path === 0 || path === '/dev/stdin' || path === '/proc/self/fd/0') {",
		"      var __se = typeof opts === 'string' ? opts : (opts && opts.encoding);",
		"      var __sd = typeof globalThis.__boundStdin === 'string' ? globalThis.__boundStdin : '';",
		"      return __se ? __sd : Buffer.from(__sd);",
		"    }",
	].join("\n");
	out = out.replace(fsAnchor, fsGuard);

	// --- Edit 3: define process.stdin as a minimal readable over the buffer ---
	const procAnchor = "_p.version = 'v22.0.0';";
	if (!out.includes(procAnchor)) {
		throw new Error(
			"just-bash js-exec worker no longer sets _p.version; upstream layout changed — cannot wire process.stdin (see bound#157)",
		);
	}
	const stdinStream = [
		procAnchor,
		"  _p.stdin = (function () {",
		"    var __raw = typeof globalThis.__boundStdin === 'string' ? globalThis.__boundStdin : '';",
		"    var __enc = null, __ls = {}, __flushed = false;",
		"    function __payload() { return __enc ? __raw : Buffer.from(__raw); }",
		"    function __emit(ev, arg) { var fns = __ls[ev]; if (fns) for (var i = 0; i < fns.length; i++) fns[i](arg); }",
		"    function __flush() {",
		"      if (__flushed) return; __flushed = true;",
		"      if (__raw.length) __emit('data', __payload());",
		"      __emit('end'); __emit('close');",
		"    }",
		"    var s = {",
		"      fd: 0, readable: true, writable: false, isTTY: false,",
		"      setEncoding: function (e) { __enc = e; return s; },",
		"      on: function (ev, fn) { (__ls[ev] = __ls[ev] || []).push(fn); if (ev === 'data' || ev === 'end' || ev === 'readable') Promise.resolve().then(__flush); return s; },",
		"      addListener: function (ev, fn) { return s.on(ev, fn); },",
		"      once: function (ev, fn) { var w = function (a) { s.removeListener(ev, w); fn(a); }; return s.on(ev, w); },",
		"      removeListener: function (ev, fn) { var fns = __ls[ev]; if (fns) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); } return s; },",
		"      off: function (ev, fn) { return s.removeListener(ev, fn); },",
		"      emit: function (ev, arg) { __emit(ev, arg); return true; },",
		"      resume: function () { Promise.resolve().then(__flush); return s; },",
		"      pause: function () { return s; },",
		"      read: function () { if (__flushed) return null; __flushed = true; return __raw.length ? __payload() : null; },",
		"      pipe: function (dest) { Promise.resolve().then(function () { if (__raw.length && dest && dest.write) dest.write(__payload()); if (dest && dest.end) dest.end(); }); return dest; },",
		"      ref: function () { return s; }, unref: function () { return s; }, destroy: function () { return s; },",
		"    };",
		"    if (typeof Symbol !== 'undefined' && Symbol.asyncIterator) {",
		"      s[Symbol.asyncIterator] = function () {",
		"        var done = false;",
		"        return {",
		"          next: function () { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve(__raw.length ? { done: false, value: __payload() } : { done: true, value: undefined }); },",
		"          return: function () { done = true; return Promise.resolve({ done: true, value: undefined }); },",
		"        };",
		"      };",
		"    }",
		"    return s;",
		"  })();",
	].join("\n");
	out = out.replace(procAnchor, stdinStream);

	return out;
}

/**
 * Worker-side: wire `process.stdout` / `process.stderr` into the js-exec
 * QuickJS guest. just-bash leaves both `undefined` (the in-guest `process`
 * shim only gets `argv`/`cwd`/`exit`/`env`/`version`/`stdin`), so any script
 * reaching for `process.stdout.write(...)` — the no-newline counterpart to
 * `console.log`, used to control trailing newlines, print progress, or pipe
 * formatted output — throws `Cannot read properties of undefined`. The stdin
 * fix left the write side broken; this closes it.
 *
 * Two cooperating edits, mirroring the stdin graft's host/guest split:
 *
 *   1. Host side (setupContext): expose two raw writers,
 *      `__boundWriteStdout` / `__boundWriteStderr`, as `context.newFunction`s
 *      that call `backend.writeStdout` / `backend.writeStderr` — the SAME
 *      captured sink `console.log` / `console.error` already route to, minus
 *      the appended newline. This is NOT the host's real `process.stdout`
 *      (which just-bash's WorkerDefenseInDepth hardens against, and which is
 *      a different realm from the guest anyway): it is the interpreter's own
 *      gated output channel, so it grants no capability a guest script does
 *      not already have via `console.log`.
 *   2. Guest side: define `_p.stdout` / `_p.stderr` as minimal Node-shaped
 *      writable streams whose `.write(chunk, enc?, cb?)` coerces the chunk to
 *      a string (Buffer/typed-array via `.toString(enc)`) and hands it to the
 *      host writer, returning `true` (never backpressured — the host write is
 *      synchronous). `.end()`, `.cork()`/`.uncork()`, the event no-ops, and
 *      `fd`/`writable`/`isTTY` cover the surfaces real scripts touch.
 *
 * Edit 2 lands inside the same guest-eval'd template literal as the stdin
 * stream, so the injected source must avoid backticks and `${...}`.
 */
export function injectJsExecWorkerStdout(workerSrc: string): string {
	// --- Edit 1: expose raw (no-newline) host writers next to console ---
	const consoleAnchor = [
		'  context.setProp(context.global, "console", consoleObj);',
		"  consoleObj.dispose();",
	].join("\n");
	if (!workerSrc.includes(consoleAnchor)) {
		throw new Error(
			'just-bash js-exec worker no longer wires console via setProp(context.global, "console", consoleObj); upstream layout changed — cannot expose the raw stdout/stderr writers (see bound#157)',
		);
	}
	const hostWriters = [
		consoleAnchor,
		'  const __boundWriteStdoutFn = context.newFunction("__boundWriteStdout", (argHandle) => {',
		"    try {",
		"      backend.writeStdout(context.getString(argHandle));",
		"    } catch (e) {",
		'      return throwError(context, e.message || "write failed");',
		"    }",
		"    return context.undefined;",
		"  });",
		'  context.setProp(context.global, "__boundWriteStdout", __boundWriteStdoutFn);',
		"  __boundWriteStdoutFn.dispose();",
		'  const __boundWriteStderrFn = context.newFunction("__boundWriteStderr", (argHandle) => {',
		"    try {",
		"      backend.writeStderr(context.getString(argHandle));",
		"    } catch (e) {",
		'      return throwError(context, e.message || "write failed");',
		"    }",
		"    return context.undefined;",
		"  });",
		'  context.setProp(context.global, "__boundWriteStderr", __boundWriteStderrFn);',
		"  __boundWriteStderrFn.dispose();",
	].join("\n");
	let out = workerSrc.replace(consoleAnchor, hostWriters);

	// --- Edit 2: define process.stdout / process.stderr in the guest shim ---
	const procAnchor = "  _p.versions = { node: '22.0.0', quickjs: '2024' };";
	if (!out.includes(procAnchor)) {
		throw new Error(
			"just-bash js-exec worker no longer sets _p.versions; upstream layout changed — cannot wire process.stdout/stderr (see bound#157)",
		);
	}
	const writableStreams = [
		procAnchor,
		"  function __mkWritable(__hostWrite, __fd) {",
		"    var s = {",
		"      fd: __fd, writable: true, readable: false, isTTY: false,",
		"      write: function (chunk, enc, cb) {",
		"        var str;",
		"        if (typeof chunk === 'string') str = chunk;",
		"        else if (chunk && typeof chunk.toString === 'function') str = chunk.toString(typeof enc === 'string' ? enc : undefined);",
		"        else str = String(chunk);",
		"        if (typeof __hostWrite === 'function') __hostWrite(str);",
		"        var done = typeof enc === 'function' ? enc : cb;",
		"        if (typeof done === 'function') Promise.resolve().then(done);",
		"        return true;",
		"      },",
		"      end: function (chunk, enc, cb) {",
		"        if (chunk != null && typeof chunk !== 'function') s.write(chunk, typeof enc === 'function' ? undefined : enc);",
		"        var done = typeof chunk === 'function' ? chunk : (typeof enc === 'function' ? enc : cb);",
		"        if (typeof done === 'function') Promise.resolve().then(done);",
		"        return s;",
		"      },",
		"      on: function () { return s; }, once: function () { return s; },",
		"      addListener: function () { return s; }, removeListener: function () { return s; }, off: function () { return s; },",
		"      removeAllListeners: function () { return s; }, emit: function () { return false; },",
		"      cork: function () {}, uncork: function () {}, setDefaultEncoding: function () { return s; },",
		"      ref: function () { return s; }, unref: function () { return s; }, destroy: function () { return s; },",
		"    };",
		"    return s;",
		"  }",
		"  _p.stdout = __mkWritable(globalThis.__boundWriteStdout, 1);",
		"  _p.stderr = __mkWritable(globalThis.__boundWriteStderr, 2);",
	].join("\n");
	out = out.replace(procAnchor, writableStreams);

	return out;
}
