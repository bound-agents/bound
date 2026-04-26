#!/usr/bin/env bun
/**
 * Compile the sandbox smoke driver with the same path-rewrite plugin the
 * main bound build uses, then execute it. This is the integration test
 * that proves python3 / js-exec work *inside* a Bun-compiled binary —
 * exactly the condition that broke before this branch.
 *
 * Runs standalone: `bun scripts/test-sandbox-compiled.ts`. Assumes
 * `bun scripts/build-sandbox-runtime.ts` has already run (build.ts
 * does this automatically; this script does it too for convenience).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
	// Ensure the _runtime staging exists — otherwise the embedded imports
	// in packages/sandbox/src/runtime/assets.ts won't resolve.
	if (!existsSync(resolve("packages/sandbox/src/_runtime/manifest.json"))) {
		console.log("Staging sandbox runtime first...");
		const r = spawnSync("bun", ["scripts/build-sandbox-runtime.ts"], { stdio: "inherit" });
		if (r.status !== 0) process.exit(r.status ?? 1);
	}

	const outfile = "dist/sandbox-smoke";
	console.log(`Compiling ${outfile}...`);
	const build = await Bun.build({
		entrypoints: [resolve("scripts/fixtures/sandbox-smoke.ts")],
		compile: {
			target: `bun-${process.platform}-${process.arch}` as `bun-${string}-${string}`,
			outfile,
		},
		plugins: [
			{
				name: "rewrite-just-bash-worker-paths",
				setup(build) {
					// Mirror scripts/build.ts's plugin exactly. Kept inline here
					// rather than shared so this script stays self-contained.
					const filterFor = (prefix: string) =>
						new RegExp(`dist/bundle/chunks/${prefix}-[A-Z0-9]+\\.js$`);
					const rewriteChunk = (kind: "python" | "jsExec", chunkPrefix: string) => {
						build.onLoad({ filter: filterFor(chunkPrefix) }, (args) => {
							const src = readFileSync(args.path, "utf8");
							const candidates = [
								'new URL("./worker.js",import.meta.url)',
								'new URL("./worker.js", import.meta.url)',
							];
							const needle = candidates.find((c) => src.includes(c));
							if (!needle) {
								throw new Error(
									`just-bash ${kind} chunk at ${args.path} missing expected URL pattern`,
								);
							}
							const replacement = `new URL("file://" + (globalThis.__boundSandboxWorkerPath__?.("${kind}") ?? (()=>{throw new Error("sandbox worker path not materialized; createSandbox() must run before just-bash commands")})()))`;
							return { contents: src.replace(needle, replacement), loader: "js" };
						});
					};
					rewriteChunk("python", "python3");
					rewriteChunk("jsExec", "js-exec");
				},
			},
		],
	});
	if (!build.success) {
		for (const l of build.logs) console.error(l);
		process.exit(1);
	}

	console.log(`Executing ${outfile}...`);
	const run = spawnSync(resolve(outfile), [], {
		stdio: "inherit",
		// Force a clean materialization on every run so we test the copy
		// path too, not just the cached fast-path.
		env: { ...process.env, BOUND_SANDBOX_RUNTIME_ROOT: "/tmp/bound-sandbox-smoke" },
	});

	// Clean up the binary; leave the materialized runtime for debugging.
	try {
		unlinkSync(outfile);
	} catch {}

	process.exit(run.status ?? 1);
}

main().catch((e) => {
	console.error("fatal:", e);
	process.exit(2);
});
