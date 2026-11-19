import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type Baseline,
	compareAgainstBaseline,
	floorFor,
	isCountedSource,
	listTestablePackages,
	measureCommand,
	nextBaseline,
	parseLcov,
	toMeasured,
} from "../validate-coverage";

const record = (file: string, lf: number, lh: number, fnf: number, fnh: number) =>
	`TN:\nSF:${file}\nFNF:${fnf}\nFNH:${fnh}\nDA:1,1\nLF:${lf}\nLH:${lh}\nend_of_record\n`;

describe("validate-coverage: isCountedSource", () => {
	it("counts the package's own production source", () => {
		expect(isCountedSource("packages/core/src/schema.ts", "core")).toBe(true);
	});

	it("skips test files and test helpers", () => {
		expect(isCountedSource("packages/core/src/__tests__/test-database.ts", "core")).toBe(false);
		expect(isCountedSource("packages/core/src/schema.test.ts", "core")).toBe(false);
		expect(isCountedSource("packages/web/src/client/app.spec.tsx", "web")).toBe(false);
	});

	it("skips other packages' files that this package's tests import", () => {
		expect(isCountedSource("packages/shared/src/uuid.ts", "core")).toBe(false);
	});

	it("does not treat a package name as a prefix match", () => {
		expect(isCountedSource("packages/core-extra/src/a.ts", "core")).toBe(false);
	});

	it("normalizes Windows separators", () => {
		expect(isCountedSource("packages\\core\\src\\schema.ts", "core")).toBe(true);
	});
});

describe("validate-coverage: parseLcov", () => {
	it("sums package totals across counted files only", () => {
		const lcov = [
			record("packages/core/src/a.ts", 10, 9, 4, 4),
			record("packages/core/src/b.ts", 10, 1, 4, 0),
			record("packages/core/src/__tests__/helper.ts", 100, 0, 10, 0),
			record("packages/shared/src/c.ts", 100, 0, 10, 0),
		].join("");
		expect(parseLcov(lcov, "core")).toEqual({
			files: 2,
			linesFound: 20,
			linesHit: 10,
			functionsFound: 8,
			functionsHit: 4,
		});
	});

	it("measures the package total, not the worst file", () => {
		// A 0%-function helper must not sink a package whose total is high.
		const lcov = [
			record("packages/shared/src/big.ts", 1000, 990, 99, 99),
			record("packages/shared/src/assert.ts", 5, 1, 1, 0),
		].join("");
		const measured = toMeasured(parseLcov(lcov, "shared"));
		expect(measured.lines).toBeCloseTo((100 * 991) / 1005, 5);
		expect(measured.functions).toBe(99);
	});

	it("treats zero found as fully covered", () => {
		expect(toMeasured(parseLcov(record("packages/x/src/types.ts", 0, 0, 0, 0), "x"))).toEqual({
			lines: 100,
			functions: 100,
		});
	});
});

describe("validate-coverage: floorFor", () => {
	it("leaves half a point of run-to-run noise below the measurement", () => {
		expect(floorFor(85.01, 90)).toBe(84);
		expect(floorFor(85.5, 90)).toBe(85);
		expect(floorFor(86.43, 90)).toBe(85);
	});

	it("caps at the target and never goes negative", () => {
		expect(floorFor(99.9, 90)).toBe(90);
		expect(floorFor(0.2, 90)).toBe(0);
	});
});

describe("validate-coverage: measureCommand", () => {
	it("measures one package serially into its own lcov dir", () => {
		const command = measureCommand("core", "coverage/core");
		expect(command.slice(0, 3)).toEqual(["bun", "test", "./packages/core"]);
		expect(command).toContain("--coverage-reporter=lcov");
		expect(command).toContain("--coverage-dir=coverage/core");
		expect(command).not.toContain("--parallel");
	});
});

describe("validate-coverage: compareAgainstBaseline", () => {
	const baseline: Baseline = {
		target: 90,
		packages: { core: { lines: 85, functions: 86 }, agent: { lines: 90, functions: 90 } },
	};

	it("passes at or above every floor", () => {
		const result = compareAgainstBaseline(
			{ core: { lines: 85, functions: 86.4 }, agent: { lines: 91.7, functions: 90 } },
			baseline,
		);
		expect(result.failures).toEqual([]);
		expect(result.raisable).toEqual([]);
	});

	it("fails a package that drops below its floor", () => {
		const result = compareAgainstBaseline(
			{ core: { lines: 84.99, functions: 86 }, agent: { lines: 90, functions: 90 } },
			baseline,
		);
		expect(result.failures).toEqual(["core: lines 84.99% is below its 85% floor"]);
	});

	it("fails a measured package missing from the baseline", () => {
		const result = compareAgainstBaseline(
			{
				core: { lines: 85, functions: 86 },
				agent: { lines: 90, functions: 90 },
				loop: { lines: 50, functions: 50 },
			},
			baseline,
		);
		expect(result.failures).toEqual([
			"loop: not in scripts/coverage-baseline.json; add it with --write-baseline",
		]);
	});

	it("fails a baselined package with no report", () => {
		const result = compareAgainstBaseline({ core: { lines: 85, functions: 86 } }, baseline);
		expect(result.failures).toEqual([
			"agent: no coverage report (expected <coverage-dir>/agent/lcov.info)",
		]);
	});

	it("flags floors that can rise by a whole point, but not past the target", () => {
		const result = compareAgainstBaseline(
			{ core: { lines: 87.2, functions: 86 }, agent: { lines: 99, functions: 99 } },
			baseline,
		);
		expect(result.raisable).toEqual(["core"]);
	});
});

describe("validate-coverage: nextBaseline", () => {
	const baseline: Baseline = {
		target: 90,
		packages: { core: { lines: 85, functions: 86 }, sync: { lines: 80, functions: 80 } },
	};

	it("ratchets up to whole percents, capped at the target, never down", () => {
		const next = nextBaseline(
			{
				core: { lines: 87.9, functions: 85.1 },
				sync: { lines: 95.5, functions: 80.2 },
				loop: { lines: 93.5, functions: 81.9 },
			},
			baseline,
		);
		expect(next).toEqual({
			target: 90,
			packages: {
				core: { lines: 87, functions: 86 },
				loop: { lines: 90, functions: 81 },
				sync: { lines: 90, functions: 80 },
			},
		});
	});

	it("keeps the floor of a package with no report", () => {
		expect(nextBaseline({}, baseline).packages.core).toEqual({ lines: 85, functions: 86 });
	});
});

describe("validate-coverage: repository wiring", () => {
	const root = resolve(import.meta.dir, "..", "..");

	it("measures every package that has tests, and none that don't", () => {
		const packages = listTestablePackages(root);
		expect(packages).toContain("core");
		expect(packages).toContain("loop");
		expect(packages).not.toContain("docs");
	});

	it("has a baseline floor for every testable package", () => {
		const baseline: Baseline = JSON.parse(
			readFileSync(join(root, "scripts/coverage-baseline.json"), "utf8"),
		);
		expect(baseline.target).toBe(90);
		expect(Object.keys(baseline.packages).sort()).toEqual(listTestablePackages(root));
	});

	it("does not set bunfig's per-file coverageThreshold", () => {
		// Bun applies coverageThreshold per file and silently ignores misspelled
		// keys; the package-total ratchet above replaces it.
		expect(readFileSync(join(root, "bunfig.toml"), "utf8")).not.toMatch(/^coverageThreshold/m);
	});

	it("CI runs the measuring ratchet", () => {
		const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
		const start = workflow.indexOf("\n  coverage:\n");
		expect(start).toBeGreaterThan(-1);
		expect(workflow.slice(start)).toContain("run: bun run scripts/validate-coverage.ts --measure");
	});
});
