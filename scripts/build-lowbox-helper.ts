import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "packages", "less", "src", "native", "bound-lowbox.cpp");
const outputDir = join(root, "dist");
const output = join(outputDir, "bound-lowbox.exe");
const boundless = join(outputDir, "boundless.exe");

if (process.platform !== "win32") {
	console.log("[build-lowbox-helper] Skipping native Windows helper on non-Windows host.");
	process.exit(0);
}
if (!existsSync(source)) throw new Error(`Missing lowbox helper source: ${source}`);
mkdirSync(outputDir, { recursive: true });

const candidates: Array<{ command: string; args: string[] }> = [
	{
		command: "cl.exe",
		args: [
			"/nologo",
			"/std:c++17",
			"/EHsc",
			"/O2",
			source,
			`/Fe:${output}`,
			"userenv.lib",
			"advapi32.lib",
			"bcrypt.lib",
		],
	},
	{
		command: "clang-cl.exe",
		args: [
			"/nologo",
			"/std:c++17",
			"/EHsc",
			"/O2",
			source,
			`/Fe:${output}`,
			"userenv.lib",
			"advapi32.lib",
			"bcrypt.lib",
		],
	},
];
let lastError: unknown;
for (const candidate of candidates) {
	try {
		execFileSync(candidate.command, candidate.args, { stdio: "inherit" });
		if (process.env.BOUND_LOWBOX_STAGE_BESIDE) {
			const destination = join(dirname(process.env.BOUND_LOWBOX_STAGE_BESIDE), "bound-lowbox.exe");
			if (destination !== output) copyFileSync(output, destination);
		}
		console.log(
			`[build-lowbox-helper] Built ${output} with ${candidate.command}${
				existsSync(boundless) ? " beside boundless.exe" : ""
			}.`,
		);
		process.exit(0);
	} catch (error) {
		lastError = error;
	}
}
throw new Error(
	`No supported Windows C++ compiler could build bound-lowbox.exe: ${String(lastError)}`,
);
