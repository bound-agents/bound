import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { installBwrapVersionRunner, runBwrapVersion } from "../tools/bwrap-version";

const posix = process.platform !== "win32";

describe.skipIf(!posix)("runBwrapVersion", () => {
	let dir: string;
	beforeEach(() => {
		dir = join(tmpdir(), `bwrap-version-${randomBytes(4).toString("hex")}`);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => cleanupTmpDirSync(dir));

	function fakeBwrap(at: string, script: string, mode = 0o755): void {
		mkdirSync(at, { recursive: true });
		const p = join(at, "bwrap");
		writeFileSync(p, `#!/bin/sh\n${script}\n`);
		chmodSync(p, mode);
	}

	it("reports notFound when no bwrap is on PATH or in the fallbacks", () => {
		expect(runBwrapVersion({ path: join(dir, "empty"), fallbackDirectories: [] })).toEqual({
			kind: "notFound",
		});
	});

	it("returns the version output and path of the first executable bwrap", () => {
		fakeBwrap(join(dir, "a"), "echo 'bubblewrap 0.9.0'");
		fakeBwrap(join(dir, "b"), "echo 'bubblewrap 0.1.0'");
		const r = runBwrapVersion({
			path: `${join(dir, "a")}:${join(dir, "b")}`,
			fallbackDirectories: [],
		});
		expect(r).toEqual({
			kind: "output",
			path: join(dir, "a", "bwrap"),
			stdout: "bubblewrap 0.9.0\n",
		});
	});

	it("searches the fallback directories after PATH", () => {
		fakeBwrap(join(dir, "sbin"), "echo 'bubblewrap 0.11.0'");
		const r = runBwrapVersion({ path: "", fallbackDirectories: [join(dir, "sbin")] });
		expect(r.kind).toBe("output");
	});

	it("ignores relative PATH entries", () => {
		const r = runBwrapVersion({ path: "relative/bin", fallbackDirectories: [] });
		expect(r.kind).toBe("notFound");
	});

	it("reports a non-executable bwrap as failed", () => {
		fakeBwrap(join(dir, "nx"), "echo nope", 0o644);
		const r = runBwrapVersion({ path: join(dir, "nx"), fallbackDirectories: [] });
		expect(r).toMatchObject({ kind: "failed", status: null });
	});

	it("reports a non-zero exit with its status and stderr", () => {
		fakeBwrap(join(dir, "bad"), "echo broken >&2; exit 3");
		const r = runBwrapVersion({ path: join(dir, "bad"), fallbackDirectories: [] });
		expect(r).toEqual({ kind: "failed", status: 3, detail: "broken" });
	});

	it("bounds a hanging bwrap by the timeout", () => {
		fakeBwrap(join(dir, "hang"), "exec sleep 5");
		const r = runBwrapVersion({ path: join(dir, "hang"), fallbackDirectories: [], timeoutMs: 200 });
		expect(r).toEqual({ kind: "failed", status: null, detail: "timed out after 200ms" });
	});
});

describe("installBwrapVersionRunner", () => {
	it("publishes the runner on the global hook the SDK patch reads", () => {
		installBwrapVersionRunner();
		const hook = (globalThis as Record<string, unknown>).__boundBwrapVersionRunner;
		expect(typeof hook).toBe("function");
	});
});
