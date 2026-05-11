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

	it("sandbox.ts registers commands via appContext.commandRegistry", () => {
		const sandboxPath = resolve(__dirname, "..", "commands", "start", "sandbox.ts");
		const content = readFileSync(sandboxPath, "utf-8");

		// Commands are registered through the AppContext.commandRegistry field, which
		// replaced the older `setCommandRegistry` helper. This guards against any
		// regression that bypasses controlled registration (e.g. by reintroducing the
		// global `getAllCommands` pull path).
		expect(content).toContain("appContext.commandRegistry");
	});
});
