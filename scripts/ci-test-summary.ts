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

import { appendFileSync, readFileSync } from "node:fs";
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

/** Markdown for the GitHub Actions job summary. */
export function renderSummaryMarkdown(results: PackageResult[]): string {
	if (results.length === 0) {
		return "## Test results\n\nNo test result files were found.\n";
	}

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
		rows.push(
			`| ${r.pkg} | ${tests} | ${pass} | ${failures} | ${skipped} | ${r.totals.time.toFixed(2)}s |`,
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

	const allFailures = results.flatMap((r) => r.failures.map((f) => ({ pkg: r.pkg, ...f })));
	if (allFailures.length === 0) {
		lines.push(`All ${tTests} tests passed across ${results.length} package(s).`);
		lines.push("");
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
	return out;
}

function main(): void {
	const dir = process.argv[2] ?? "test-results";
	const results: PackageResult[] = [];
	for (const file of new Glob("*.xml").scanSync({ cwd: dir })) {
		const xml = readFileSync(join(dir, file), "utf8");
		results.push({
			pkg: basename(file, ".xml"),
			totals: parseSuiteTotals(xml),
			failures: parseFailures(xml),
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
