import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { RegisteredTool } from "../../types";
import { zodToToolParams } from "../tool-schema";
import { suggestToolForAction } from "../tool-suggestion";

/**
 * Build a RegisteredTool whose JSON-schema `action` param is produced by the
 * same zodToToolParams path the real tools use — so the suggestion logic sees
 * the exact shape it'll encounter in production.
 */
function makeActionTool(name: string, actions: string[]): RegisteredTool {
	const schema = z.object({
		action: z.enum(actions as [string, ...string[]]),
	});
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name,
				description: `Tool ${name}`,
				parameters: zodToToolParams(schema),
			},
		},
	};
}

describe("suggestToolForAction", () => {
	it("suggests the tool that accepts the rejected action value", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			["skill", makeActionTool("skill", ["activate", "list", "read", "deactivate", "retire"])],
		]);

		// Model called "connector" with "activate" — that belongs to "skill"
		const suggestion = suggestToolForAction("connector", { action: "activate" }, registry);
		expect(suggestion).toContain("skill");
		expect(suggestion).toContain("activate");
	});

	it("returns undefined when no other tool accepts the action", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			["skill", makeActionTool("skill", ["activate", "list", "read", "deactivate", "retire"])],
		]);

		// "frobnicate" is not valid for any tool
		expect(suggestToolForAction("connector", { action: "frobnicate" }, registry)).toBeUndefined();
	});

	it("returns undefined when the action IS valid for the called tool", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			["skill", makeActionTool("skill", ["activate", "list", "read", "deactivate", "retire"])],
		]);

		// "list" is valid for connector — no suggestion needed
		expect(suggestToolForAction("connector", { action: "list" }, registry)).toBeUndefined();
	});

	it("returns undefined when input has no action field", () => {
		const registry = new Map<string, RegisteredTool>([
			["skill", makeActionTool("skill", ["activate"])],
		]);
		expect(suggestToolForAction("query", { sql: "SELECT 1" }, registry)).toBeUndefined();
	});

	it("returns undefined when registry is not provided", () => {
		expect(suggestToolForAction("connector", { action: "activate" }, undefined)).toBeUndefined();
	});

	it("handles tools without an action param gracefully", () => {
		const registry = new Map<string, RegisteredTool>([
			[
				"query",
				{
					kind: "builtin",
					toolDefinition: {
						type: "function",
						function: {
							name: "query",
							description: "SQL query",
							parameters: { type: "object", properties: { sql: { type: "string" } } },
						},
					},
				},
			],
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
		]);

		expect(suggestToolForAction("query", { action: "attach" }, registry)).toContain("connector");
	});
});
