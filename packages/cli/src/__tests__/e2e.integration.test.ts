import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runStart } from "../commands/start/index.js";

describe("Bound CLI start — missing config", () => {
	let tempDir: string;

	beforeEach(() => {
		// Use the OS temp dir so test directories don't litter the repo root.
		tempDir = mkdtempSync(join(tmpdir(), "bound-e2e-"));
	});

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	it("graceful handling of missing config during start", async () => {
		// initBootstrap derives `dataDir = dirname(resolve(configDir))/data`. Pass a
		// `<tempDir>/config` path so that the resulting dataDir lands at
		// `<tempDir>/data` (inside the tempDir cleaned up by afterEach), rather than
		// at the parent of tempDir which is the OS tmpdir root.
		const configDir = join(tempDir, "config");
		await expect(runStart({ configDir })).rejects.toThrow();
	});
});
