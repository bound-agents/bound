import { describe, expect, it } from "bun:test";
import {
	cleanLineNumber,
	extractAuditSection,
	findTableInLine,
	hasToDoLink,
	isExemptionDocumented,
	shouldSkipLine,
} from "../validate-outbox-invariant";

describe("validate-outbox-invariant", () => {
	describe("shouldSkipLine", () => {
		it("should skip lines with outbox-routed annotation", () => {
			const line = "// outbox-routed: explicit createChangeLogEntry follows";
			expect(shouldSkipLine(line)).toBe(true);
		});

		it("should skip lines with outbox-exempt annotation", () => {
			const line = "// outbox-exempt: per-host hint";
			expect(shouldSkipLine(line)).toBe(true);
		});

		it("should not skip lines without either annotation", () => {
			const line = "const x = 5;";
			expect(shouldSkipLine(line)).toBe(false);
		});
	});

	describe("findTableInLine", () => {
		it("should find INSERT mutation on tasks table", () => {
			const line = '"INSERT INTO tasks (id, status) VALUES (?, ?)"';
			expect(findTableInLine(line)).toBe("tasks");
		});

		it("should find UPDATE mutation on semantic_memory table", () => {
			const line = '"UPDATE semantic_memory SET last_accessed_at = ? WHERE id = ?"';
			expect(findTableInLine(line)).toBe("semantic_memory");
		});

		it("should find DELETE mutation on overlay_index table", () => {
			const line = '"DELETE FROM overlay_index WHERE id = ?"';
			expect(findTableInLine(line)).toBe("overlay_index");
		});

		it("should not find table in comment-only lines", () => {
			const line = "// This is a comment about tasks table";
			expect(findTableInLine(line)).toBeNull();
		});

		it("should not find table in non-mutation lines", () => {
			const line = 'const result = await db.query("SELECT * FROM tasks").all();';
			expect(findTableInLine(line)).toBeNull();
		});
	});

	describe("extractAuditSection", () => {
		it("should extract audit section from CONTRIBUTING.md", () => {
			const contributing =
				"# Test\n### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category |\n|-----------|-------------|----------|\n| test.ts:1 | tasks | (a) justified |\n\n### Next Section";
			const section = extractAuditSection(contributing);
			expect(section).toContain("| File:Line");
			expect(section).toContain("test.ts:1");
			expect(section).not.toContain("### Next Section");
		});

		it("should return empty string if audit section not found", () => {
			const contributing = "# Test\nNo audit section here";
			const section = extractAuditSection(contributing);
			expect(section).toBe("");
		});
	});

	describe("cleanLineNumber", () => {
		it("should parse plain line number", () => {
			expect(cleanLineNumber("123")).toBe(123);
		});

		it("should strip (REWRITTEN) marker", () => {
			expect(cleanLineNumber("123 (REWRITTEN)")).toBe(123);
		});

		it("should strip (REMOVED) marker", () => {
			expect(cleanLineNumber("456 (REMOVED)")).toBe(456);
		});

		it("should handle whitespace around markers", () => {
			expect(cleanLineNumber("789  (REWRITTEN)  ")).toBe(789);
		});
	});

	describe("isExemptionDocumented", () => {
		it("should return true for non-synced tables (category c)", () => {
			const contributing =
				"### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category |\n\n### Next";
			// non_synced_table is not in SYNCED_TABLES list
			expect(isExemptionDocumented("test.ts", 1, "non_synced_table", contributing)).toBe(true);
		});

		it("should return true for exact file:line match with table substring", () => {
			const contributing =
				"### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category | Disposition |\n| test.ts:10 | semantic_memory | (a) justified | Test entry |\n\n### Next";
			expect(isExemptionDocumented("test.ts", 10, "semantic_memory", contributing)).toBe(true);
		});

		it("should return false for file:line match without table substring", () => {
			const contributing =
				"### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category | Disposition |\n| test.ts:10 | tasks | (a) justified | Test entry |\n\n### Next";
			expect(isExemptionDocumented("test.ts", 10, "semantic_memory", contributing)).toBe(false);
		});

		it("should return true for file-only match (any line in that file)", () => {
			const contributing =
				"### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category | Disposition |\n| test.ts | semantic_memory | (a) justified | Test entry |\n\n### Next";
			expect(isExemptionDocumented("test.ts", 999, "semantic_memory", contributing)).toBe(true);
		});

		it("should return false for synced table without documentation", () => {
			const contributing =
				"### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category |\n\n### Next";
			expect(isExemptionDocumented("undocumented.ts", 50, "tasks", contributing)).toBe(false);
		});

		it("should handle line number with (REWRITTEN) marker in audit table", () => {
			const contributing =
				"### Audit Disposition Table for `outbox-exempt` Annotations\n\n| File:Line | Write target | Category | Disposition |\n| test.ts:15 (REWRITTEN) | tasks | (b) fixed | Test entry |\n\n### Next";
			expect(isExemptionDocumented("test.ts", 15, "tasks", contributing)).toBe(true);
		});
	});

	describe("hasToDoLink", () => {
		it("should find TODO on the same line", () => {
			const lines = ["const x = 5; // TODO: fix this"];
			expect(hasToDoLink(lines, 0)).toBe(true);
		});

		it("should find TODO within 5 lines before", () => {
			const lines = [
				"// TODO: this will be fixed later",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"const x = 5;", // index 5
			];
			expect(hasToDoLink(lines, 5)).toBe(true);
		});

		it("should find TODO within 5 lines after", () => {
			const lines = [
				"const x = 5;", // index 0
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"// TODO: fix this later",
			];
			expect(hasToDoLink(lines, 0)).toBe(true);
		});

		it("should not find TODO beyond 5 lines away", () => {
			const lines = [
				"const x = 5;", // index 0
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"// TODO: too far away",
			];
			expect(hasToDoLink(lines, 0)).toBe(false);
		});

		it("should return false when no TODO found", () => {
			const lines = ["line 1", "line 2", "line 3"];
			expect(hasToDoLink(lines, 1)).toBe(false);
		});

		it("should handle boundary case at start of file", () => {
			const lines = ["const x = 5;", "// TODO: fix", "line 3"];
			expect(hasToDoLink(lines, 0)).toBe(true);
		});

		it("should handle boundary case at end of file", () => {
			const lines = ["line 1", "// TODO: fix", "const x = 5;"];
			expect(hasToDoLink(lines, 2)).toBe(true);
		});
	});
});
