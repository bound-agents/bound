import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";

describe("config round4 uncovered branches", () => {
	let testDir: string;

	beforeEach(() => {
		const hex = randomBytes(4).toString("hex");
		testDir = join(tmpdir(), `boundless-config-r4-${hex}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("evaluateJavaScriptConfig error path (config.ts 41-44) + errorMessage (18-22)", () => {
		it("surfaces a thrown Error's message from config.js (errorMessage object-with-message branch)", async () => {
			// A config.js default-export that throws an Error while evaluating drives
			// result.error → vm.dump → errorMessage(value) through the
			// `"message" in value` branch (config.ts lines 19-20).
			writeFileSync(
				join(testDir, "config.js"),
				'export default (() => { throw new Error("boom-from-js-config"); })();',
			);
			await expect(loadConfig(testDir)).rejects.toThrow(/boom-from-js-config/);
		});

		it("surfaces a thrown number from config.js (errorMessage String(value) branch)", async () => {
			// Throwing a primitive number means vm.dump yields a non-object value, so
			// errorMessage falls through to `return String(value)` (config.ts line 22).
			writeFileSync(join(testDir, "config.js"), "export default (() => { throw 42; })();");
			await expect(loadConfig(testDir)).rejects.toThrow(/42/);
		});

		it("surfaces a thrown string from config.js (errorMessage String(value) branch)", async () => {
			writeFileSync(join(testDir, "config.js"), 'export default (() => { throw "str-boom"; })();');
			await expect(loadConfig(testDir)).rejects.toThrow(/str-boom/);
		});

		it("rejects a config.js that does not export an object (guard throws, Error branch)", async () => {
			// The object guard inside evaluateJavaScriptConfig throws an Error whose
			// message carries the filename; it reaches errorMessage via the object branch.
			writeFileSync(join(testDir, "config.js"), "export default 123;");
			await expect(loadConfig(testDir)).rejects.toThrow(/must export an object/);
		});

		it("rejects a config.js referencing an undefined global (ReferenceError propagated)", async () => {
			writeFileSync(join(testDir, "config.js"), "export default someUndefinedGlobalR4;");
			await expect(loadConfig(testDir)).rejects.toThrow(/someUndefinedGlobalR4/);
		});
	});
});
