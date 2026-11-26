import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every repository read compiles through the typed Kysely builder
 * (`query-builder.ts`). A raw `db.query(` / `db.prepare(` in a repository
 * module is a read that bypasses `BoundDatabase` column typing, so this test
 * pins the repository layer at zero raw reads.
 */
const REPOSITORIES_DIR = join(import.meta.dir, "..");
const RAW_READ = /\.(query|prepare)\s*[<(]/;

/**
 * Raw reads that stay raw, with the reason. `INTERRUPTED_TOOL_USE_SCAN_SQL` is
 * exported, re-exported from `cli/bootstrap.ts`, and pinned verbatim by
 * `cli/startup-wiring.test.ts`, so compiling it would change a public string.
 */
const ALLOWED_RAW_READS = new Set(["queries/interrupted-tool-use.ts"]);

function repositorySources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name === "__tests__") continue;
			out.push(...repositorySources(path));
		} else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
			out.push(path);
		}
	}
	return out;
}

describe("repository reads go through the query builder", () => {
	it("no repository module issues a raw db.query / db.prepare", () => {
		const offenders: string[] = [];
		for (const file of repositorySources(REPOSITORIES_DIR)) {
			const rel = relative(REPOSITORIES_DIR, file).split("\\").join("/");
			if (ALLOWED_RAW_READS.has(rel)) continue;
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				if (RAW_READ.test(line)) offenders.push(`${rel}:${i + 1}`);
			});
		}
		expect(offenders).toEqual([]);
	});
});
