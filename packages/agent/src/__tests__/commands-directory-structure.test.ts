import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("commands directory structure (AC4.1)", () => {
	it("packages/agent/src/commands/ contains only index.ts and registry.ts", () => {
		const commandsDir = resolve(__dirname, "..", "commands");
		const files = readdirSync(commandsDir);

		// Filter out any hidden files or directories that may appear during test execution
		const visibleFiles = files
			.filter((f) => !f.startsWith(".") && f !== "node_modules" && f !== "__pycache__")
			.sort();

		// Should only contain index.ts and registry.ts
		expect(visibleFiles).toEqual(["index.ts", "registry.ts"]);

		// Verify no command handler files exist (e.g., query.ts, schedule.ts, etc.)
		const prohibitedPatterns = [
			"query.ts",
			"schedule.ts",
			"memorize.ts",
			"purge.ts",
			"advisory.ts",
		];
		for (const pattern of prohibitedPatterns) {
			expect(visibleFiles.includes(pattern)).toBe(false);
		}
	});
});
