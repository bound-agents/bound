/**
 * End-to-end js-exec execution under `bun test`.
 *
 * These tests spawn the real just-bash js-exec worker through `createSandbox`.
 * Out of the box `bun test` cannot link that worker: the just-bash command
 * chunk computes `new Worker(new URL("./js-exec-worker.js", import.meta.url))`,
 * which resolves to the raw `node_modules/just-bash/.../js-exec-worker.js` —
 * a file whose top-level `import { stripTypeScriptTypes } from "node:module"`
 * Bun cannot link, so the worker dies and the command hangs to its deadman
 * timer. The compiled `bound` binary avoids this because `scripts/build.ts`'s
 * `justBashWorkerRewritePlugin` rewrites the chunk's `new URL(...)` to consult
 * `globalThis.__boundSandboxWorkerPath__("jsExec")`, pointing at the shimmed
 * materialized worker. `scripts/test-preload.ts` registers the SAME rewrite as
 * a runtime `Bun.plugin()` so this path matches the binary — see bound#157.
 *
 * If these tests start hanging or failing with a worker-link error, the
 * test-preload plugin registration regressed (or just-bash's chunk layout
 * drifted and the rewrite needle no longer matches).
 */

import { describe, expect, test } from "bun:test";
import { createClusterFs } from "../cluster-fs";
import { createSandbox } from "../sandbox-factory";

async function makeSandbox() {
	const fs = createClusterFs({ hostName: "localhost", syncEnabled: false });
	return createSandbox({ clusterFs: fs, commands: [] });
}

describe("js-exec execution (end-to-end worker spawn)", () => {
	test("runs a trivial script and captures stdout", async () => {
		const sandbox = await makeSandbox();
		const result = await sandbox.bash.exec("js-exec -c 'console.log(\"hello from js-exec\")'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello from js-exec");
	});

	test("process.stdout.write reaches stdout without a trailing newline", async () => {
		const sandbox = await makeSandbox();
		const result = await sandbox.bash.exec("js-exec -c 'process.stdout.write(\"abc\")'");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("abc");
	});

	test("piped stdin is readable via fs.readFileSync(0)", async () => {
		const sandbox = await makeSandbox();
		const result = await sandbox.bash.exec(
			'echo -n world | js-exec -c \'const fs=require("fs");process.stdout.write(fs.readFileSync(0,"utf8"))\'',
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("world");
	});
});
