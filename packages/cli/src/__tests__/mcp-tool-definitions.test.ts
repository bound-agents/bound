import { describe, expect, it } from "bun:test";
import { buildMcpToolDefinitions } from "../commands/start";

describe("buildMcpToolDefinitions", () => {
	it("produces one ToolDefinition per server name (AC4.1)", () => {
		const serverNames = new Set(["github", "notion"]);
		const defs = buildMcpToolDefinitions(serverNames);
		expect(defs).toHaveLength(2);
	});

	it("ToolDefinition name matches server name (AC4.1)", () => {
		const defs = buildMcpToolDefinitions(new Set(["github"]));
		expect(defs[0].function.name).toBe("github");
	});

	it("schema has subcommand as required string (AC4.2)", () => {
		const defs = buildMcpToolDefinitions(new Set(["github"]));
		const params = defs[0].function.parameters as {
			properties: Record<string, unknown>;
			required: string[];
			additionalProperties: boolean;
		};
		expect(params.required).toContain("subcommand");
		expect(params.additionalProperties).toBe(true);
		const subCmd = params.properties.subcommand as { type: string };
		expect(subCmd.type).toBe("string");
	});

	it("produces no per-tool entries (AC4.3)", () => {
		const serverNames = new Set(["github"]);
		const defs = buildMcpToolDefinitions(serverNames);
		// Names must exactly match the input server set — no per-tool entries like "github-create_issue"
		const names = defs.map((d) => d.function.name);
		expect(names).toEqual(["github"]);
		expect(names).not.toContain("github-create_issue");
		expect(names).not.toContain("github-list_prs");
	});

	it("returns empty array when no servers connected (AC4.1 edge)", () => {
		const defs = buildMcpToolDefinitions(new Set());
		expect(defs).toHaveLength(0);
	});

	it("description hints at subcommand='help' usage (AC4.2)", () => {
		const defs = buildMcpToolDefinitions(new Set(["github"]));
		expect(defs[0].function.description).toContain("subcommand");
		expect(defs[0].function.description).toContain("help");
	});
});
