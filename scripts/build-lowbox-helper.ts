import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

function buildLowboxHelper(): void {
	const root = join(import.meta.dir, "..");
	const source = join(root, "packages", "less", "src", "native", "bound-lowbox.cpp");
	const outputDir = join(root, "dist");
	const output = join(outputDir, "bound-lowbox.exe");
	const boundless = join(outputDir, "boundless.exe");

	if (process.platform !== "win32") {
		console.log("[build-lowbox-helper] Skipping native Windows helper on non-Windows host.");
		return;
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
			if (process.env.BOUND_LOWBOX_STAGE_BESIDE) {
				const destination = join(
					dirname(process.env.BOUND_LOWBOX_STAGE_BESIDE),
					"bound-lowbox.exe",
				);
				if (destination !== output) copyFileSync(output, destination);
			}
			console.log(
				`[build-lowbox-helper] Built ${output} with ${candidate.command}${
					existsSync(boundless) ? " beside boundless.exe" : ""
				}.`,
			);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`No supported Windows C++ compiler could build bound-lowbox.exe: ${String(lastError)}`,
	);
}

if (import.meta.main || import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	buildLowboxHelper();
}
