import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Importing @bound/llm must be side-effect-free with respect to the
// filesystem. `bridge/stream.ts` used to call createLogger() at module scope,
// and createLogger() materializes the pino root, which mkdirs `logs/` and
// opens `logs/bound.log` under process.cwd() (synchronously). boundless
// imports @bound/llm for image-budget constants and never logs through pino,
// so an eager logger here dropped a 0-byte logs/bound.log into whatever
// directory boundless happened to run from. This test spawns a fresh process
// with a temp cwd, imports the package index, and asserts no log file appears.
const indexUrl = join(import.meta.dir, "../index.ts");

describe("@bound/llm import side effects", () => {
	it("does not create logs/bound.log in cwd when imported", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "llm-import-side-effect-"));
		try {
			// LOG_LEVEL must be a real level (not "silent") in the child: the
			// silent branch of getRootLogger() skips file creation entirely,
			// which would make this test pass even with an eager logger.
			const script = `import(${JSON.stringify(indexUrl)}).catch((e) => { console.error(e); process.exit(1); });`;
			const proc = Bun.spawn([process.execPath, "-e", script], {
				cwd: tmp,
				env: { ...process.env, LOG_LEVEL: "info" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			const stderr = await new Response(proc.stderr).text();
			expect(code, `import failed: ${stderr}`).toBe(0);
			expect(existsSync(join(tmp, "logs", "bound.log"))).toBe(false);
		} finally {
			rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});
});
