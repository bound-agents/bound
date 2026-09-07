/**
 * Sequential workspace typecheck runner.
 *
 * Replaces `bun run --filter "*" --parallel typecheck`, whose concurrent tsc
 * processes need more commit charge than a memory-constrained host has free
 * (observed live: repeated native V8 "Zone" OOM kills during the pre-commit
 * gate with ~2GB free). Bun's filtered runner schedules workspaces
 * concurrently even without --parallel, so an explicit loop is the only way
 * to bound memory to one compiler at a time.
 *
 * Usage: bun scripts/typecheck-all.ts [package ...]
 * Set BOUND_TYPECHECK_CONCURRENCY > 1 to restore parallelism where memory
 * allows (e.g. CI). Fails with the failing package names; the full set is
 * always reported so one early failure never hides the rest.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const root = process.cwd();
const parsedConcurrency = Number.parseInt(process.env.BOUND_TYPECHECK_CONCURRENCY ?? "1", 10);
const concurrency =
	Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 1;
const prefixed = concurrency > 1;

const available = readdirSync(join(root, "packages"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => {
		const pkgPath = join(root, "packages", name, "package.json");
		if (!existsSync(pkgPath)) return false;
		const scripts = JSON.parse(readFileSync(pkgPath, "utf8"))?.scripts;
		return typeof scripts?.typecheck === "string";
	})
	.sort();

const requested = process.argv.slice(2);
const packages =
	requested.length > 0 ? available.filter((name) => requested.includes(name)) : available;
const missing = requested.filter((name) => !available.includes(name));
if (missing.length > 0) {
	console.error(`[typecheck-all] no typecheck script in: ${missing.join(", ")}`);
	process.exit(1);
}
if (packages.length === 0) {
	console.error("[typecheck-all] no workspace package declares a typecheck script");
	process.exit(1);
}

function runPackage(pkg: string): Promise<boolean> {
	return new Promise((resolve) => {
		console.log(`[typecheck-all] ${pkg}: start`);
		const child = spawn(process.execPath, ["run", "typecheck"], {
			cwd: join(root, "packages", pkg),
		});
		const forward = (source: Readable | null, out: NodeJS.WriteStream) => {
			if (!source) return;
			source.setEncoding("utf8");
			let buffered = "";
			source.on("data", (chunk: string) => {
				if (!prefixed) {
					out.write(chunk);
					return;
				}
				buffered += chunk;
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) out.write(`[${pkg}] ${line}\n`);
			});
			source.on("end", () => {
				if (prefixed && buffered.length > 0) out.write(`[${pkg}] ${buffered}\n`);
			});
		};
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);
		child.on("error", (error) => {
			console.error(`[typecheck-all] ${pkg}: spawn failed (${error.message})`);
			resolve(false);
		});
		child.on("close", (code) => {
			if (code === 0) {
				console.log(`[typecheck-all] ${pkg}: ok`);
				resolve(true);
				return;
			}
			console.error(`[typecheck-all] ${pkg}: FAILED (exit ${code})`);
			resolve(false);
		});
	});
}

const results = new Map<string, boolean>();
let index = 0;
async function lane(): Promise<void> {
	while (index < packages.length) {
		const pkg = packages[index];
		index += 1;
		results.set(pkg, await runPackage(pkg));
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, packages.length) }, () => lane()));

const failed = packages.filter((pkg) => results.get(pkg) !== true);
if (failed.length > 0) {
	console.error(`[typecheck-all] failed: ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`[typecheck-all] all ${packages.length} package(s) passed`);
