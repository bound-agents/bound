import { describe, expect, it } from "bun:test";
import {
	type Baseline,
	type ReadCounts,
	countInlineReads,
	diffAgainstBaseline,
	shouldExclude,
} from "../validate-read-centralization";

describe("validate-read-centralization", () => {
	describe("shouldExclude", () => {
		it("excludes the repository layer itself", () => {
			expect(shouldExclude("packages/core/src/repositories/threads.ts")).toBe(true);
		});

		it("excludes change-log.ts (write internals read raw)", () => {
			expect(shouldExclude("packages/core/src/change-log.ts")).toBe(true);
		});

		it("excludes test files", () => {
			expect(shouldExclude("packages/agent/src/__tests__/foo.test.ts")).toBe(true);
		});

		it("does not exclude ordinary feature code", () => {
			expect(shouldExclude("packages/agent/src/scheduler.ts")).toBe(false);
		});
	});

	describe("countInlineReads", () => {
		it("counts db.query call sites", () => {
			const content = [
				'const a = db.query("SELECT 1").get();',
				'const b = db.query("SELECT 2").all();',
			].join("\n");
			expect(countInlineReads(content)).toBe(2);
		});

		it("counts db.prepare call sites", () => {
			const content = 'const stmt = db.prepare("SELECT * FROM threads WHERE id = ?");';
			expect(countInlineReads(content)).toBe(1);
		});

		it("ignores reads in comment lines", () => {
			const content = ['// const a = db.query("SELECT 1");', ' * db.prepare("x")'].join("\n");
			expect(countInlineReads(content)).toBe(0);
		});

		it("returns 0 when there are no inline reads", () => {
			expect(countInlineReads("const x = findThreadById(db, id);")).toBe(0);
		});
	});

	describe("diffAgainstBaseline", () => {
		it("flags a file not present in the baseline", () => {
			const counts: ReadCounts = { "packages/agent/src/new.ts": 1 };
			const baseline: Baseline = {};
			const findings = diffAgainstBaseline(counts, baseline);
			expect(findings.length).toBe(1);
			expect(findings[0].file).toBe("packages/agent/src/new.ts");
			expect(findings[0].allowed).toBe(0);
		});

		it("flags a file that exceeds its baselined count", () => {
			const counts: ReadCounts = { "packages/agent/src/x.ts": 5 };
			const baseline: Baseline = { "packages/agent/src/x.ts": 3 };
			const findings = diffAgainstBaseline(counts, baseline);
			expect(findings.length).toBe(1);
			expect(findings[0].count).toBe(5);
			expect(findings[0].allowed).toBe(3);
		});

		it("allows a file at exactly its baselined count", () => {
			const counts: ReadCounts = { "packages/agent/src/x.ts": 3 };
			const baseline: Baseline = { "packages/agent/src/x.ts": 3 };
			expect(diffAgainstBaseline(counts, baseline).length).toBe(0);
		});

		it("allows a file below its baselined count (ratchet down)", () => {
			const counts: ReadCounts = { "packages/agent/src/x.ts": 1 };
			const baseline: Baseline = { "packages/agent/src/x.ts": 3 };
			expect(diffAgainstBaseline(counts, baseline).length).toBe(0);
		});

		it("allows an empty working tree against any baseline", () => {
			expect(diffAgainstBaseline({}, { "a.ts": 9 }).length).toBe(0);
		});
	});
});
