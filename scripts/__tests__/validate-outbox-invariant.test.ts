import { describe, expect, it } from "bun:test";
import {
	collectChokepointInfo,
	findTableInLine,
	isChokepointSanctioned,
	shouldSkipLine,
} from "../validate-outbox-invariant";

describe("validate-outbox-invariant", () => {
	describe("shouldSkipLine", () => {
		it("should skip lines with outbox-routed annotation", () => {
			const line = "// outbox-routed: explicit createChangeLogEntry follows";
			expect(shouldSkipLine(line)).toBe(true);
		});

		it("should NOT skip lines with the legacy outbox-exempt annotation", () => {
			// The audit-table + // outbox-exempt mechanism was replaced by the
			// dangerouslyExecuteRawWrite chokepoint; the marker is no longer honored.
			const line = "// outbox-exempt: per-host hint";
			expect(shouldSkipLine(line)).toBe(false);
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

		it("should find DELETE mutation on skills table", () => {
			const line = '"DELETE FROM skills WHERE id = ?"';
			expect(findTableInLine(line)).toBe("skills");
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

	describe("collectChokepointInfo", () => {
		it("records the argument window of a chokepoint call", () => {
			const lines = [
				"dangerouslyExecuteRawWrite(db, {",
				'  sql: "UPDATE tasks SET no_history = 1 WHERE type = ?",',
				'  reason: "migration",',
				"});",
			];
			const info = collectChokepointInfo(lines);
			expect(info.windows.length).toBe(1);
			expect(info.windows[0][0]).toBe(0);
		});

		it("captures a named constant passed as the sql argument", () => {
			const lines = [
				"dangerouslyExecuteRawWrite(db, {",
				"  sql: STALE_TASK_RESET_SQL,",
				'  reason: "crash recovery",',
				"});",
			];
			const info = collectChokepointInfo(lines);
			expect(info.sqlIdentifiers.has("STALE_TASK_RESET_SQL")).toBe(true);
		});

		it("captures the `sql` object-shorthand identifier", () => {
			const lines = ["dangerouslyExecuteRawWrite(db, {", "  sql,", '  reason: "hint",', "});"];
			const info = collectChokepointInfo(lines);
			expect(info.sqlIdentifiers.has("sql")).toBe(true);
		});

		it("returns empty info when no chokepoint calls are present", () => {
			const lines = ['db.run("UPDATE tasks SET status = ? WHERE id = ?");'];
			const info = collectChokepointInfo(lines);
			expect(info.windows.length).toBe(0);
			expect(info.sqlIdentifiers.size).toBe(0);
		});
	});

	describe("isChokepointSanctioned", () => {
		it("does NOT sanction a genuine raw bypass", () => {
			const lines = [
				"function f(db) {",
				'  db.run("UPDATE tasks SET status = ? WHERE id = ?", [s, id]);',
				"}",
			];
			const info = collectChokepointInfo(lines);
			expect(isChokepointSanctioned(lines, 1, info)).toBe(false);
		});

		it("sanctions an inline sql literal inside the call window", () => {
			const lines = [
				"dangerouslyExecuteRawWrite(db, {",
				'  sql: "UPDATE tasks SET no_history = 1 WHERE type = ?",',
				'  reason: "migration",',
				"});",
			];
			const info = collectChokepointInfo(lines);
			expect(isChokepointSanctioned(lines, 1, info)).toBe(true);
		});

		it("sanctions a named-constant definition referenced by a chokepoint call", () => {
			const lines = [
				"const STALE_SQL = \"UPDATE tasks SET status = 'pending' WHERE claimed_by = ?\";",
				"// elsewhere in the file",
				"dangerouslyExecuteRawWrite(db, {",
				"  sql: STALE_SQL,",
				"  params: [siteId],",
				'  reason: "crash recovery",',
				"});",
			];
			const info = collectChokepointInfo(lines);
			expect(isChokepointSanctioned(lines, 0, info)).toBe(true);
		});

		it("sanctions a local `const sql` consumed via object shorthand", () => {
			const lines = [
				"const sql = `UPDATE semantic_memory SET last_accessed_at = ? WHERE id = ?`;",
				"dangerouslyExecuteRawWrite(db, {",
				"  sql,",
				'  reason: "hint",',
				"});",
			];
			const info = collectChokepointInfo(lines);
			expect(isChokepointSanctioned(lines, 0, info)).toBe(true);
		});

		it("does NOT sanction an unrelated const far from any chokepoint call", () => {
			const lines = [
				'const OTHER_SQL = "DELETE FROM tasks WHERE id = ?";',
				"db.run(OTHER_SQL, [id]);",
			];
			const info = collectChokepointInfo(lines);
			expect(isChokepointSanctioned(lines, 0, info)).toBe(false);
		});
	});
});
