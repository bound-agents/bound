import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CompilerCandidate {
	command: string;
	argsPrefix: string[];
	env?: Record<string, string>;
}

interface CompilerDiscoveryOptions {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	visualStudioRoots?: string[];
	windowsKitsRoot?: string;
}

function existingVisualStudioRoots(env: Record<string, string | undefined>): string[] {
	const base = join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft Visual Studio");
	if (!existsSync(base)) return [];
	const roots: string[] = [];
	for (const year of readdirSync(base, { withFileTypes: true })) {
		if (!year.isDirectory()) continue;
		const yearRoot = join(base, year.name);
		for (const edition of readdirSync(yearRoot, { withFileTypes: true })) {
			if (edition.isDirectory()) roots.push(join(yearRoot, edition.name));
		}
	}
	return roots;
}

export function compilerCandidates(options: CompilerDiscoveryOptions): CompilerCandidate[] {
	const candidates: CompilerCandidate[] = [
		{ command: "cl.exe", argsPrefix: [] },
		{ command: "clang-cl.exe", argsPrefix: [] },
	];
	if (options.platform === "win32") {
		for (const root of options.visualStudioRoots ?? existingVisualStudioRoots(options.env)) {
			const toolsets = join(root, "VC", "Tools", "MSVC");
			if (!existsSync(toolsets)) continue;
			for (const version of readdirSync(toolsets, { withFileTypes: true })) {
				if (!version.isDirectory()) continue;
				const executable = join(toolsets, version.name, "bin", "Hostx64", "x64", "cl.exe");
				if (!existsSync(executable)) continue;
				const windowsKits =
					options.windowsKitsRoot ??
					join(options.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10");
				const includeRoot = join(windowsKits, "Include");
				const libRoot = join(windowsKits, "Lib");
				if (!existsSync(includeRoot) || !existsSync(libRoot)) continue;
				const sdkVersion = readdirSync(includeRoot, { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && existsSync(join(libRoot, entry.name)))
					.map((entry) => entry.name)
					.sort()
					.at(-1);
				if (!sdkVersion) continue;
				const msvcRoot = join(toolsets, version.name);
				candidates.push({
					command: executable,
					argsPrefix: [],
					env: {
						INCLUDE: [
							join(msvcRoot, "include"),
							join(includeRoot, sdkVersion, "ucrt"),
							join(includeRoot, sdkVersion, "um"),
							join(includeRoot, sdkVersion, "shared"),
						].join(";"),
						LIB: [
							join(msvcRoot, "lib", "x64"),
							join(libRoot, sdkVersion, "ucrt", "x64"),
							join(libRoot, sdkVersion, "um", "x64"),
						].join(";"),
					},
				});
			}
		}
	}
	return candidates;
}

const STAGE_DIR = join(import.meta.dir, "..", "packages", "less", "src", "_lowbox");

/**
 * Compile `bound-lowbox.exe` from `packages/less/src/native/bound-lowbox.cpp`
 * into `dist/bound-lowbox.exe`. Returns the output path, or null on non-Windows
 * hosts (nothing to build there). Throws when no compiler can be found.
 */
export function compileLowboxHelper(): string | null {
	const root = join(import.meta.dir, "..");
	const source = join(root, "packages", "less", "src", "native", "bound-lowbox.cpp");
	const outputDir = join(root, "dist");
	const output = join(outputDir, "bound-lowbox.exe");

	if (process.platform !== "win32") {
		console.log("[build-lowbox-helper] Skipping native Windows helper on non-Windows host.");
		return null;
	}
	if (!existsSync(source)) throw new Error(`Missing lowbox helper source: ${source}`);
	mkdirSync(outputDir, { recursive: true });

	const compilerArgs = [
		"/nologo",
		"/std:c++17",
		"/EHsc",
		"/O2",
		source,
		`/Fe:${output}`,
		"userenv.lib",
		"advapi32.lib",
		"bcrypt.lib",
	];
	let lastError: unknown;
	for (const candidate of compilerCandidates({ platform: process.platform, env: process.env })) {
		try {
			execFileSync(candidate.command, [...candidate.argsPrefix, ...compilerArgs], {
				stdio: "inherit",
				env: { ...process.env, ...candidate.env },
			});
			return output;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`No supported Windows C++ compiler could build bound-lowbox.exe: ${String(lastError)}`,
	);
}

/**
 * Regenerate `packages/less/src/_lowbox/embedded.ts` — the importer
 * `bun build --compile` reads to embed the helper into the compiled boundless
 * (mirrors scripts/build-mxc-runtime.ts). With no staged helper (non-Windows,
 * or a Windows host with no compiler), the importer exports a null manifest so
 * the runtime loader cleanly no-ops.
 */
export function writeEmbeddedLowboxModule(
	stagedExe: string | null,
	stageDir: string = STAGE_DIR,
): void {
	rmSync(stageDir, { recursive: true, force: true });
	// The null-importer path writes embedded.ts too, so the stage dir must exist
	// on every platform — not only when a helper was staged (the original
	// Windows-only mkdir broke every non-Windows build with ENOENT here).
	mkdirSync(stageDir, { recursive: true });
	const lines = [
		"// AUTO-GENERATED by scripts/build-lowbox-helper.ts — do not edit.",
		"// Staged Windows AppContainer lowbox helper, embedded into the compiled",
		'// boundless via `with { type: "file" }`. Regenerated on postinstall and build.',
		"",
	];
	let helperDecl = "export const LOWBOX_EMBEDDED_HELPER: { path: string } | null = null;";
	let hash = "none";
	if (stagedExe) {
		const stagedBin = join(stageDir, "bound-lowbox.exe.lowboxbin");
		copyFileSync(stagedExe, stagedBin);
		helperDecl =
			'import bin0 from "./bound-lowbox.exe.lowboxbin" with { type: "file" };\n\n' +
			"export const LOWBOX_EMBEDDED_HELPER: { path: string } | null = { path: bin0 };";
		hash = createHash("sha256").update(readFileSync(stagedBin)).digest("hex").slice(0, 16);
	}
	lines.push(helperDecl, "", `export const LOWBOX_HELPER_HASH = ${JSON.stringify(hash)};`, "");
	writeFileSync(join(stageDir, "embedded.ts"), lines.join("\n"));
}

function buildLowboxHelper(): void {
	const output = compileLowboxHelper();

	// Regenerate the embedded importer on every platform so a stale staged
	// helper from a previous Windows checkout can't leak into a build.
	writeEmbeddedLowboxModule(output);

	if (!output) return;

	if (process.env.BOUND_LOWBOX_STAGE_BESIDE) {
		const destination = join(dirname(process.env.BOUND_LOWBOX_STAGE_BESIDE), "bound-lowbox.exe");
		if (destination !== output) copyFileSync(output, destination);
	}
	console.log(`[build-lowbox-helper] Built ${output} and staged it for embedding.`);
}

if (import.meta.main || import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const optional = process.argv.includes("--optional");
	try {
		buildLowboxHelper();
	} catch (error) {
		// Optional mode (postinstall): a host without a C++ toolchain still
		// installs cleanly with a null importer — the compiled binary falls back
		// to sibling/env resolution or the onUnavailable posture.
		if (!optional) throw error;
		console.warn(
			`[build-lowbox-helper] ${error instanceof Error ? error.message : String(error)} — continuing without an embedded helper.`,
		);
		writeEmbeddedLowboxModule(null);
	}
}
