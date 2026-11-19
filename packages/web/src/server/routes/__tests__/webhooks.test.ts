import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createWebhookBinding } from "@bound/core";
import { WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY } from "@bound/shared";
import { createWebhooksRoutes } from "../webhooks";

// Focused coverage for the webhooks-route branches the integration test
// (webhooks-routes.test.ts via createWebApp) does not exercise: the
// unauthenticated-switch GET/PUT, the /:id/urls enumeration, the "none"-format
// creation gate, and the datastore 500 paths.

const SITE = "test-site";

function makeApp(db: Database) {
	return createWebhooksRoutes(db, {
		syncBindHost: "localhost",
		syncPort: 3000,
		hostName: "local-host",
		siteId: SITE,
	});
}

function seed(db: Database, name: string, format: "github" | "none" = "github"): string {
	return createWebhookBinding(db, SITE, {
		name,
		signatureFormat: format,
		description: null,
		prompt: null,
		modelHint: null,
		noHistory: 0,
	}).webhookId;
}

function postJson(app: ReturnType<typeof makeApp>, path: string, body: unknown, method = "POST") {
	return app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function setSwitch(db: Database, on: boolean): void {
	const now = "2026-07-04T00:00:00.000Z";
	db.prepare(
		"INSERT INTO cluster_config (key, value, modified_at, deleted) VALUES (?, ?, ?, 0)",
	).run(WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY, on ? "true" : "false", now);
}

describe("webhooks routes (branch coverage)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /unauthenticated-switch", () => {
		it("reads disabled by default (no row)", async () => {
			const res = await makeApp(db).request("/unauthenticated-switch");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ allow_unauthenticated: false });
		});

		it("reads enabled when the config row is 'true'", async () => {
			setSwitch(db, true);
			const res = await makeApp(db).request("/unauthenticated-switch");
			expect(await res.json()).toEqual({ allow_unauthenticated: true });
		});

		it("returns 500 when the config read throws", async () => {
			const app = makeApp(db);
			db.close();
			const res = await app.request("/unauthenticated-switch");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to read switch");
		});
	});

	describe("PUT /unauthenticated-switch", () => {
		it("inserts the config row when none exists", async () => {
			const res = await postJson(
				makeApp(db),
				"/unauthenticated-switch",
				{
					allow_unauthenticated: true,
				},
				"PUT",
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ allow_unauthenticated: true });
			const row = db
				.query("SELECT value FROM cluster_config WHERE key = ?")
				.get(WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY) as { value: string };
			expect(row.value).toBe("true");
		});

		it("updates (un-tombstones) an existing config row", async () => {
			setSwitch(db, true);
			const res = await postJson(
				makeApp(db),
				"/unauthenticated-switch",
				{
					allow_unauthenticated: false,
				},
				"PUT",
			);
			expect(res.status).toBe(200);
			const row = db
				.query("SELECT value FROM cluster_config WHERE key = ?")
				.get(WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY) as { value: string };
			expect(row.value).toBe("false");
		});

		it("400s a non-boolean switch value", async () => {
			const res = await postJson(
				makeApp(db),
				"/unauthenticated-switch",
				{
					allow_unauthenticated: "yes",
				},
				"PUT",
			);
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("must be a boolean");
		});

		it("500s on an invalid JSON body", async () => {
			const res = await makeApp(db).request("/unauthenticated-switch", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: "{not json",
			});
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to update switch");
		});
	});

	describe("GET /:id/urls", () => {
		it("enumerates delivery URLs for a webhook by name", async () => {
			const id = seed(db, "deploy");
			const res = await makeApp(db).request(`/${id}/urls`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { name: string; urls: unknown[] };
			expect(body.name).toBe("deploy");
			expect(Array.isArray(body.urls)).toBe(true);
			expect(body.urls.length).toBeGreaterThan(0);
		});

		it("404s an unknown webhook id", async () => {
			const res = await makeApp(db).request("/nope/urls");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Webhook not found");
		});

		it("500s when the name lookup throws", async () => {
			const app = makeApp(db);
			db.close();
			const res = await app.request("/any/urls");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list webhook URLs");
		});
	});

	describe("POST / — 'none' format gate", () => {
		it("403s a 'none' webhook when the cluster switch is off", async () => {
			const res = await postJson(makeApp(db), "/", { name: "unauth", format: "none" });
			expect(res.status).toBe(403);
			expect((await res.json()).error).toContain("Unauthenticated webhooks");
		});

		it("creates a 'none' webhook once the switch is enabled", async () => {
			setSwitch(db, true);
			const res = await postJson(makeApp(db), "/", { name: "unauth", format: "none" });
			expect(res.status).toBe(201);
			const body = (await res.json()) as { signature_format: string; secret: string };
			expect(body.signature_format).toBe("none");
			expect(typeof body.secret).toBe("string");
		});

		it("400s a missing name", async () => {
			const res = await postJson(makeApp(db), "/", { format: "github" });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("name is required");
		});

		it("400s an invalid name format", async () => {
			const res = await postJson(makeApp(db), "/", { name: "Bad Name" });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("Invalid webhook name");
		});
	});

	describe("DELETE and rotate error paths", () => {
		it("DELETE 404s an unknown webhook", async () => {
			const res = await makeApp(db).request("/nope", { method: "DELETE" });
			expect(res.status).toBe(404);
		});

		it("rotate 404s an unknown webhook", async () => {
			const res = await makeApp(db).request("/nope/rotate", { method: "POST" });
			expect(res.status).toBe(404);
		});

		it("rotate replaces the secret of an existing webhook", async () => {
			const id = seed(db, "rotateme");
			const before = db.query("SELECT secret FROM webhooks WHERE id = ?").get(id) as {
				secret: string;
			};
			const res = await makeApp(db).request(`/${id}/rotate`, { method: "POST" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { secret: string };
			expect(body.secret).not.toBe(before.secret);
			expect(body.secret).toHaveLength(64);
		});
	});

	describe("list / detail 500 paths", () => {
		it("GET / 500s when the list query throws", async () => {
			const app = makeApp(db);
			db.close();
			const res = await app.request("/");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list webhooks");
		});

		it("GET /:id 500s when the lookup throws", async () => {
			const app = makeApp(db);
			db.close();
			const res = await app.request("/any");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to get webhook");
		});
	});
});
