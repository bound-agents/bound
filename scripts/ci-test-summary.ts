#!/usr/bin/env bun
/**
 * Turns the per-package JUnit XML that `bun test --reporter=junit` emits into a
 * queryable CI artifact: a per-package results table plus a flat list of failed
 * tests (file:line, suite > name) written to the GitHub Actions job summary, and
 * one `::error` annotation per failure so failures surface inline on the PR
 * without scrolling the raw log.
 *
 * The human-readable assertion diff still lands in the per-package `::group::`
 * log section (bun's console reporter keeps printing to stderr alongside the
 * JUnit file) -- bun's <failure> element carries no message, so this summary is
 * the "what/where" index and the fold is the "why".
 *
 * Run: bun run scripts/ci-test-summary.ts [test-results-dir]
 * Wired into: .github/workflows/ci.yml (Test job, after the unit-test step)
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";

export interface SuiteTotals {
	tests: number;
	assertions: number;
	failures: number;
	skipped: number;
	time: number;
}

export interface FailedCase {
	name: string;
	classname: string;
	file: string;
	line: number;
	type: string;
}

export interface PackageResult {
	pkg: string;
	totals: SuiteTotals;
	failures: FailedCase[];
	/**
	 * The package's process exit code, from the `<pkg>.exit` sidecar the CI step
	 * writes. `null`/absent means "unknown" (no sidecar — e.g. a local run that
	 * only produced XML), which is never treated as an anomaly.
	 */
	exitCode?: number | null;
}

export interface ProcessAnomaly {
	pkg: string;
	exitCode: number;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([\w:.-]+)="([^"]*)"/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec drain loop
	while ((m = re.exec(tag)) !== null) {
		out[m[1] as string] = decodeEntities(m[2] as string);
	}
	return out;
}

function num(v: string | undefined): number {
	if (v === undefined) return 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

/** Read the counters off the root <testsuites> element. */
export function parseSuiteTotals(xml: string): SuiteTotals {
	const m = xml.match(/<testsuites\b([^>]*)>/);
	if (!m) return { tests: 0, assertions: 0, failures: 0, skipped: 0, time: 0 };
	const a = attrs(m[1] as string);
	return {
		tests: num(a.tests),
		assertions: num(a.assertions),
		failures: num(a.failures),
		skipped: num(a.skipped),
		time: num(a.time),
	};
}

/** Extract every <testcase> that carries a <failure>/<error> child. */
export function parseFailures(xml: string): FailedCase[] {
	const out: FailedCase[] = [];
	const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec drain loop
	while ((m = re.exec(xml)) !== null) {
		const inner = m[3];
		if (inner === undefined) continue; // self-closing => passed
		if (!/<(failure|error)\b/.test(inner)) continue;
		const a = attrs(m[1] as string);
		const failTag = inner.match(/<(?:failure|error)\b([^>]*)/);
		const type = failTag ? (attrs(failTag[1] as string).type ?? "failure") : "failure";
		out.push({
			name: a.name ?? "(unnamed test)",
			classname: a.classname ?? "",
			file: a.file ?? "",
			line: num(a.line),
			type,
		});
	}
	return out;
}

function fwd(path: string): string {
	return path.replace(/\\/g, "/");
}

/**
 * Packages whose process exited nonzero but whose JUnit recorded NO test
 * failure — i.e. the failure is upstream of the reporter (a crash, an
 * unhandled rejection, or a teardown error such as Windows EBUSY on DB
 * cleanup). A pure-JUnit summary calls these "all green", which is exactly
 * the trap this reconciliation closes. A nonzero exit that a real test
 * failure already explains is NOT an anomaly; an unknown (null) exit is not
 * either (no sidecar means we can't make the claim).
 */
export function findProcessAnomalies(results: PackageResult[]): ProcessAnomaly[] {
	const out: ProcessAnomaly[] = [];
	for (const r of results) {
		const ec = r.exitCode;
		if (ec === undefined || ec === null || ec === 0) continue;
		if (r.failures.length > 0 || r.totals.failures > 0) continue; // explained by a real failure
		out.push({ pkg: r.pkg, exitCode: ec });
	}
	return out;
}

/** Markdown for the GitHub Actions job summary. */
export function renderSummaryMarkdown(results: PackageResult[]): string {
	if (results.length === 0) {
		return "## Test results\n\nNo test result files were found.\n";
	}

	const anomalies = findProcessAnomalies(results);
	const anomalousPkgs = new Set(anomalies.map((a) => a.pkg));

	const rows: string[] = [];
	let tTests = 0;
	let tPass = 0;
	let tFail = 0;
	let tSkip = 0;
	for (const r of results) {
		const { tests, failures, skipped } = r.totals;
		const pass = tests - failures - skipped;
		tTests += tests;
		tPass += pass;
		tFail += failures;
		tSkip += skipped;
		// Mark an anomalous package so a reader scanning the table sees it isn't
		// silently green despite a 0-fail row.
		const pkgCell = anomalousPkgs.has(r.pkg) ? `⚠ ${r.pkg}` : r.pkg;
		rows.push(
			`| ${pkgCell} | ${tests} | ${pass} | ${failures} | ${skipped} | ${r.totals.time.toFixed(2)}s |`,
		);
	}

	const lines: string[] = [];
	lines.push("## Test results");
	lines.push("");
	lines.push("| Package | Tests | Pass | Fail | Skip | Time |");
	lines.push("|---|--:|--:|--:|--:|--:|");
	lines.push(...rows);
	lines.push(`| **Total** | ${tTests} | ${tPass} | ${tFail} | ${tSkip} | |`);
	lines.push("");

	if (anomalies.length > 0) {
		lines.push(`### Process-level failures (${anomalies.length})`);
		lines.push("");
		lines.push(
			"These packages exited nonzero with **no recorded test failure** — the JUnit reports clean, so the failure is upstream of the reporter (a crash, an unhandled rejection, or a teardown error such as Windows EBUSY on DB cleanup). Open the package's log group for the stack.",
		);
		lines.push("");
		lines.push("| Package | Exit code |");
		lines.push("|---|--:|");
		for (const a of anomalies) {
			lines.push(`| ${a.pkg} | ${a.exitCode} |`);
		}
		lines.push("");
	}

	const allFailures = results.flatMap((r) => r.failures.map((f) => ({ pkg: r.pkg, ...f })));
	if (allFailures.length === 0) {
		if (anomalies.length === 0) {
			lines.push(`All ${tTests} tests passed across ${results.length} package(s).`);
			lines.push("");
		}
		return lines.join("\n");
	}

	lines.push(`### Failures (${allFailures.length})`);
	lines.push("");
	lines.push("| Package | Test | Location |");
	lines.push("|---|---|---|");
	for (const f of allFailures) {
		const where = f.file ? `${fwd(f.file)}:${f.line}` : "(unknown)";
		const suite = f.classname ? `${f.classname} > ${f.name}` : f.name;
		lines.push(`| ${f.pkg} | ${suite} | \`${where}\` |`);
	}
	lines.push("");
	lines.push("_Assertion diffs are in the per-package log group above._");
	lines.push("");
	return lines.join("\n");
}

/** One GitHub `::error` workflow command per failure (forward-slash paths). */
export function renderAnnotations(results: PackageResult[]): string[] {
	const out: string[] = [];
	for (const r of results) {
		for (const f of r.failures) {
			const title = f.classname ? `${f.classname} > ${f.name}` : f.name;
			const msg = `${f.type} in "${f.name}" (${r.pkg})`;
			out.push(`::error file=${fwd(f.file)},line=${f.line},title=${title}::${msg}`);
		}
	}
	// Process-level anomalies have no file/line (the crash is upstream of the
	// reporter), so they annotate the run rather than a source location.
	for (const a of findProcessAnomalies(results)) {
		out.push(
			`::error title=process-level failure (${a.pkg})::Package "${a.pkg}" exited with code ${a.exitCode} but reported no test failures — the crash is upstream of the JUnit reporter; open the packages/${a.pkg} log group for the stack.`,
		);
	}
	return out;
}

function readExitCode(dir: string, pkg: string): number | null {
	const p = join(dir, `${pkg}.exit`);
	if (!existsSync(p)) return null;
	const raw = readFileSync(p, "utf8").trim();
	if (raw === "") return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
}

function main(): void {
	const dir = process.argv[2] ?? "test-results";
	// Drive the loop from the union of *.xml and *.exit basenames so a package
	// that crashed before writing any JUnit still appears (exit sidecar present,
	// XML absent) rather than vanishing from the report.
	const pkgs = new Set<string>();
	for (const file of new Glob("*.xml").scanSync({ cwd: dir })) pkgs.add(basename(file, ".xml"));
	for (const file of new Glob("*.exit").scanSync({ cwd: dir })) pkgs.add(basename(file, ".exit"));

	const results: PackageResult[] = [];
	for (const pkg of pkgs) {
		const xmlPath = join(dir, `${pkg}.xml`);
		const xml = existsSync(xmlPath) ? readFileSync(xmlPath, "utf8") : "";
		results.push({
			pkg,
			totals: parseSuiteTotals(xml),
			failures: parseFailures(xml),
			exitCode: readExitCode(dir, pkg),
		});
	}
	results.sort((a, b) => a.pkg.localeCompare(b.pkg));

	const md = renderSummaryMarkdown(results);
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		appendFileSync(summaryPath, `${md}\n`);
	} else {
		process.stdout.write(`${md}\n`);
	}

	for (const line of renderAnnotations(results)) {
		process.stdout.write(`${line}\n`);
	}
}

if (import.meta.main) {
	main();
}
