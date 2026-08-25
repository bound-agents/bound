import { describe, expect, it } from "bun:test";
import { checkDbCommand, checkDbRead, checkDbWrite, isBoundDbPath } from "../db-guard";

const CWD = "/Users/op/projects/bound";

describe("isBoundDbPath (#207)", () => {
	it("matches bound.db and its WAL/SHM/journal siblings anywhere", () => {
		expect(isBoundDbPath("/Users/op/bound/bound.db", CWD)).toBe(true);
		expect(isBoundDbPath("bound.db", CWD)).toBe(true);
		expect(isBoundDbPath("../bound/bound.db-wal", CWD)).toBe(true);
		expect(isBoundDbPath("/x/bound.db-shm", CWD)).toBe(true);
		expect(isBoundDbPath("/x/bound.db-journal", CWD)).toBe(true);
		expect(isBoundDbPath("/x/BOUND.DB", CWD)).toBe(true);
	});

	it("matches generic sqlite files only under a data/ directory", () => {
		expect(isBoundDbPath("/srv/bound/data/agent.db", CWD)).toBe(true);
		expect(isBoundDbPath("/srv/bound/data/agent.sqlite", CWD)).toBe(true);
		expect(isBoundDbPath("/srv/bound/data/agent.sqlite3-wal", CWD)).toBe(true);
		expect(isBoundDbPath("data/store.db", CWD)).toBe(true);
	});

	it("leaves sqlite files outside data/ alone (fixtures, assets)", () => {
		expect(isBoundDbPath("packages/core/src/__tests__/fixture.db", CWD)).toBe(false);
		expect(isBoundDbPath("/tmp/scratch.sqlite", CWD)).toBe(false);
		expect(isBoundDbPath("assets/levels.db", CWD)).toBe(false);
	});

	it("leaves non-database files alone", () => {
		expect(isBoundDbPath("README.md", CWD)).toBe(false);
		expect(isBoundDbPath("data/notes.txt", CWD)).toBe(false);
		expect(isBoundDbPath("bound.dbml", CWD)).toBe(false);
	});
});

describe("checkDbWrite (#207)", () => {
	it("refuses writes to the system DB with an actionable message", () => {
		const msg = checkDbWrite("boundless_write", "~/bound/bound.db", CWD);
		expect(msg).toContain("boundless_write");
		expect(msg).toContain("refusing to write");
		expect(msg).toContain("soft-deletion");
	});

	it("returns null for ordinary paths", () => {
		expect(checkDbWrite("boundless_write", "src/index.ts", CWD)).toBeNull();
	});
});

describe("checkDbRead (#207)", () => {
	it("advises toward the query tool without blocking", () => {
		const note = checkDbRead("/srv/bound/data/bound.db", CWD);
		expect(note).toContain("query");
		expect(note).toContain("[db-guard]");
	});

	it("returns null for ordinary paths", () => {
		expect(checkDbRead("docs/notes.md", CWD)).toBeNull();
	});
});

describe("checkDbCommand (#207)", () => {
	it("warns on sqlite3 CLI invocations", () => {
		expect(checkDbCommand("sqlite3 /x/bound.db 'SELECT 1'")).toContain("[db-guard]");
		expect(checkDbCommand("cat dump.sql | sqlite3 data/app.db")).toContain("[db-guard]");
		expect(checkDbCommand("sqlite /x/whatever.db")).toContain("[db-guard]");
	});

	it("warns when bound.db is named even without the CLI", () => {
		expect(checkDbCommand("cp ~/bound/bound.db /tmp/backup.db")).toContain("[db-guard]");
		expect(checkDbCommand("rm bound.db-wal")).toContain("[db-guard]");
	});

	it("stays quiet on unrelated commands", () => {
		expect(checkDbCommand("bun test packages/core")).toBeNull();
		expect(checkDbCommand("git status")).toBeNull();
		// 'sqlite' as a substring of another word is not an invocation
		expect(checkDbCommand("echo sqlite3-is-cool")).toBeNull();
	});
});
