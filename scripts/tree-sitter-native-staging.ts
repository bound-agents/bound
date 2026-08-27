import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const ELF_MACHINE = { amd64: 62, arm64: 183 } as const;
export type ReleaseArchitecture = keyof typeof ELF_MACHINE;

export function normalizeReleaseArchitecture(arch: string): ReleaseArchitecture {
	if (arch === "x64" || arch === "amd64") return "amd64";
	if (arch === "arm64" || arch === "aarch64") return "arm64";
	throw new Error(`unsupported Linux release architecture: ${arch}`);
}

function loaderArchitecture(arch: ReleaseArchitecture): "x64" | "arm64" {
	return arch === "amd64" ? "x64" : "arm64";
}

export function readElfMachine(bytes: Uint8Array): number {
	if (
		bytes.length < 20 ||
		bytes[0] !== 0x7f ||
		bytes[1] !== 0x45 ||
		bytes[2] !== 0x4c ||
		bytes[3] !== 0x46
	)
		throw new Error("not an ELF file");
	const little = bytes[5] === 1;
	if (!little && bytes[5] !== 2) throw new Error(`unsupported ELF byte order: ${bytes[5]}`);
	return little ? bytes[18] | (bytes[19] << 8) : (bytes[18] << 8) | bytes[19];
}

export function elfMachineName(machine: number): string {
	if (machine === ELF_MACHINE.amd64) return "x86-64";
	if (machine === ELF_MACHINE.arm64) return "AArch64";
	return `ELF machine ${machine}`;
}

export function treeSitterImports(source: string): string[] {
	return [...source.matchAll(/^import\s+(?:.+?\s+from\s+)?["'](tree-sitter(?:-[^"']+)?)["'];?$/gm)]
		.map((match) => match[1])
		.filter((name) => name !== "tree-sitter")
		.filter((name, index, all) => all.indexOf(name) === index)
		.sort();
}

export interface NativePackageManifestEntry {
	packageName: string;
	packageRoot: string;
	loaderRelativePath?: string;
	prebuildPath?: string;
	buildTargetName: string;
	buildOutputPath: string;
}

/** Extract the compile-time Bun branch's package-specific addon filename from the real loader. */
export function loaderPrebuildPath(
	packageRoot: string,
	arch: ReleaseArchitecture,
	loaderSource: string,
): string {
	const match = loaderSource.match(
		/prebuilds\/\$\{process\.platform\}-\$\{process\.arch\}\/([^`"')\s]+)/,
	);
	if (!match) throw new Error("loader does not select a package-specific Linux prebuild");
	return join(packageRoot, "prebuilds", `linux-${loaderArchitecture(arch)}`, match[1]);
}

function loaderRelativePath(loaderSource: string): string | undefined {
	const match = loaderSource.match(
		/prebuilds\/\$\{process\.platform\}-\$\{process\.arch\}\/([^`"')\s]+)/,
	);
	return match ? `prebuilds/${"${process.platform}"}-${"${process.arch}"}/${match[1]}` : undefined;
}

function bindingTargetName(bindingGyp: string, packageName: string): string {
	const match = bindingGyp.match(/["']target_name["']\s*:\s*["']([^"']+)["']/);
	if (!match) throw new Error(`${packageName}: binding.gyp has no target_name`);
	return match[1];
}

export function buildNativePackageManifest(
	packageNames: readonly string[],
	workspaceRoot: string,
	arch: ReleaseArchitecture,
): NativePackageManifestEntry[] {
	return packageNames.map((packageName) => {
		const packageRoot = resolve(workspaceRoot, "packages/shared/node_modules", packageName);
		const loaderSource = readFileSync(join(packageRoot, "bindings/node/index.js"), "utf8");
		const bindingGyp = readFileSync(join(packageRoot, "binding.gyp"), "utf8");
		const buildTargetName = bindingTargetName(bindingGyp, packageName);
		const relative = loaderRelativePath(loaderSource);
		return {
			packageName,
			packageRoot,
			loaderRelativePath: relative,
			prebuildPath: relative ? loaderPrebuildPath(packageRoot, arch, loaderSource) : undefined,
			buildTargetName,
			buildOutputPath: join(packageRoot, "build", "Release", `${buildTargetName}.node`),
		};
	});
}

async function audit(path: string, arch: ReleaseArchitecture): Promise<string | undefined> {
	try {
		const bytes = new Uint8Array(await readFile(path));
		const machine = readElfMachine(bytes);
		return machine === ELF_MACHINE[arch]
			? undefined
			: `${path}: expected ${elfMachineName(ELF_MACHINE[arch])}, found ${elfMachineName(machine)}`;
	} catch (error) {
		return `${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function rebuild(entry: NativePackageManifestEntry, destination: string): Promise<void> {
	await rm(join(entry.packageRoot, "build"), { recursive: true, force: true });
	const process = Bun.spawn(["node-gyp", "rebuild"], {
		cwd: entry.packageRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await process.exited;
	if (code !== 0) throw new Error(`${entry.packageName}: node-gyp rebuild exited ${code}`);
	await stat(entry.buildOutputPath).catch(() => {
		throw new Error(`${entry.packageName}: rebuild did not produce ${entry.buildOutputPath}`);
	});
	if (destination !== entry.buildOutputPath) {
		await mkdir(dirname(destination), { recursive: true });
		await Bun.write(destination, Bun.file(entry.buildOutputPath));
	}
}

export async function stageTreeSitterNativeAddons(options: {
	workspaceRoot: string;
	arch: ReleaseArchitecture;
}): Promise<void> {
	const sourcePath = join(options.workspaceRoot, "packages/shared/src/read-structure.ts");
	const packageNames = treeSitterImports(await readFile(sourcePath, "utf8"));
	if (packageNames.length === 0)
		throw new Error(`${sourcePath}: no Tree-sitter grammar imports found`);
	const entries = buildNativePackageManifest(packageNames, options.workspaceRoot, options.arch);
	console.log(`Auditing ${entries.length} Tree-sitter native packages for Linux ${options.arch}`);
	for (const entry of entries) {
		const destination = entry.prebuildPath ?? entry.buildOutputPath;
		const problem = await audit(destination, options.arch);
		if (problem) {
			console.log(
				`${entry.packageName}: ${problem}; rebuilding ${entry.buildTargetName} from shipped binding.gyp`,
			);
			await rebuild(entry, destination);
		}
		const remaining = await audit(destination, options.arch);
		if (remaining)
			throw new Error(
				`${entry.packageName}: native binding audit failed after rebuild: ${remaining}`,
			);
		console.log(
			`${entry.packageName}: ${destination} (${elfMachineName(ELF_MACHINE[options.arch])})`,
		);
	}
}

if (import.meta.main) {
	if (process.platform !== "linux") throw new Error("Tree-sitter native staging is Linux-only");
	await stageTreeSitterNativeAddons({
		workspaceRoot: resolve(import.meta.dir, ".."),
		arch: normalizeReleaseArchitecture(process.arch),
	});
}
