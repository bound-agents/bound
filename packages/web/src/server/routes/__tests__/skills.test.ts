import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { zipSync } from "fflate";
import { createSkillsRoutes } from "../skills";

// createSkillsRoutes is the REST surface for skills: list, detail, create
// (JSON body / multipart .md / multipart .zip with traversal + size + SKILL.md
// validation), PATCH merge, and DELETE. These tests drive each handler branch
// end to end against a real in-memory DB.

const SITE = "test-site";

function skillMd(name: string, description: string, body = "Steps here."): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function seedSkill(db: Database, id: string, name: string): void {
	const now = "2026-07-04T00:00:00.000Z";
	const root = `skills/${name}`;
	insertRow(
		db,
		"skills",
		{
			id,
			name,
			description: "seeded",
			skill_root: root,
			content_hash: "hash0",
			allowed_tools: null,
			compatibility: null,
			metadata_json: null,
			activated_at: null,
			created_by_thread: null,
			activation_count: 0,
			last_activated_at: null,
			modified_at: now,
			deleted: 0,
		},
		SITE,
	);
	insertRow(
		db,
		"files",
		{
			id: `${root}/SKILL.md`,
			path: `${root}/SKILL.md`,
			content: skillMd(name, "seeded", "Body."),
			is_binary: 0,
			size_bytes: 40,
			created_at: now,
			modified_at: now,
			created_by: SITE,
			host_origin: SITE,
			deleted: 0,
		},
		SITE,
	);
}

function jsonCreate(app: ReturnType<typeof createSkillsRoutes>, body: unknown) {
	return app.request("/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function multipart(app: ReturnType<typeof createSkillsRoutes>, file: File) {
	const form = new FormData();
	form.set("skillfile", file);
	return app.request("/", { method: "POST", body: form });
}

describe("skills routes", () => {
	let db: Database;
	let app: ReturnType<typeof createSkillsRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
		app = createSkillsRoutes(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /", () => {
		it("lists skills with is_builtin flags", async () => {
			seedSkill(db, "skill-a", "alpha");
			const res = await app.request("/");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { name: string; is_builtin: boolean }[];
			expect(body).toHaveLength(1);
			expect(body[0].name).toBe("alpha");
			expect(body[0].is_builtin).toBe(false);
		});

		it("returns 500 when the list query throws", async () => {
			db.close();
			const res = await app.request("/");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list skills");
		});
	});

	describe("GET /:id", () => {
		it("returns the skill detail with SKILL.md content and relative file paths", async () => {
			seedSkill(db, "skill-a", "alpha");
			const res = await app.request("/skill-a");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				skill: { name: string };
				content: string;
				files: { path: string; size: number }[];
			};
			expect(body.skill.name).toBe("alpha");
			expect(body.content).toContain("name: alpha");
			expect(body.files.map((f) => f.path)).toContain("SKILL.md");
		});

		it("404s an unknown skill", async () => {
			const res = await app.request("/nope");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Skill not found");
		});

		it("returns empty content when SKILL.md is missing", async () => {
			const now = "2026-07-04T00:00:00.000Z";
			insertRow(
				db,
				"skills",
				{
					id: "skill-empty",
					name: "empty",
					description: "no md",
					skill_root: "skills/empty",
					content_hash: null,
					allowed_tools: null,
					compatibility: null,
					metadata_json: null,
					activated_at: null,
					created_by_thread: null,
					activation_count: 0,
					last_activated_at: null,
					modified_at: now,
					deleted: 0,
				},
				SITE,
			);
			const body = (await (await app.request("/skill-empty")).json()) as { content: string };
			expect(body.content).toBe("");
		});
	});

	describe("POST / (JSON body)", () => {
		it("creates a skill from a JSON body with frontmatter fields", async () => {
			const res = await jsonCreate(app, {
				name: "jsonskill",
				description: "made from json",
				body: "Do the thing.",
				allowed_tools: "read,bash",
				compatibility: "*",
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as { skill: { name: string; description: string } };
			expect(body.skill.name).toBe("jsonskill");
			expect(body.skill.description).toBe("made from json");
			// SKILL.md was assembled with the body text.
			const file = db
				.query("SELECT content FROM files WHERE path LIKE '%jsonskill/SKILL.md'")
				.get() as { content: string } | null;
			expect(file?.content).toContain("Do the thing.");
		});

		it("400s a JSON body that fails skill validation (bad name)", async () => {
			const res = await jsonCreate(app, { name: "Bad Name!", description: "x", body: "y" });
			expect(res.status).toBe(400);
			expect(await res.json()).toHaveProperty("error");
		});
	});

	describe("POST / (multipart)", () => {
		it("creates a skill from a single .md upload", async () => {
			const file = new File([skillMd("mdskill", "from md", "Content.")], "skill.md", {
				type: "text/markdown",
			});
			const res = await multipart(app, file);
			expect(res.status).toBe(201);
			expect((await res.json()).skill.name).toBe("mdskill");
		});

		it("creates a skill from a .zip upload", async () => {
			const zipped = zipSync({
				"SKILL.md": new TextEncoder().encode(skillMd("zipskill", "from zip", "Zipped.")),
				"helper.md": new TextEncoder().encode("# helper"),
			});
			const file = new File([zipped], "skill.zip", { type: "application/zip" });
			const res = await multipart(app, file);
			expect(res.status).toBe(201);
			expect((await res.json()).skill.name).toBe("zipskill");
		});

		it("400s a zip with a path-traversal entry", async () => {
			const zipped = zipSync({
				"SKILL.md": new TextEncoder().encode(skillMd("evil", "x")),
				"../escape.txt": new TextEncoder().encode("nope"),
			});
			const file = new File([zipped], "skill.zip", { type: "application/zip" });
			const res = await multipart(app, file);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("path traversal");
		});

		it("400s a zip missing SKILL.md at root", async () => {
			const zipped = zipSync({ "notskill.md": new TextEncoder().encode("# nope") });
			const file = new File([zipped], "skill.zip", { type: "application/zip" });
			const res = await multipart(app, file);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("must contain SKILL.md");
		});

		it("400s a zip whose contents exceed the 64KB limit", async () => {
			const big = new Uint8Array(65 * 1024).fill(97);
			const zipped = zipSync({
				"SKILL.md": new TextEncoder().encode(skillMd("huge", "x")),
				"big.txt": big,
			});
			const file = new File([zipped], "skill.zip", { type: "application/zip" });
			const res = await multipart(app, file);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("exceed 64KB");
		});

		it("400s a non-.md/.zip upload", async () => {
			const file = new File(["data"], "skill.txt", { type: "text/plain" });
			const res = await multipart(app, file);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("must be .md or .zip");
		});

		it("400s a multipart request with no file", async () => {
			const form = new FormData();
			const res = await app.request("/", { method: "POST", body: form });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("No file uploaded");
		});

		it("400s a corrupt zip that fails to extract", async () => {
			const file = new File([new Uint8Array([1, 2, 3, 4])], "skill.zip", {
				type: "application/zip",
			});
			const res = await multipart(app, file);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Failed to extract zip");
		});
	});

	describe("POST / (invalid content-type)", () => {
		it("400s an unrecognized content type", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "raw",
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Invalid Content-Type");
		});
	});

	describe("PATCH /:id", () => {
		it("updates the description and body, keeping the name", async () => {
			seedSkill(db, "skill-a", "alpha");
			const res = await app.request("/skill-a", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "updated desc", body: "new body" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { skill: { description: string; name: string } };
			expect(body.skill.description).toBe("updated desc");
			expect(body.skill.name).toBe("alpha");
			const file = db
				.query("SELECT content FROM files WHERE path = 'skills/alpha/SKILL.md'")
				.get() as { content: string };
			expect(file.content).toContain("new body");
			expect(file.content).toContain("name: alpha");
		});

		it("merges allowed_tools and compatibility and preserves the existing body when omitted", async () => {
			seedSkill(db, "skill-a", "alpha");
			const res = await app.request("/skill-a", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ allowed_tools: "read", compatibility: "linux" }),
			});
			expect(res.status).toBe(200);
			const file = db
				.query("SELECT content FROM files WHERE path = 'skills/alpha/SKILL.md'")
				.get() as { content: string };
			expect(file.content).toContain("allowed_tools: read");
			expect(file.content).toContain("compatibility: linux");
			// The seeded body survived.
			expect(file.content).toContain("Body.");
		});

		it("404s an unknown skill", async () => {
			const res = await app.request("/nope", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "x" }),
			});
			expect(res.status).toBe(404);
		});

		it("500s on an invalid JSON body", async () => {
			seedSkill(db, "skill-a", "alpha");
			const res = await app.request("/skill-a", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: "{not json",
			});
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to update skill");
		});
	});

	describe("DELETE /:id", () => {
		it("soft-deletes the skill (204)", async () => {
			seedSkill(db, "skill-a", "alpha");
			const res = await app.request("/skill-a", { method: "DELETE" });
			expect(res.status).toBe(204);
			const row = db.query("SELECT deleted FROM skills WHERE id = ?").get("skill-a") as {
				deleted: number;
			};
			expect(row.deleted).toBe(1);
		});

		it("404s an unknown skill", async () => {
			const res = await app.request("/nope", { method: "DELETE" });
			expect(res.status).toBe(404);
		});

		it("returns 500 when the lookup throws", async () => {
			db.close();
			const res = await app.request("/any", { method: "DELETE" });
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to delete skill");
		});
	});

	describe("error paths (500) when the datastore throws", () => {
		it("GET /:id returns 500 when the lookup throws", async () => {
			db.close();
			const res = await app.request("/any");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to get skill");
		});

		it("POST / returns 500 when the create path throws", async () => {
			db.close();
			const res = await jsonCreate(app, { name: "x", description: "y", body: "z" });
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to create skill");
		});
	});
});
