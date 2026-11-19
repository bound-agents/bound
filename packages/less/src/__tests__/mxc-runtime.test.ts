import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMxcRuntime } from "../tools/mxc-runtime";

/**
 * Exercises the materialization body of ensureMxcRuntime through its test-only
 * `deps` seam (isolated latch, temp baseDir, synthetic assets) so we never
 * touch the real `~/.bound` or trip the once-per-process module latch. The
 * production call path (no args) is covered elsewhere by the SDK probe; here we
 * prove the write/skip/chmod decisions against the real filesystem.
 */
describe("ensureMxcRuntime materialization", () => {
	let tmp: string;
	let binDirSaved: string | undefined;
	let srcBin: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mxc-runtime-"));
		srcBin = join(tmp, "source-binary");
		writeFileSync(srcBin, "MXC-BINARY-BYTES");
		// The body short-circuits when MXC_BIN_DIR is set; clear it so the write
		// path runs, and restore the ambient value afterward.
		binDirSaved = process.env.MXC_BIN_DIR;
		Reflect.deleteProperty(process.env, "MXC_BIN_DIR");
	});

	afterEach(() => {
		if (binDirSaved === undefined) Reflect.deleteProperty(process.env, "MXC_BIN_DIR");
		else process.env.MXC_BIN_DIR = binDirSaved;
		rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("writes each embedded asset to <baseDir>/<hash>/<arch>/<name> and points MXC_BIN_DIR there", () => {
		const base = join(tmp, "out");
		ensureMxcRuntime({
			latch: { done: false },
			baseDir: base,
			hash: "deadbeef",
			assets: [{ name: "mxc-exec", arch: "arm64", executable: true, path: srcBin }],
		});

		const root = join(base, "deadbeef");
		const dest = join(root, "arm64", "mxc-exec");
		expect(existsSync(dest)).toBe(true);
		expect(readFileSync(dest, "utf8")).toBe("MXC-BINARY-BYTES");
		expect(process.env.MXC_BIN_DIR).toBe(root);
	});

	it("marks an executable asset mode 0o755 and leaves a non-executable asset untouched", () => {
		const base = join(tmp, "modes");
		ensureMxcRuntime({
			latch: { done: false },
			baseDir: base,
			hash: "h1",
			assets: [
				{ name: "exec-bin", arch: "x64", executable: true, path: srcBin },
				{ name: "data-blob", arch: "x64", executable: false, path: srcBin },
			],
		});

		const execDest = join(base, "h1", "x64", "exec-bin");
		const dataDest = join(base, "h1", "x64", "data-blob");
		expect(existsSync(execDest)).toBe(true);
		expect(existsSync(dataDest)).toBe(true);
		if (process.platform !== "win32") {
			// chmod ran on the executable asset; the mode bits include the 0o755 set.
			expect(statSync(execDest).mode & 0o777).toBe(0o755);
		}
	});

	it("skips an asset whose destination already exists (idempotent re-stage)", () => {
		const base = join(tmp, "idem");
		const latch = { done: false };
		ensureMxcRuntime({
			latch,
			baseDir: base,
			hash: "h2",
			assets: [{ name: "bin", arch: "arm64", executable: false, path: srcBin }],
		});
		const dest = join(base, "h2", "arm64", "bin");
		// Mutate the materialized file, then re-run with a fresh latch: the
		// existing-dest guard must NOT overwrite it.
		writeFileSync(dest, "LOCAL-EDIT");
		process.env.MXC_BIN_DIR = undefined;
		ensureMxcRuntime({
			latch: { done: false },
			baseDir: base,
			hash: "h2",
			assets: [{ name: "bin", arch: "arm64", executable: false, path: srcBin }],
		});
		expect(readFileSync(dest, "utf8")).toBe("LOCAL-EDIT");
	});

	it("no-ops when the latch is already done — the materialization body never runs", () => {
		const base = join(tmp, "latched");
		ensureMxcRuntime({
			latch: { done: true },
			baseDir: base,
			hash: "h3",
			assets: [{ name: "bin", arch: "arm64", executable: true, path: srcBin }],
		});
		expect(existsSync(join(base, "h3"))).toBe(false);
		expect(process.env.MXC_BIN_DIR).toBeUndefined();
	});

	it("respects a pre-set MXC_BIN_DIR and does not stage over an operator override", () => {
		const base = join(tmp, "override");
		process.env.MXC_BIN_DIR = "/operator/chosen/dir";
		ensureMxcRuntime({
			latch: { done: false },
			baseDir: base,
			hash: "h4",
			assets: [{ name: "bin", arch: "arm64", executable: true, path: srcBin }],
		});
		expect(existsSync(join(base, "h4"))).toBe(false);
		expect(process.env.MXC_BIN_DIR).toBe("/operator/chosen/dir");
	});

	it("no-ops on an empty asset list and leaves MXC_BIN_DIR unset", () => {
		ensureMxcRuntime({
			latch: { done: false },
			baseDir: join(tmp, "empty"),
			hash: "h5",
			assets: [],
		});
		expect(process.env.MXC_BIN_DIR).toBeUndefined();
	});
});
