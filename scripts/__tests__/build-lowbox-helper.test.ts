import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilerCandidates } from "../build-lowbox-helper";

describe("Windows lowbox compiler discovery", () => {
	it("finds Visual Studio cl.exe and its Windows SDK environment off PATH", () => {
		const root = mkdtempSync(join(tmpdir(), "lowbox-visual-studio-"));
		const kits = mkdtempSync(join(tmpdir(), "lowbox-windows-kits-"));
		const msvcRoot = join(root, "VC", "Tools", "MSVC", "14.41.34120");
		const compiler = join(msvcRoot, "bin", "Hostx64", "x64", "cl.exe");
		const sdk = "10.0.26100.0";
		mkdirSync(join(compiler, ".."), { recursive: true });
		writeFileSync(compiler, "");
		mkdirSync(join(kits, "Include", sdk), { recursive: true });
		mkdirSync(join(kits, "Lib", sdk), { recursive: true });

		expect(
			compilerCandidates({
				platform: "win32",
				env: { PATH: "C:\\Windows\\System32" },
				visualStudioRoots: [root],
				windowsKitsRoot: kits,
			}),
		).toEqual([
			{ command: "cl.exe", argsPrefix: [] },
			{ command: "clang-cl.exe", argsPrefix: [] },
			{
				command: compiler,
				argsPrefix: [],
				env: {
					INCLUDE: [
						join(msvcRoot, "include"),
						join(kits, "Include", sdk, "ucrt"),
						join(kits, "Include", sdk, "um"),
						join(kits, "Include", sdk, "shared"),
					].join(";"),
					LIB: [
						join(msvcRoot, "lib", "x64"),
						join(kits, "Lib", sdk, "ucrt", "x64"),
						join(kits, "Lib", sdk, "um", "x64"),
					].join(";"),
				},
			},
		]);
	});

	it("does not add Visual Studio compilers on other platforms", () => {
		expect(
			compilerCandidates({ platform: "linux", env: {}, visualStudioRoots: ["ignored"] }),
		).toEqual([
			{ command: "cl.exe", argsPrefix: [] },
			{ command: "clang-cl.exe", argsPrefix: [] },
		]);
	});
});
