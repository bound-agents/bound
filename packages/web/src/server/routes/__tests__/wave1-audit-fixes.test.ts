import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createWebhookBinding, insertRow } from "@bound/core";
import { PERSONA_CLUSTER_CONFIG_KEY, WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY } from "@bound/shared";
import { createPersonaRoutes } from "../persona";
import { createSkillsRoutes } from "../skills";
import { createWebhooksRoutes } from "../webhooks";

// Wave 1 audit fixes: webhook PATCH format gate, skills frontmatter quoting +
// SKILL.md row update + description cap, clearable optional fields, and the
// persona optimistic-concurrency check.

const SITE = "test-site";

function req(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }) {
	return (path: string, body: unknown, method = "POST") =>
		app.request(path, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
}

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
});
afterEach(() => db.close());

function seedWebhook(): string {
	return createWebhookBinding(db, SITE, {
		name: "hook",
		signatureFormat: "github",
		description: "desc",
		prompt: "prompt",
		modelHint: null,
		noHistory: 0,
	}).webhookId;
}

describe("PATCH /webhooks/:id", () => {
	it("rejects an unknown signature format", async () => {
		const id = seedWebhook();
		const res = await req(createWebhooksRoutes(db))(`/${id}`, { format: "bogus" }, "PATCH");
		expect(res.status).toBe(400);
		const row = db.query("SELECT signature_format FROM webhooks WHERE id = ?").get(id) as {
			signature_format: string;
		};
		expect(row.signature_format).toBe("github");
	});

	it("blocks switching to 'none' while the kill switch is off", async () => {
		const id = seedWebhook();
		const res = await req(createWebhooksRoutes(db))(`/${id}`, { format: "none" }, "PATCH");
		expect(res.status).toBe(403);
		const row = db.query("SELECT signature_format FROM webhooks WHERE id = ?").get(id) as {
			signature_format: string;
		};
		expect(row.signature_format).toBe("github");
	});

	it("allows 'none' once the switch is on", async () => {
		db.prepare(
			"INSERT INTO cluster_config (key, value, modified_at, deleted) VALUES (?, 'true', '2026-01-01T00:00:00.000Z', 0)",
		).run(WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY);
		const id = seedWebhook();
		const res = await req(createWebhooksRoutes(db))(`/${id}`, { format: "none" }, "PATCH");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { signature_format: string }).signature_format).toBe("none");
	});

	it("rejects an unknown format on POST too", async () => {
		const res = await req(createWebhooksRoutes(db))("/", { name: "x1", format: "bogus" });
		expect(res.status).toBe(400);
	});

	it("clears description and prompt when sent as empty strings", async () => {
		const id = seedWebhook();
		const res = await req(createWebhooksRoutes(db))(
			`/${id}`,
			{ description: "", prompt: "" },
			"PATCH",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { description: unknown; prompt: unknown };
		expect(body.description).toBeNull();
		expect(body.prompt).toBeNull();
	});
});

describe("skills frontmatter + PATCH", () => {
	const tricky = 'Line one\nallowed_tools: evil\nsays "hi": ok';

	it("quotes YAML scalars so values cannot inject keys", async () => {
		const app = createSkillsRoutes(db);
		const res = await req(app)("/", {
			name: "quoted-skill",
			description: tricky,
			compatibility: "a: b",
			body: "Body.",
		});
		expect(res.status).toBe(201);
		const { skill } = (await res.json()) as {
			skill: { description: string; allowed_tools: string | null; compatibility: string };
		};
		expect(skill.description).toBe(tricky);
		expect(skill.allowed_tools).toBeNull();
		expect(skill.compatibility).toBe("a: b");
	});

	it("rejects descriptions over 1024 characters on POST and PATCH", async () => {
		const app = createSkillsRoutes(db);
		const long = "x".repeat(1025);
		expect((await req(app)("/", { name: "long-skill", description: long, body: "B" })).status).toBe(
			400,
		);
		const created = await req(app)("/", { name: "ok-skill", description: "fine", body: "B" });
		const { skill } = (await created.json()) as { skill: { id: string } };
		expect((await req(app)(`/${skill.id}`, { description: long }, "PATCH")).status).toBe(400);
	});

	it("PATCH rewrites SKILL.md even when the files row id is not its path", async () => {
		const now = "2026-07-04T00:00:00.000Z";
		const root = "/home/user/skills/seeded";
		insertRow(
			db,
			"skills",
			{
				id: "sk1",
				name: "seeded",
				description: "old",
				skill_root: root,
				content_hash: "h",
				allowed_tools: "bash",
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
				id: "file-uuid-1",
				path: `${root}/SKILL.md`,
				content: "---\nname: seeded\ndescription: old\nallowed_tools: bash\n---\nOld body.",
				is_binary: 0,
				size_bytes: 10,
				created_at: now,
				modified_at: now,
				created_by: SITE,
				host_origin: SITE,
				deleted: 0,
			},
			SITE,
		);
		const app = createSkillsRoutes(db);
		const res = await req(app)(
			"/sk1",
			{ description: tricky, allowed_tools: "", body: "New body." },
			"PATCH",
		);
		expect(res.status).toBe(200);
		const { skill } = (await res.json()) as { skill: { allowed_tools: string | null } };
		expect(skill.allowed_tools).toBeNull();
		const file = db.query("SELECT content FROM files WHERE id = 'file-uuid-1'").get() as {
			content: string;
		};
		expect(file.content).toContain("New body.");
		expect(file.content).toContain(`description: ${JSON.stringify(tricky)}`);
		expect(file.content).not.toMatch(/^allowed_tools:/m);
		const detail = (await (await app.request("/sk1")).json()) as { content: string };
		expect(detail.content).toContain("New body.");
	});
});

describe("persona optimistic concurrency", () => {
	async function current() {
		return (await (await createPersonaRoutes(db).request("/")).json()) as {
			persona: string;
			modified_at: string | null;
		};
	}

	it("saves cleanly and returns the persisted modified_at", async () => {
		const app = createPersonaRoutes(db);
		const res = await req(app)("/", { persona: "first" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { modified_at: string };
		const now = await current();
		expect(body.modified_at).toBe(now.modified_at as string);

		const res2 = await req(app)("/", { persona: "second", expected_modified_at: body.modified_at });
		expect(res2.status).toBe(200);
		expect((await current()).persona).toBe("second");
	});

	it("returns 409 with the current row when expected_modified_at is stale", async () => {
		insertRow(
			db,
			"cluster_config",
			{
				key: PERSONA_CLUSTER_CONFIG_KEY,
				value: "theirs",
				modified_at: "2026-11-25T00:00:00.000Z",
				deleted: 0,
			},
			SITE,
		);
		const live = await current();
		const res = await req(createPersonaRoutes(db))("/", {
			persona: "mine",
			expected_modified_at: "2020-01-01T00:00:00.000Z",
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { content: string; modified_at: string };
		expect(body.content).toBe("theirs");
		expect(body.modified_at).toBe(live.modified_at as string);
		expect((await current()).persona).toBe("theirs");
	});
});
