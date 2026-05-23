import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createSkillsRoutes } from "../routes/skills";

function createTestDb(): Database {
	const db = new BunDatabase(":memory:");

	db.run(`CREATE TABLE skills (
		id TEXT PRIMARY KEY NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL,
		status TEXT NOT NULL,
		skill_root TEXT,
		content_hash TEXT,
		allowed_tools TEXT,
		compatibility TEXT,
		metadata_json TEXT,
		activated_at TEXT,
		created_by_thread TEXT,
		activation_count INTEGER DEFAULT 0,
		last_activated_at TEXT,
		retired_by TEXT,
		retired_reason TEXT,
		modified_at TEXT NOT NULL,
		deleted INTEGER DEFAULT 0
	)`);

	db.run(`CREATE TABLE files (
		id TEXT PRIMARY KEY NOT NULL,
		path TEXT NOT NULL,
		content TEXT,
		is_binary INTEGER DEFAULT 0,
		size_bytes INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		modified_at TEXT NOT NULL,
		deleted INTEGER DEFAULT 0,
		created_by TEXT,
		host_origin TEXT
	)`);

	// Required by getSiteId() inside createSkillsRoutes
	db.run(`CREATE TABLE host_meta (
		key TEXT PRIMARY KEY NOT NULL,
		value TEXT NOT NULL
	)`);
	db.run(`INSERT INTO host_meta VALUES ('site_id', 'test-site')`);

	return db;
}

// id, name, description, status, skill_root, modified_at
const insertSkill = (db: Database, id: string, name: string, skillRoot: string) => {
	db.prepare(
		`INSERT INTO skills VALUES (
			?, ?, 'Test description', 'active',
			?, NULL, NULL, NULL, NULL,
			NULL, NULL, 1, NULL, NULL, NULL,
			'2026-01-01T00:00:00.000Z', 0
		)`,
	).run(id, name, skillRoot);
};

// id/path (same value), content
const insertFile = (db: Database, path: string, content: string) => {
	db.prepare(
		`INSERT INTO files VALUES (?, ?, ?, 0, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, NULL, NULL)`,
	).run(path, path, content, content.length);
};

describe("GET /api/skills/:id — content lookup via skill_root", () => {
	let db: Database;
	let app: Hono;

	beforeEach(() => {
		db = createTestDb();
		app = new Hono();
		app.route("/", createSkillsRoutes(db));
	});

	it("returns content for canonical relative skill_root (importSkillFromFiles pattern)", async () => {
		insertSkill(db, "skill-1", "test-skill", "skills/test-skill");
		insertFile(db, "skills/test-skill/SKILL.md", "# Test\nRelative path content.");

		const res = await app.request("/skill-1");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { content: string };
		expect(json.content).toContain("Relative path content.");
	});

	it("returns content for absolute VFS skill_root (seed-skills pattern, fixes #43)", async () => {
		// seed-skills.ts stores skill_root = '/home/user/skills/<name>'
		// and writes files to that absolute VFS path in the files table.
		// The web server was ignoring skill_root and querying 'skills/<name>/SKILL.md',
		// missing the '/home/user/' prefix.
		insertSkill(db, "skill-2", "seeded-skill", "/home/user/skills/seeded-skill");
		insertFile(db, "/home/user/skills/seeded-skill/SKILL.md", "# Seeded\nAbsolute path content.");

		const res = await app.request("/skill-2");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { content: string };
		expect(json.content).toContain("Absolute path content.");
	});

	it("lists files with correct relative paths for absolute skill_root", async () => {
		insertSkill(db, "skill-3", "multi-file-skill", "/home/user/skills/multi-file-skill");
		insertFile(db, "/home/user/skills/multi-file-skill/SKILL.md", "# Multi-file");
		insertFile(db, "/home/user/skills/multi-file-skill/references/guide.md", "# Guide");

		const res = await app.request("/skill-3");
		expect(res.status).toBe(200);
		const json = (await res.json()) as { files: Array<{ path: string }> };
		const paths = json.files.map((f) => f.path).sort();
		expect(paths).toContain("SKILL.md");
		expect(paths).toContain("references/guide.md");
	});
});
