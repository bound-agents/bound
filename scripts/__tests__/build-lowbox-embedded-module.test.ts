import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEmbeddedLowboxModule } from "../build-lowbox-helper";

describe("writeEmbeddedLowboxModule", () => {
	it("writes a null importer when no helper is staged (non-Windows hosts)", () => {
		const stageDir = join(mkdtempSync(join(tmpdir(), "lowbox-stage-")), "_lowbox");
		try {
			writeEmbeddedLowboxModule(null, stageDir);
			const generated = readFileSync(join(stageDir, "embedded.ts"), "utf8");
			expect(generated).toContain("LOWBOX_EMBEDDED_HELPER: { path: string } | null = null");
			expect(generated).toContain('LOWBOX_HELPER_HASH = "none"');
			expect(generated).not.toContain("lowboxbin");
		} finally {
			rmSync(join(stageDir, ".."), { recursive: true, force: true });
		}
	});

	it("stages the helper and emits a file-embedding importer when one is built", () => {
		const work = mkdtempSync(join(tmpdir(), "lowbox-stage-"));
		try {
			const exe = join(work, "bound-lowbox.exe");
			writeFileSync(exe, "MZ-fake-helper");
			const stageDir = join(work, "_lowbox");
			writeEmbeddedLowboxModule(exe, stageDir);
			expect(existsSync(join(stageDir, "bound-lowbox.exe.lowboxbin"))).toBe(true);
			const generated = readFileSync(join(stageDir, "embedded.ts"), "utf8");
			expect(generated).toContain('import bin0 from "./bound-lowbox.exe.lowboxbin"');
			expect(generated).not.toContain('LOWBOX_HELPER_HASH = "none"');
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
