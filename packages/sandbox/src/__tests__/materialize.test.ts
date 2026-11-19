import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embeddedAssets } from "../runtime/assets";
import { materializeSandboxRuntime, resetMaterializationCache } from "../runtime/materialize";

/**
 * Tests for on-disk materialization of embedded sandbox worker assets.
 *
 * materializeSandboxRuntime() copies the embedded worker/vendor assets from
 * Bun's embedded FS (/$bunfs/) to a real on-disk layout rooted at
 * ~/.bound/sandbox-runtime/<hash>/, so Node's Worker spawn and CPython's
 * emscripten transitive asset loads see a real filesystem with the expected
 * layout. The root is overridable via BOUND_SANDBOX_RUNTIME_ROOT so these
 * tests never touch the real home directory.
 *
 * The function is memoized (process-global `cached`) and installs a global
 * worker-path bridge; resetMaterializationCache() is the documented test hook
 * that forgets the memo so a subsequent call re-checks disk state.
 */

const WORKER_BRIDGE_KEY = "__boundSandboxWorkerPath__";

type WorkerBridge = (kind: "python" | "jsExec" | "sqlite3") => string;

function getBridge(): WorkerBridge | undefined {
	return (globalThis as unknown as Record<string, WorkerBridge | undefined>)[WORKER_BRIDGE_KEY];
}

describe("materializeSandboxRuntime", () => {
	let root: string;
	let prevEnv: string | undefined;
	let prevBridge: WorkerBridge | undefined;

	beforeEach(() => {
		prevEnv = process.env.BOUND_SANDBOX_RUNTIME_ROOT;
		prevBridge = getBridge();
		root = mkdtempSync(join(tmpdir(), "sandbox-runtime-"));
		process.env.BOUND_SANDBOX_RUNTIME_ROOT = root;
		resetMaterializationCache();
	});

	afterEach(() => {
		resetMaterializationCache();
		if (prevEnv === undefined) process.env.BOUND_SANDBOX_RUNTIME_ROOT = undefined;
		else process.env.BOUND_SANDBOX_RUNTIME_ROOT = prevEnv;
		(globalThis as unknown as Record<string, WorkerBridge | undefined>)[WORKER_BRIDGE_KEY] =
			prevBridge;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	test("copies every embedded asset to its hashed on-disk layout and writes a .ready marker", () => {
		const paths = materializeSandboxRuntime();

		const hashRoot = join(root, embeddedAssets.hash);
		// The returned root is <base>/<hash>, versioned so multiple binaries coexist.
		expect(paths.root).toBe(hashRoot);

		// Worker entries land at the just-bash-compatible chunk layout.
		expect(paths.pythonWorker).toBe(join(hashRoot, "dist/bundle/chunks/worker.js"));
		expect(paths.jsExecWorker).toBe(join(hashRoot, "dist/bundle/chunks/js-exec-worker.js"));
		expect(paths.sqliteWorker).toBe(join(hashRoot, "dist/bundle/chunks/sqlite3-worker.js"));

		// All eight copied assets exist on disk with non-zero content.
		for (const p of [
			paths.pythonWorker,
			paths.jsExecWorker,
			paths.sqliteWorker,
			join(hashRoot, "dist/bundle/chunks/emscripten-module.wasm"),
			join(hashRoot, "dist/bundle/chunks/sql-wasm.wasm"),
			join(hashRoot, "vendor/cpython-emscripten/python.cjs"),
			join(hashRoot, "vendor/cpython-emscripten/python.wasm"),
			join(hashRoot, "vendor/cpython-emscripten/python313.zip"),
		]) {
			expect(existsSync(p)).toBe(true);
			expect(statSync(p).size).toBeGreaterThan(0);
		}

		// The ready marker is written LAST and records the hash it covers.
		const marker = join(hashRoot, ".ready");
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8")).toContain(embeddedAssets.hash);
	});

	test("installs a global worker-path bridge keyed by worker kind", () => {
		const paths = materializeSandboxRuntime();
		const bridge = getBridge();
		expect(typeof bridge).toBe("function");

		expect(bridge?.("python")).toBe(paths.pythonWorker);
		expect(bridge?.("jsExec")).toBe(paths.jsExecWorker);
		expect(bridge?.("sqlite3")).toBe(paths.sqliteWorker);
	});

	test("is memoized: a second call returns the same object without re-copying", () => {
		const first = materializeSandboxRuntime();
		const marker = join(root, embeddedAssets.hash, ".ready");
		const firstMarker = readFileSync(marker, "utf8");

		const second = materializeSandboxRuntime();
		// Same cached object identity — the memo short-circuits computeRoot/copies.
		expect(second).toBe(first);
		// Marker untouched (not rewritten with a new timestamp).
		expect(readFileSync(marker, "utf8")).toBe(firstMarker);
	});

	test("after resetMaterializationCache, a ready directory takes the fast path (no re-copy)", () => {
		materializeSandboxRuntime();
		const marker = join(root, embeddedAssets.hash, ".ready");
		const markerBefore = readFileSync(marker, "utf8");

		// Forget the in-process memo but leave the populated directory + .ready.
		resetMaterializationCache();
		const second = materializeSandboxRuntime();

		// Paths still resolve, and the fast path skipped the copy block entirely:
		// the .ready marker was not rewritten.
		expect(second.pythonWorker).toBe(
			join(root, embeddedAssets.hash, "dist/bundle/chunks/worker.js"),
		);
		expect(readFileSync(marker, "utf8")).toBe(markerBefore);
	});

	test("re-copies an asset whose on-disk size dropped to zero (partial-write recovery)", () => {
		const paths = materializeSandboxRuntime();

		// Simulate a prior interrupted run: truncate one copied asset to 0 bytes
		// and remove the .ready marker so the copy block runs again.
		writeFileSync(paths.pythonWorker, "");
		expect(statSync(paths.pythonWorker).size).toBe(0);
		rmSync(join(root, embeddedAssets.hash, ".ready"));

		resetMaterializationCache();
		materializeSandboxRuntime();

		// ensureFile saw dst size 0 and rewrote it from the embedded source.
		expect(statSync(paths.pythonWorker).size).toBeGreaterThan(0);
	});
});
