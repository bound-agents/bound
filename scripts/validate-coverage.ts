#!/usr/bin/env bun
/**
 * Coverage ratchet: each package's TOTAL line and function coverage, measured
 * from its lcov report, must stay at or above the floor checked in at
 * scripts/coverage-baseline.json. Floors only move up, and they stop at the
 * target (90%): a package that reaches the target is held there.
 *
 * Why this script exists instead of bunfig's `coverageThreshold`:
 *  - Bun applies `coverageThreshold` to EVERY FILE, not the package total, so
 *    one untested five-line helper fails the whole package.
 *  - Bun silently ignores misspelled threshold keys (`line`/`function` instead
 *    of `lines`/`functions`), which is how the old 60% floor enforced nothing.
 *  - A package-level `bunfig.toml` is not read when `bun test packages/<pkg>`
 *    runs from the repo root, so per-package thresholds there never fire in CI.
 *
 * Floors sit NOISE_MARGIN below the measured total, rounded down to a whole
 * percent: timing-dependent branches (retries, timeouts, races) shift a
 * package's total by a few hundredths between identical runs, and a floor at
 * the exact measurement would fail on that noise.
 *
 * Measure SERIALLY. Under `bun test --parallel`, Bun's coverage report covers
 * only part of the executed code (packages/core measured 71.3% lines under
 * --parallel vs 85.0% serially, same tests, same exit code).
 *
 * Usage:
 *   bun run scripts/validate-coverage.ts --measure            # run tests, then check
 *   bun run scripts/validate-coverage.ts --measure --write-baseline
 *   bun run scripts/validate-coverage.ts [coverage-dir]       # check existing reports
 *   bun run scripts/validate-coverage.ts --list-packages
 *
 * --measure runs `bun test packages/<pkg>` once per package, serially, writing
 * coverage/<pkg>/lcov.info and coverage/<pkg>.log. Without it, the coverage dir
 * (default: coverage) must already hold one `<pkg>/lcov.info` per package.
 * Wired into: the Coverage job in .github/workflows/ci.yml.
 */

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { gateIgnoreArgs, hasTestFiles, pkgDirFromGlobMatch } from "./test-affected";

export const BASELINE_PATH = "scripts/coverage-baseline.json";

/** Percentage points of run-to-run noise a floor leaves below the measurement. */
export const NOISE_MARGIN = 0.5;

/** The floor a measurement supports: whole-percent, capped at the target. */
export function floorFor(actual: number, target: number): number {
	return Math.min(target, Math.max(0, Math.floor(actual - NOISE_MARGIN)));
}

export interface Totals {
	files: number;
	linesFound: number;
	linesHit: number;
	functionsFound: number;
	functionsHit: number;
}

/** Package totals as percentages (0–100). */
export interface Measured {
	lines: number;
	functions: number;
}

export interface Baseline {
	/** Percent. Floors are capped here; reaching it is the goal. */
	target: number;
	packages: Record<string, Measured>;
}

/**
 * True when an lcov `SF:` path is production source of `pkg`. Test files and
 * test helpers are excluded, as are files from OTHER packages that this
 * package's tests import (those count toward their own package, measured by
 * their own run).
 */
export function isCountedSource(sourceFile: string, pkg: string): boolean {
	const file = sourceFile.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!file.startsWith(`packages/${pkg}/`)) return false;
	if (file.includes("/__tests__/")) return false;
	return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

export function parseLcov(text: string, pkg: string): Totals {
	const totals: Totals = {
		files: 0,
		linesFound: 0,
		linesHit: 0,
		functionsFound: 0,
		functionsHit: 0,
	};
	for (const record of text.split("end_of_record")) {
		const sourceFile = record.match(/^SF:(.*)$/m)?.[1]?.trim();
		if (!sourceFile || !isCountedSource(sourceFile, pkg)) continue;
		const field = (key: string) =>
			Number(record.match(new RegExp(`^${key}:(\\d+)`, "m"))?.[1] ?? 0);
		totals.files++;
		totals.linesFound += field("LF");
		totals.linesHit += field("LH");
		totals.functionsFound += field("FNF");
		totals.functionsHit += field("FNH");
	}
	return totals;
}

function percent(hit: number, found: number): number {
	return found === 0 ? 100 : (100 * hit) / found;
}

export function toMeasured(totals: Totals): Measured {
	return {
		lines: percent(totals.linesHit, totals.linesFound),
		functions: percent(totals.functionsHit, totals.functionsFound),
	};
}

export interface Comparison {
	failures: string[];
	/** Packages whose measurement supports a higher floor than the baseline holds. */
	raisable: string[];
}

const METRICS = ["lines", "functions"] as const;

export function compareAgainstBaseline(
	measured: Record<string, Measured | undefined>,
	baseline: Baseline,
): Comparison {
	const failures: string[] = [];
	const raisable = new Set<string>();
	const packages = new Set([...Object.keys(baseline.packages), ...Object.keys(measured)]);
	for (const pkg of [...packages].sort()) {
		const floor = baseline.packages[pkg];
		const actual = measured[pkg];
		if (!actual) {
			failures.push(`${pkg}: no coverage report (expected <coverage-dir>/${pkg}/lcov.info)`);
			continue;
		}
		if (!floor) {
			failures.push(`${pkg}: not in ${BASELINE_PATH}; add it with --write-baseline`);
			continue;
		}
		for (const metric of METRICS) {
			if (actual[metric] < floor[metric]) {
				failures.push(
					`${pkg}: ${metric} ${actual[metric].toFixed(2)}% is below its ${floor[metric]}% floor`,
				);
			} else if (floorFor(actual[metric], baseline.target) > floor[metric]) {
				raisable.add(pkg);
			}
		}
	}
	return { failures, raisable: [...raisable] };
}

/**
 * Floors for a rewritten baseline: `floorFor` each measurement, never lower
 * than the current floor.
 */
export function nextBaseline(
	measured: Record<string, Measured | undefined>,
	baseline: Baseline,
): Baseline {
	const packages: Record<string, Measured> = {};
	const names = new Set([...Object.keys(baseline.packages), ...Object.keys(measured)]);
	for (const pkg of [...names].sort()) {
		const actual = measured[pkg];
		const floor = baseline.packages[pkg];
		if (!actual) {
			if (floor) packages[pkg] = floor;
			continue;
		}
		const next = (metric: (typeof METRICS)[number]) =>
			Math.max(floor?.[metric] ?? 0, floorFor(actual[metric], baseline.target));
		packages[pkg] = { lines: next("lines"), functions: next("functions") };
	}
	return { target: baseline.target, packages };
}

/** Workspace packages that have tests, by directory name. */
export function listTestablePackages(root: string): string[] {
	const glob = new Glob("packages/*/package.json");
	const names: string[] = [];
	for (const match of glob.scanSync({ cwd: root })) {
		const dir = pkgDirFromGlobMatch(match);
		if (hasTestFiles(dir, root)) names.push(dir.slice("packages/".length));
	}
	return names.sort();
}

/**
 * The coverage run for one package. No `--parallel`: Bun's parallel workers
 * under-report coverage (see the header comment).
 */
export function measureCommand(pkg: string, outDir: string): string[] {
	return [
		"bun",
		"test",
		`./packages/${pkg}`,
		"--coverage",
		"--coverage-reporter=lcov",
		`--coverage-dir=${outDir}`,
		"--timeout",
		"30000",
		...gateIgnoreArgs(),
	];
}

/** Runs each package's tests serially with lcov coverage. Returns failed packages. */
function measure(root: string, coverageDir: string, packages: string[]): string[] {
	rmSync(coverageDir, { recursive: true, force: true });
	mkdirSync(coverageDir, { recursive: true });
	const failed: string[] = [];
	for (const pkg of packages) {
		const started = Date.now();
		const log = openSync(join(coverageDir, `${pkg}.log`), "w");
		const proc = Bun.spawnSync(measureCommand(pkg, join(coverageDir, pkg)), {
			cwd: root,
			stdout: log,
			stderr: log,
		});
		const seconds = ((Date.now() - started) / 1000).toFixed(0);
		const exitCode = proc.exitCode ?? 1;
		console.log(`measured ${pkg} in ${seconds}s (exit ${exitCode})`);
		if (exitCode !== 0) failed.push(pkg);
	}
	return failed;
}

function renderTable(
	measured: Record<string, Measured | undefined>,
	baseline: Baseline,
	packages: string[],
): string {
	const cell = (actual: number | undefined, floor: number | undefined) =>
		`${actual === undefined ? "—" : `${actual.toFixed(2)}%`} (floor ${floor ?? "—"}%)`;
	const rows = packages.map((pkg) => {
		const actual = measured[pkg];
		const floor = baseline.packages[pkg];
		return `| ${pkg} | ${cell(actual?.lines, floor?.lines)} | ${cell(actual?.functions, floor?.functions)} |`;
	});
	return [
		`Coverage by package total (target ${baseline.target}%)`,
		"",
		"| package | lines | functions |",
		"|---|---|---|",
		...rows,
	].join("\n");
}

function run(): void {
	const root = resolve(import.meta.dir, "..");
	const args = process.argv.slice(2);
	const testable = listTestablePackages(root);

	if (args.includes("--list-packages")) {
		console.log(testable.join("\n"));
		return;
	}

	const coverageDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? "coverage");
	const baselinePath = join(root, BASELINE_PATH);
	const baseline: Baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const packages = [...new Set([...testable, ...Object.keys(baseline.packages)])].sort();

	if (args.includes("--measure")) {
		const failed = measure(root, coverageDir, testable);
		if (failed.length > 0) {
			// A failing suite reports partial coverage; judging it against the
			// floor would blame coverage for a test failure.
			console.error(
				`\nTests failed in: ${failed.join(", ")}. See ${coverageDir}/<pkg>.log; coverage not checked.`,
			);
			process.exit(1);
		}
	}

	const measured: Record<string, Measured | undefined> = {};
	for (const pkg of packages) {
		const lcovPath = join(coverageDir, pkg, "lcov.info");
		if (!existsSync(lcovPath)) continue;
		const totals = parseLcov(readFileSync(lcovPath, "utf8"), pkg);
		if (totals.files > 0) measured[pkg] = toMeasured(totals);
	}

	const table = renderTable(measured, baseline, packages);
	console.log(table);
	if (process.env.GITHUB_STEP_SUMMARY) {
		writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`, { flag: "a" });
	}

	if (args.includes("--write-baseline")) {
		writeFileSync(
			baselinePath,
			`${JSON.stringify(nextBaseline(measured, baseline), null, "\t")}\n`,
		);
		console.log(`\nWrote ${BASELINE_PATH}.`);
		return;
	}

	const { failures, raisable } = compareAgainstBaseline(measured, baseline);
	if (raisable.length > 0) {
		console.log(
			`\nFloors can rise for: ${raisable.join(", ")}. Run with --write-baseline and commit the result.`,
		);
	}
	if (failures.length > 0) {
		console.error("\nCoverage ratchet failed:");
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log("\nCoverage ratchet passed.");
}

if (import.meta.main) {
	run();
}
