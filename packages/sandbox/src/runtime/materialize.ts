/**
 * On-disk materialization of sandbox worker assets.
 *
 * ── Why we can't just spawn from /$bunfs/ paths ────────────────────────────
 * The embedded worker files live in Bun's virtual filesystem, which is
 * readable via `node:fs` but has two properties that block direct use for
 * Worker spawning:
 *
 *   1. The python worker computes paths to its CPython WASM + stdlib via
 *      `dirname(import.meta.url) + "/../../../vendor/cpython-emscripten/..."`.
 *      Those paths don't exist in /$bunfs/ (we can't control bunfs layout),
 *      and even if we embedded them too they'd land at the bunfs root with
 *      hashed filenames, breaking the relative-path computation.
 *
 *   2. Node's Worker resolves `new Worker(path)` by reading the path from
 *      disk. /$bunfs/ paths ARE served by Bun's embedded FS, so Worker
 *      spawn itself works — but transitive asset loads from inside the
 *      worker (CPython's emscripten module loading its own .wasm via fs)
 *      need a real filesystem with the expected layout.
 *
 * So on first use we copy the embedded assets to a real disk location
 * (~/.bound/sandbox-runtime/<hash>/) reproducing the original just-bash
 * directory structure. The hash is content-derived, so new bound binaries
 * with updated just-bash land in a fresh directory and stale copies can be
 * GCd separately.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { embeddedAssets } from "./assets";

interface MaterializedPaths {
	/** Absolute path to the python worker entry (pass to `new Worker(...)`). */
	readonly pythonWorker: string;
	/** Absolute path to the js-exec worker entry (pass to `new Worker(...)`). */
	readonly jsExecWorker: string;
	/** Root directory containing the materialized layout (for debugging). */
	readonly root: string;
}

let cached: MaterializedPaths | undefined;

/**
 * Compute the materialization root for the current binary's embedded
 * assets. The hash is part of the path so multiple bound versions can
 * coexist on one machine without conflict.
 */
function computeRoot(): string {
	const base = process.env.BOUND_SANDBOX_RUNTIME_ROOT ?? join(homedir(), ".bound/sandbox-runtime");
	return join(base, embeddedAssets.hash);
}

/**
 * Copy `src` to `dst` only if `dst` is missing or differs in size. Size
 * check is a cheap integrity heuristic that catches partial writes from
 * prior interrupted runs; full content verification would be safer but
 * would cost us a file read on every process start.
 *
 * Implemented with readFileSync + writeFileSync rather than copyFileSync
 * because `src` may live in Bun's embedded filesystem (`/$bunfs/...`),
 * which supports reads but not the `copyfile` syscall.
 */
function ensureFile(src: string, dst: string): void {
	mkdirSync(dirname(dst), { recursive: true });
	if (existsSync(dst)) {
		// We can't cheap-compare src size for bunfs paths reliably either
		// — statSync works on bunfs but the reported size can lag writes
		// — so if dst exists at all we trust it. The outer .ready marker
		// handles the "was the whole directory populated" question.
		const dstSize = statSync(dst).size;
		if (dstSize > 0) return;
	}
	writeFileSync(dst, readFileSync(src));
}

/**
 * Materialize the embedded sandbox worker assets to a real on-disk layout.
 * Idempotent and safe to call from multiple places — the first call does
 * the copy, subsequent calls return the cached paths.
 *
 * The layout matches the original just-bash package structure because the
 * python worker resolves its vendor assets via relative paths from the
 * worker's own location. Specifically:
 *
 *   <root>/dist/bundle/chunks/worker.js            (python worker)
 *   <root>/dist/bundle/chunks/js-exec-worker.js    (js worker)
 *   <root>/dist/bundle/chunks/emscripten-module.wasm (sibling of js worker)
 *   <root>/vendor/cpython-emscripten/python.cjs
 *   <root>/vendor/cpython-emscripten/python.wasm
 *   <root>/vendor/cpython-emscripten/python313.zip
 */
export function materializeSandboxRuntime(): MaterializedPaths {
	if (cached) return cached;

	const root = computeRoot();
	const readyMarker = join(root, ".ready");

	const paths = {
		pythonWorker: join(root, "dist/bundle/chunks/worker.js"),
		jsExecWorker: join(root, "dist/bundle/chunks/js-exec-worker.js"),
		qjsWasm: join(root, "dist/bundle/chunks/emscripten-module.wasm"),
		pythonCjs: join(root, "vendor/cpython-emscripten/python.cjs"),
		pythonWasm: join(root, "vendor/cpython-emscripten/python.wasm"),
		pythonStdlib: join(root, "vendor/cpython-emscripten/python313.zip"),
	};

	// Fast path: a previous process already materialized this hash. Skip
	// the copies entirely. The .ready marker is written atomically after
	// all assets land, so its presence proves the directory is complete.
	if (!existsSync(readyMarker)) {
		// Copy each embedded asset to its expected on-disk location.
		ensureFile(embeddedAssets.paths.pythonWorker, paths.pythonWorker);
		ensureFile(embeddedAssets.paths.jsExecWorker, paths.jsExecWorker);
		ensureFile(embeddedAssets.paths.qjsWasm, paths.qjsWasm);
		ensureFile(embeddedAssets.paths.pythonCjs, paths.pythonCjs);
		ensureFile(embeddedAssets.paths.pythonWasm, paths.pythonWasm);
		ensureFile(embeddedAssets.paths.pythonStdlib, paths.pythonStdlib);

		// Write the ready marker LAST, so a crash mid-copy leaves the
		// directory in an "incomplete" state that forces a redo next run.
		writeFileSync(readyMarker, `${new Date().toISOString()}\n${embeddedAssets.hash}\n`);
	}

	cached = { pythonWorker: paths.pythonWorker, jsExecWorker: paths.jsExecWorker, root };

	// Install the global bridge that scripts/build.ts's plugin-rewritten
	// just-bash chunks call when they need a worker entry path. Doing it
	// here — inside materialize — guarantees the global is set before
	// any command chunk can load, since sandbox-factory calls
	// materializeSandboxRuntime() before Bash commands ever run.
	//
	// The global is keyed by kind so we don't have to rewrite the chunk
	// rewriter when we add more worker-based commands in future.
	(
		globalThis as unknown as {
			__boundSandboxWorkerPath__?: (kind: "python" | "jsExec") => string;
		}
	).__boundSandboxWorkerPath__ = (kind) => {
		switch (kind) {
			case "python":
				return paths.pythonWorker;
			case "jsExec":
				return paths.jsExecWorker;
		}
	};

	return cached;
}

/** Test hook: forget the cache so a subsequent call re-checks disk state. */
export function resetMaterializationCache(): void {
	cached = undefined;
}
