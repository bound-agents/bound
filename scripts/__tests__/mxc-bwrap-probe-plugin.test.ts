import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MXC_BWRAP_RUNNER_ANCHOR, patchMxcBwrapProbeSource } from "../mxc-bwrap-probe-plugin";

const root = join(import.meta.dir, "../..");

function installedPlatformJs(): string {
	const manifest = Bun.resolveSync(
		"@microsoft/mxc-sdk/package.json",
		join(root, "packages", "less"),
	);
	return readFileSync(join(dirname(manifest), "dist", "v1", "platform.js"), "utf8");
}

describe("patchMxcBwrapProbeSource", () => {
	it("finds its anchor in the installed mxc-sdk", () => {
		expect(installedPlatformJs()).toContain(MXC_BWRAP_RUNNER_ANCHOR);
	});

	it("routes the default runner through the global hook when set", () => {
		const patched = patchMxcBwrapProbeSource(installedPlatformJs());
		expect(patched).toContain("globalThis.__boundBwrapVersionRunner()");
		expect(patched).toContain("return _runBwrapVersionCommand();");
	});

	it("runs the hook, and falls back to the SDK runner when the hook is unset", () => {
		const src = `${MXC_BWRAP_RUNNER_ANCHOR}\n}\nfunction _runBwrapVersionCommand() { return "sdk"; }\nreturn defaultBwrapVersionRunner();`;
		const run = new Function(patchMxcBwrapProbeSource(src)) as () => unknown;
		const g = globalThis as Record<string, unknown>;
		const saved = g.__boundBwrapVersionRunner;
		try {
			g.__boundBwrapVersionRunner = undefined;
			expect(run()).toBe("sdk");
			g.__boundBwrapVersionRunner = () => "hook";
			expect(run()).toBe("hook");
		} finally {
			g.__boundBwrapVersionRunner = saved;
		}
	});

	it("fails loudly when the SDK runner changes shape", () => {
		expect(() => patchMxcBwrapProbeSource("function other() {}")).toThrow(/anchor missing/);
	});
});
