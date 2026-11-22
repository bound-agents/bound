/**
 * Compile-time patch for mxc's Linux `bwrap --version` probe.
 *
 * `@microsoft/mxc-sdk/dist/v1/platform.js` runs the probe through an eval'd
 * worker that `import()`s `dist/bwrap-probe-worker.js` from the package on
 * disk and re-spawns `process.execPath` with two more package scripts. None of
 * that exists in a `bun build --compile` binary, so `getPlatformSupport()`
 * reported bubblewrap unavailable on every Linux host ("Cannot find module
 * '/dist/bwrap-probe-worker.js'").
 *
 * The patch makes the SDK's default runner defer to
 * `globalThis.__boundBwrapVersionRunner` when it is set. boundless sets it to
 * `runBwrapVersion` (`packages/less/src/tools/bwrap-version.ts`), which runs
 * `bwrap --version` with a bounded `spawnSync` and returns the SDK's runner
 * contract, so the SDK's version parsing and minimum-version gate still apply.
 * Unset, the SDK's own runner runs unchanged.
 *
 * The anchor is asserted so an SDK change to the runner fails the build
 * instead of shipping a binary whose Linux sandbox is silently unavailable.
 */
import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";

export const MXC_BWRAP_RUNNER_ANCHOR =
	"function defaultBwrapVersionRunner() {\n    return _runBwrapVersionCommand();";

export function patchMxcBwrapProbeSource(source: string): string {
	if (!source.includes(MXC_BWRAP_RUNNER_ANCHOR)) {
		throw new Error(
			"patch-mxc-bwrap-probe: mxc's defaultBwrapVersionRunner changed shape (anchor missing in dist/v1/platform.js). The compiled binary would report bubblewrap unavailable on Linux. Re-verify the mxc-sdk version and update scripts/mxc-bwrap-probe-plugin.ts.",
		);
	}
	return source.replace(
		MXC_BWRAP_RUNNER_ANCHOR,
		"function defaultBwrapVersionRunner() {\n    if (typeof globalThis.__boundBwrapVersionRunner === 'function') return globalThis.__boundBwrapVersionRunner();\n    return _runBwrapVersionCommand();",
	);
}

export function patchMxcBwrapProbePlugin(): BunPlugin {
	return {
		name: "patch-mxc-bwrap-probe",
		setup(build) {
			build.onLoad({ filter: /mxc-sdk[\\/]dist[\\/]v1[\\/]platform\.js$/ }, (args) => ({
				contents: patchMxcBwrapProbeSource(readFileSync(args.path, "utf8")),
				loader: "js",
			}));
		},
	};
}
