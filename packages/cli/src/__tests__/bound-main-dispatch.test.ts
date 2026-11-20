import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { type CliIO, main } from "../bound-main";

/**
 * Dispatch-body coverage for the `bound` entry point's `start` error arm: the
 * lazy runStart import + createLogger error arm, lines that only execute when
 * runStart throws. The sibling bound-main.test.ts covers help/init/login/
 * defaultCliIO.
 *
 * `start`'s SUCCESS body boots a full node that blocks forever, so it is not
 * unit-testable; the error path is driven by pointing it at an uninitialized
 * config dir, where bootstrap fails fast and `main()` returns 1.
 */

function captureIO(): { io: CliIO; logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		io: { log: (m) => logs.push(m), error: (m) => errors.push(m) },
		logs,
		errors,
	};
}

describe("bound main() — start dispatch body", () => {
	it("maps a failed runStart to exit 1 (error arm executes)", async () => {
		const dir = mkdtempSync(join(tmpdir(), `bound-start-fail-${Date.now()}-`));
		try {
			// No config files under this dir → bootstrap throws → the start command's
			// catch arm (createLogger().error(...), return 1) runs.
			const { io } = captureIO();
			const code = await main(["start", "--config-dir", join(dir, "absent-config")], io);
			expect(code).toBe(1);
		} finally {
			cleanupTmpDirSync(dir);
		}
	}, 20000);
});
