import { describe, expect, it } from "bun:test";
import {
	parseFailures,
	parseSuiteTotals,
	renderAnnotations,
	renderSummaryMarkdown,
} from "../ci-test-summary";

// A real-shape passing suite, as emitted by `bun test --reporter=junit`.
const PASS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="5" failures="0" skipped="0" time="0.1234567">
  <testsuite name="packages/less/src/acp/__tests__/mapping.test.ts" file="packages/less/src/acp/__tests__/mapping.test.ts" tests="3" assertions="5" failures="0" skipped="0" time="0" hostname="">
    <testsuite name="toolCallMeta" file="packages/less/src/acp/__tests__/mapping.test.ts" line="34" tests="3" assertions="5" failures="0" skipped="0" time="0" hostname="">
      <testcase name="includes Zed&apos;s programmatic tool name metadata" classname="toolCallMeta" time="0.0003" file="packages/less/src/acp/__tests__/mapping.test.ts" line="35" assertions="1" />
      <testcase name="includes terminal metadata for shell tools" classname="toolCallMeta" time="0.00007" file="packages/less/src/acp/__tests__/mapping.test.ts" line="41" assertions="1" />
      <testcase name="includes sandbox authorization write paths for host writes" classname="toolCallMeta" time="0.0003" file="packages/less/src/acp/__tests__/mapping.test.ts" line="47" assertions="3" />
    </testsuite>
  </testsuite>
</testsuites>`;

// A real-shape suite with one failure (empty <failure> element, as bun emits).
const FAIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="2" failures="1" skipped="0" time="0.0591209">
  <testsuite name="packages/agent/src/__tests__/probe.test.ts" file="packages/agent/src/__tests__/probe.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0" hostname="">
    <testsuite name="probe suite" file="packages/agent/src/__tests__/probe.test.ts" line="2" tests="2" assertions="2" failures="1" skipped="0" time="0.001" hostname="">
      <testcase name="this one fails on purpose" classname="probe suite" time="0.0014" file="packages/agent/src/__tests__/probe.test.ts" line="3" assertions="1">
        <failure type="AssertionError" />
      </testcase>
      <testcase name="this one passes" classname="probe suite" time="0.00009" file="packages/agent/src/__tests__/probe.test.ts" line="6" assertions="1" />
    </testsuite>
  </testsuite>
</testsuites>`;

describe("parseSuiteTotals", () => {
	it("reads the root testsuites counters", () => {
		expect(parseSuiteTotals(PASS_XML)).toEqual({
			tests: 3,
			assertions: 5,
			failures: 0,
			skipped: 0,
			time: 0.1234567,
		});
	});

	it("reads counters off a failing suite", () => {
		expect(parseSuiteTotals(FAIL_XML)).toMatchObject({ tests: 2, failures: 1, skipped: 0 });
	});

	it("returns zeroed counters when there is no testsuites element", () => {
		expect(parseSuiteTotals("<nothing/>")).toEqual({
			tests: 0,
			assertions: 0,
			failures: 0,
			skipped: 0,
			time: 0,
		});
	});
});

describe("parseFailures", () => {
	it("returns nothing for an all-passing suite", () => {
		expect(parseFailures(PASS_XML)).toEqual([]);
	});

	it("extracts the failing testcase with decoded fields", () => {
		expect(parseFailures(FAIL_XML)).toEqual([
			{
				name: "this one fails on purpose",
				classname: "probe suite",
				file: "packages/agent/src/__tests__/probe.test.ts",
				line: 3,
				type: "AssertionError",
			},
		]);
	});

	it("decodes XML entities in the test name", () => {
		const xml = `<testsuites tests="1" failures="1" skipped="0">
      <testcase name="handles a &lt;tag&gt; &amp; an &apos;apostrophe&apos;" classname="suite" file="x.test.ts" line="9">
        <failure type="Error" />
      </testcase>
    </testsuites>`;
		expect(parseFailures(xml)[0]?.name).toBe("handles a <tag> & an 'apostrophe'");
	});
});

describe("renderSummaryMarkdown", () => {
	it("renders a per-package table and an all-green note", () => {
		const md = renderSummaryMarkdown([
			{ pkg: "less", totals: parseSuiteTotals(PASS_XML), failures: parseFailures(PASS_XML) },
		]);
		expect(md).toContain("| less | 3 | 3 | 0 | 0 |");
		expect(md).toContain("All 3 tests passed");
		expect(md).not.toContain("Failures");
	});

	it("lists failing tests with file:line when there are failures", () => {
		const md = renderSummaryMarkdown([
			{ pkg: "less", totals: parseSuiteTotals(PASS_XML), failures: parseFailures(PASS_XML) },
			{ pkg: "agent", totals: parseSuiteTotals(FAIL_XML), failures: parseFailures(FAIL_XML) },
		]);
		// pass column for agent = tests - failures - skipped = 2 - 1 - 0 = 1
		expect(md).toContain("| agent | 2 | 1 | 1 | 0 |");
		expect(md).toContain("Failures (1)");
		expect(md).toContain("packages/agent/src/__tests__/probe.test.ts:3");
		expect(md).toContain("probe suite");
		expect(md).toContain("this one fails on purpose");
	});

	it("handles an empty result set", () => {
		expect(renderSummaryMarkdown([])).toContain("No test result files");
	});
});

describe("renderAnnotations", () => {
	it("emits a GitHub ::error annotation per failure with a forward-slash path", () => {
		const lines = renderAnnotations([
			{ pkg: "agent", totals: parseSuiteTotals(FAIL_XML), failures: parseFailures(FAIL_XML) },
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("::error ");
		expect(lines[0]).toContain("file=packages/agent/src/__tests__/probe.test.ts");
		expect(lines[0]).toContain("line=3");
		expect(lines[0]).toContain("probe suite > this one fails on purpose");
	});

	it("normalises backslash paths to forward slashes for the annotation", () => {
		const lines = renderAnnotations([
			{
				pkg: "less",
				totals: { tests: 1, assertions: 1, failures: 1, skipped: 0, time: 0 },
				failures: [
					{
						name: "t",
						classname: "s",
						file: "packages\\less\\src\\x.test.ts",
						line: 5,
						type: "AssertionError",
					},
				],
			},
		]);
		expect(lines[0]).toContain("file=packages/less/src/x.test.ts");
	});

	it("returns no annotations when nothing failed", () => {
		expect(
			renderAnnotations([{ pkg: "less", totals: parseSuiteTotals(PASS_XML), failures: [] }]),
		).toEqual([]);
	});
});
