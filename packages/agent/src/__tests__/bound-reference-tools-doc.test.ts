/**
 * Freshness guard for the bound-reference skill's tool catalog.
 *
 * The bound-reference skill exists so a clean-setup agent doesn't hallucinate
 * about its own tools (issue #29). If a native agent tool is added or renamed
 * without documenting it in references/tools.md, this test fails — keeping the
 * shipped self-reference honest.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import { SOURCE_DIR } from "../../../../scripts/embed-bundled-skills";
import { createAgentTools } from "../tools/index.js";
import type { ToolContext } from "../types.js";

function nativeToolNames(): string[] {
	const db = new Database(":memory:");
	applySchema(db);
	db.exec("INSERT INTO host_meta (key, value) VALUES ('site_id', 'test-site')");
	const ctx: ToolContext = {
		db,
		siteId: "test-site",
		eventBus: { emit: () => {} } as any,
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
	};
	const names = createAgentTools(ctx).map((t) => t.toolDefinition.function.name);
	db.close();
	return names;
}

describe("bound-reference tools.md coverage", () => {
	const toolsMd = readFileSync(join(SOURCE_DIR, "bound-reference/references/tools.md"), "utf-8");

	it("documents every native agent tool with its own section", () => {
		const names = nativeToolNames();
		expect(names.length).toBeGreaterThan(0);
		const undocumented = names.filter((name) => !toolsMd.includes(`### \`${name}\``));
		expect(undocumented).toEqual([]);
	});
});
