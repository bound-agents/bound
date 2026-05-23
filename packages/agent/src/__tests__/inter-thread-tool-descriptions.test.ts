import { describe, expect, it } from "bun:test";
import { createIntrospectTool } from "../tools/introspect";
import { createNotifyTool } from "../tools/notify";

// Minimal mock context — only needed to instantiate the tool; execute is not called.
const mockCtx = {} as any;

describe("inter-thread tool descriptions", () => {
	it("introspect description includes collective pronoun guidance", () => {
		const tool = createIntrospectTool(mockCtx);
		const description = tool.toolDefinition.function.description;
		expect(description).toContain("we");
	});

	it("notify description includes collective pronoun guidance", () => {
		const tool = createNotifyTool(mockCtx);
		const description = tool.toolDefinition.function.description;
		expect(description).toContain("we");
	});
});
