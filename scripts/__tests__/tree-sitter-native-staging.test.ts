import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ELF_MACHINE,
	buildNativePackageManifest,
	loaderPrebuildPath,
	normalizeReleaseArchitecture,
	readElfMachine,
	treeSitterImports,
} from "../tree-sitter-native-staging";

const root = join(import.meta.dir, "../..");
const expectedNativePaths = {
	"tree-sitter-bash": ["tree-sitter-bash.node", "tree_sitter_bash_binding"],
	"tree-sitter-c": ["tree-sitter-c.node", "tree_sitter_c_binding"],
	"tree-sitter-cpp": ["tree-sitter-cpp.node", "tree_sitter_cpp_binding"],
	"tree-sitter-go": ["tree-sitter-go.node", "tree_sitter_go_binding"],
	"tree-sitter-java": ["tree-sitter-java.node", "tree_sitter_java_binding"],
	"tree-sitter-kotlin": [undefined, "tree_sitter_kotlin_binding"],
	"tree-sitter-python": ["tree-sitter-python.node", "tree_sitter_python_binding"],
	"tree-sitter-ruby": ["tree-sitter-ruby.node", "tree_sitter_ruby_binding"],
	"tree-sitter-rust": ["tree-sitter-rust.node", "tree_sitter_rust_binding"],
	"tree-sitter-swift": [undefined, "tree_sitter_swift_binding"],
} as const;

function elf(machine: number, littleEndian = true): Uint8Array {
	const bytes = new Uint8Array(20);
	bytes.set([0x7f, 0x45, 0x4c, 0x46]);
	bytes[5] = littleEndian ? 1 : 2;
	bytes[18] = littleEndian ? machine & 0xff : machine >> 8;
	bytes[19] = littleEndian ? machine >> 8 : machine & 0xff;
	return bytes;
}

describe("Tree-sitter native release staging", () => {
	it("reads isolated x86-64 and AArch64 ELF machine fixtures", () => {
		expect(readElfMachine(elf(ELF_MACHINE.amd64))).toBe(62);
		expect(readElfMachine(elf(ELF_MACHINE.arm64, false))).toBe(183);
		expect(() => readElfMachine(new Uint8Array(20))).toThrow("not an ELF file");
	});

	it("normalizes release runner architecture names", () => {
		expect(normalizeReleaseArchitecture("x64")).toBe("amd64");
		expect(normalizeReleaseArchitecture("aarch64")).toBe("arm64");
		expect(() => normalizeReleaseArchitecture("riscv64")).toThrow("unsupported");
	});

	it("derives every staged filename from the installed Bun loader and binding.gyp target", () => {
		const source = readFileSync(join(root, "packages/shared/src/read-structure.ts"), "utf8");
		const packageNames = treeSitterImports(source);
		expect(packageNames).toEqual(Object.keys(expectedNativePaths));

		const manifest = buildNativePackageManifest(packageNames, root, "amd64");
		for (const entry of manifest) {
			const expected = expectedNativePaths[entry.packageName as keyof typeof expectedNativePaths];
			if (!expected) throw new Error(`missing expected native path for ${entry.packageName}`);
			const [prebuildFilename, targetName] = expected;
			const loader = readFileSync(join(entry.packageRoot, "bindings/node/index.js"), "utf8");
			const bindingGyp = readFileSync(join(entry.packageRoot, "binding.gyp"), "utf8");
			expect(bindingGyp).toContain(`\"target_name\": \"${targetName}\"`);
			expect(entry.buildTargetName).toBe(targetName);
			expect(entry.buildOutputPath).toEndWith(`build/Release/${targetName}.node`);
			if (prebuildFilename) {
				expect(loader).toContain(
					`prebuilds/${"${process.platform}"}-${"${process.arch}"}/${prebuildFilename}`,
				);
				expect(entry.loaderRelativePath).toBe(
					`prebuilds/${"${process.platform}"}-${"${process.arch}"}/${prebuildFilename}`,
				);
				expect(entry.prebuildPath).toEndWith(`prebuilds/linux-x64/${prebuildFilename}`);
			} else {
				expect(loader).toContain('require("node-gyp-build")');
				expect(entry.loaderRelativePath).toBeUndefined();
				expect(entry.prebuildPath).toBeUndefined();
			}
		}
	});

	it("does not synthesize a generic node.napi filename", () => {
		expect(() =>
			loaderPrebuildPath("/pkg", "amd64", "const binding = require('node-gyp-build')(root);"),
		).toThrow("does not select a package-specific Linux prebuild");
	});
});
