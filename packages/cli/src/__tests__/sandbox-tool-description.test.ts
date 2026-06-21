import { describe, expect, it } from "bun:test";
import { sandboxTool } from "../commands/start/agent-factory";

describe("sandboxTool description (AC4.3)", () => {
	it("sandboxTool description does NOT contain old command names", () => {
		const description = sandboxTool.function.description;

		// Should not reference old standalone commands
		expect(description).not.toContain("query");
		expect(description).not.toContain("memorize");
		expect(description).not.toContain("schedule");
		expect(description).not.toContain("purge");
		expect(description).not.toContain("advisory");
		expect(description).not.toContain("notify");
	});

	it("sandboxTool description DOES contain MCP reference", () => {
		const description = sandboxTool.function.description;

		// Should reference MCP as the mechanism for tool availability
		expect(description).toContain("MCP");
	});

	it("sandboxTool function has correct structure", () => {
		expect(sandboxTool.type).toBe("function");
		expect(sandboxTool.function.name).toBe("bms_bash");
		expect(typeof sandboxTool.function.description).toBe("string");
		expect(sandboxTool.function.parameters).toBeDefined();
		expect(sandboxTool.function.parameters.type).toBe("object");
		expect(sandboxTool.function.parameters.properties).toBeDefined();
		expect(sandboxTool.function.parameters.properties.command).toBeDefined();
	});

	it("sandboxTool exposes an optional timeout param matching boundless_bash", () => {
		const params = sandboxTool.function.parameters;
		// Same contract as boundless_bash: optional number, ms, not required.
		expect(params.properties.timeout).toBeDefined();
		expect(params.properties.timeout.type).toBe("number");
		expect(params.required).not.toContain("timeout");
		expect(params.required).toContain("command");
	});

	it("sandboxTool exposes an optional cwd param matching boundless_bash", () => {
		const params = sandboxTool.function.parameters;
		// Dedicated working-directory override: optional string, not required, so
		// directory changes go through the param instead of an inline `cd`.
		expect(params.properties.cwd).toBeDefined();
		expect(params.properties.cwd.type).toBe("string");
		expect(params.required).not.toContain("cwd");
	});

	it("sandboxTool description steers cwd changes to the param, not inline cd", () => {
		const description = sandboxTool.function.description;
		expect(description).toContain("cwd");
		// Old phrasing told the agent not to `cd`; the new phrasing points at the
		// param as the way to change directory.
		expect(description).not.toContain("do not prefix commands with a `cd`");
	});
});
