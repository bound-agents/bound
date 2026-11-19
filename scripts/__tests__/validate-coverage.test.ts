import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type Baseline,
	addUnloadedSources,
	compareAgainstBaseline,
	estimateUnloaded,
	estimateUnloadedSvelte,
	floorFor,
	isCountedSource,
	lcovSourceFiles,
	listTestablePackages,
	measureCommand,
	nextBaseline,
	packageSourceFiles,
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
			unloadedFiles: 0,
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

describe("validate-coverage: unloaded files", () => {
	it("reads the loaded set from lcov SF lines, normalized", () => {
		const lcov =
			record("./packages/core/src/a.ts", 1, 1, 0, 0) +
			record("packages\\core\\src\\b.ts", 1, 1, 0, 0);
		expect([...lcovSourceFiles(lcov)]).toEqual([
			"packages/core/src/a.ts",
			"packages/core/src/b.ts",
		]);
	});

	it("estimates executable lines and functions, ignoring types, comments and re-exports", () => {
		const source = [
			"// a comment",
			'import { x } from "./x";',
			'export type { T } from "./t";',
			"export {",
			"\tfoo,",
			"\tbar as baz,",
			'} from "./foo";',
			"interface Shape { a: number }",
			"export function add(a: number, b: number): number {",
			"\treturn a + b;",
			"}",
			"export const double = (n: number) => n * 2;",
			"class Box {",
			"\tget size() {",
			"\t\treturn 1;",
			"\t}",
			"}",
		].join("\n");
		const estimate = estimateUnloaded(source);
		expect(estimate.functions).toBe(3);
		expect(estimate.lines).toBeGreaterThanOrEqual(6);
		expect(estimate.lines).toBeLessThanOrEqual(10);
	});

	it("counts a types-only or re-export-only file as nothing", () => {
		expect(estimateUnloaded('export type { A } from "./a";\ninterface B { c: string }\n')).toEqual({
			lines: 0,
			functions: 0,
		});
		expect(estimateUnloaded('export * from "./a";\nexport { b } from "./b";\n')).toEqual({
			lines: 0,
			functions: 0,
		});
	});

	it("adds files no test loaded at 0%, through the given estimator", () => {
		const totals = parseLcov(record("packages/web/src/a.ts", 10, 10, 2, 2), "web");
		const sources: Record<string, string> = {
			"packages/web/src/a.ts": "export const a = () => 1;",
			"packages/web/src/b.ts": "export function b() {\n\treturn 2;\n}",
			"packages/web/src/types.ts": "export interface T { x: number }",
			"packages/web/src/App.svelte": "<script>let x = 1;</script>",
		};
		addUnloadedSources(
			totals,
			Object.keys(sources),
			new Set(["packages/web/src/a.ts"]),
			(file) => sources[file],
			(file, source) =>
				file.endsWith(".svelte") ? { lines: 40, functions: 1 } : estimateUnloaded(source),
		);
		expect(totals.files).toBe(3);
		expect(totals.unloadedFiles).toBe(2);
		expect(totals.linesHit).toBe(10);
		expect(totals.linesFound).toBeGreaterThan(50);
		expect(totals.functionsFound).toBe(4);
		expect(totals.functionsHit).toBe(2);
	});

	it("estimates a component as one function, scaled compiled lines", () => {
		const js = "export default function C($anchor) {\n\tlet x = 1;\n\tconst y = () => x;\n}";
		const estimate = estimateUnloadedSvelte(js);
		expect(estimate.functions).toBe(1);
		expect(estimate.lines).toBe(Math.round(estimateUnloaded(js).lines * 1.345));
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

	it("lists tracked production source only", () => {
		const files = packageSourceFiles(root, "sandbox");
		expect(files.length).toBeGreaterThan(0);
		expect(files.every((file) => file.startsWith("packages/sandbox/src/"))).toBe(true);
		expect(files.some((file) => file.includes("/__tests__/"))).toBe(false);
		// Generated (gitignored) runtime bundles are not tracked source.
		expect(files.some((file) => file.includes("/_runtime/"))).toBe(false);
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
