import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");

describe("Windows lowbox CI contract", () => {
	test("provides the built helper to both mandatory and recursive oracle execution", () => {
		const dedicatedHelperEnv =
			"BOUND_LOWBOX_HELPER: ${{ github.workspace }}\\dist\\bound-lowbox.exe";
		const conditionalHelperEnv =
			"BOUND_LOWBOX_HELPER: ${{ runner.os == 'Windows' && format('{0}\\\\dist\\\\bound-lowbox.exe', github.workspace) || '' }}";
		const mandatoryOracle = workflow.indexOf(
			"- name: Mandatory Windows AppContainer lowbox oracle",
		);
		const unitTests = workflow.indexOf("- name: Unit tests");

		expect(mandatoryOracle).toBeGreaterThan(-1);
		expect(unitTests).toBeGreaterThan(mandatoryOracle);
		expect(workflow.slice(mandatoryOracle, unitTests)).toContain(dedicatedHelperEnv);
		expect(workflow.slice(unitTests)).toContain(conditionalHelperEnv);
	});
});
