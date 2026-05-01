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
		expect(sandboxTool.function.name).toBe("bash");
		expect(typeof sandboxTool.function.description).toBe("string");
		expect(sandboxTool.function.parameters).toBeDefined();
		expect(sandboxTool.function.parameters.type).toBe("object");
		expect(sandboxTool.function.parameters.properties).toBeDefined();
		expect(sandboxTool.function.parameters.properties.command).toBeDefined();
	});
});
