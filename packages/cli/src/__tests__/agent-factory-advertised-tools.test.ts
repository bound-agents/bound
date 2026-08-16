import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentTools } from "@bound/agent";

/**
 * Regression: agent tools were registered in the unified dispatch registry but
 * omitted from MainAgentLoop.config.tools. The LLM sees config.tools, so a
 * rebuilt boundless session advertised only boundless_* client tools and could
 * not call `yard` (or the other native agent tools) despite their registry
 * entries being executable.
 */
describe("advertised agent tool definitions", () => {
	it("includes yard among native definitions supplied to a main loop", () => {
		const tools = createAgentTools({
			db: {} as never,
			siteId: "site",
			threadId: "thread",
			eventBus: {} as never,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		});
		const advertised = tools.map((tool) => tool.toolDefinition.function.name);
		expect(advertised).toContain("yard");
		expect(advertised).toContain("aux");
		expect(advertised).toContain("memory");
	});

	it("advertises main and filtered aux native definitions instead of registry-only tools", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "commands", "start", "agent-factory.ts"),
			"utf8",
		);
		expect(source).toContain("...agentTools.map((tool) => tool.toolDefinition)");
		expect(source).toContain("...filteredAgentTools.map((tool) => tool.toolDefinition)");
	});
});
