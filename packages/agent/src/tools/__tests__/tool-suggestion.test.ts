import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { RegisteredTool } from "../../types";
import { zodToToolParams } from "../tool-schema";
import { suggestCorrectTool, suggestToolByParams, suggestToolForAction } from "../tool-suggestion";

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

/**
 * Build a RegisteredTool with arbitrary named parameters (no action enum).
 * The param types don't matter for suggestion logic — only the names.
 */
function makeParamTool(name: string, paramNames: string[]): RegisteredTool {
	const shape: Record<string, z.ZodType> = {};
	for (const p of paramNames) shape[p] = z.string();
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name,
				description: `Tool ${name}`,
				parameters: zodToToolParams(z.object(shape)),
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

describe("suggestToolByParams", () => {
	it("suggests the tool whose param names match the rejected input", () => {
		// Reproduces an observed GPT-5.5 spin: model called `connector`
		// with boundless_search's param names and no action field.
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			[
				"boundless_search",
				makeParamTool("boundless_search", ["pattern", "path", "case_insensitive", "fixed_strings"]),
			],
		]);

		const suggestion = suggestToolByParams(
			"connector",
			{ pattern: "foo", path: ".", case_insensitive: false, fixed_strings: true },
			registry,
		);
		expect(suggestion).toContain("boundless_search");
	});

	it("returns undefined when the input params already match the called tool", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
		]);

		// action IS a connector param — no cross-tool suggestion
		expect(suggestToolByParams("connector", { action: "list" }, registry)).toBeUndefined();
	});

	it("returns undefined when no tool has better param overlap", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			["query", makeParamTool("query", ["sql"])],
		]);

		// "bogus" matches neither tool
		expect(suggestToolByParams("connector", { bogus: true }, registry)).toBeUndefined();
	});

	it("returns undefined when registry is absent", () => {
		expect(suggestToolByParams("connector", { pattern: "x" }, undefined)).toBeUndefined();
	});

	it("returns undefined when input is empty", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list"])],
		]);
		expect(suggestToolByParams("connector", {}, registry)).toBeUndefined();
	});
});

describe("suggestCorrectTool", () => {
	it("delegates to action suggestion when an action value is present", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			["skill", makeActionTool("skill", ["activate", "list", "read", "deactivate", "retire"])],
		]);

		const suggestion = suggestCorrectTool("connector", { action: "activate" }, registry);
		expect(suggestion).toContain("skill");
	});

	it("falls back to param-signature suggestion when there is no action field", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
			[
				"boundless_search",
				makeParamTool("boundless_search", ["pattern", "path", "case_insensitive", "fixed_strings"]),
			],
		]);

		const suggestion = suggestCorrectTool(
			"connector",
			{ pattern: "foo", path: ".", case_insensitive: false, fixed_strings: true },
			registry,
		);
		expect(suggestion).toContain("boundless_search");
	});

	it("returns undefined when neither strategy matches", () => {
		const registry = new Map<string, RegisteredTool>([
			["connector", makeActionTool("connector", ["list", "channels", "attach", "detach"])],
		]);

		expect(suggestCorrectTool("connector", { bogus: true }, registry)).toBeUndefined();
	});
});
