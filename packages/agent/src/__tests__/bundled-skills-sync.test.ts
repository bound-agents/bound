/**
 * CI sync-guard: the committed bundled-skills.generated.ts must match what the
 * codegen produces from the source markdown. If this fails, run:
 *   bun run scripts/embed-bundled-skills.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	OUTPUT,
	SOURCE_DIR,
	loadBundledSkillsFromDir,
	renderGeneratedModule,
} from "../../../../scripts/embed-bundled-skills";
import { BUNDLED_SKILLS } from "../bundled-skills";

describe("bundled-skills generated module", () => {
	it("is in sync with the source markdown (run embed-bundled-skills.ts if this fails)", () => {
		const expected = renderGeneratedModule(loadBundledSkillsFromDir(SOURCE_DIR));
		const committed = readFileSync(OUTPUT, "utf-8");
		expect(committed).toBe(expected);
	});

	it("committed BUNDLED_SKILLS deep-equals the source markdown", () => {
		const fromSource = loadBundledSkillsFromDir(SOURCE_DIR);
		expect(BUNDLED_SKILLS).toEqual(fromSource);
	});

	it("every bundled skill has a SKILL.md with matching name", () => {
		for (const skill of BUNDLED_SKILLS) {
			const skillMd = skill.files.find((f) => f.path === "SKILL.md");
			expect(skillMd).toBeDefined();
			expect(skill.name.length).toBeGreaterThan(0);
			expect(skill.description.length).toBeGreaterThan(0);
		}
	});
});
