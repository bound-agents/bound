import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("sandbox.ts imports (AC4.2)", () => {
	it("packages/cli/src/commands/start/sandbox.ts does NOT import getAllCommands", () => {
		const sandboxPath = resolve(__dirname, "..", "commands", "start", "sandbox.ts");
		const content = readFileSync(sandboxPath, "utf-8");

		// Should not contain the import statement for getAllCommands
		expect(content).not.toContain("getAllCommands");

		// Verify the file exists and is not empty
		expect(content.length).toBeGreaterThan(0);
	});

	it("sandbox.ts imports setCommandRegistry instead", () => {
		const sandboxPath = resolve(__dirname, "..", "commands", "start", "sandbox.ts");
		const content = readFileSync(sandboxPath, "utf-8");

		// Should import setCommandRegistry which replaces getAllCommands
		expect(content).toContain("setCommandRegistry");
	});
});
