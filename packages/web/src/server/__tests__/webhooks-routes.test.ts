import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { createWebhooksRoutes } from "../routes/webhooks";

let db: Database;
let siteId: string;
type WebhooksApp = ReturnType<typeof createWebhooksRoutes>;

function request(app: WebhooksApp, method: string, path = "/", body?: string): Promise<Response> {
	return app.fetch(
		new Request(`http://localhost${path}`, body === undefined ? { method } : { method, body }),
	);
}

type WebhookResponse = Record<string, unknown>;

async function createWebhook(
	app: WebhooksApp,
	body: Record<string, unknown>,
): Promise<WebhookResponse> {
	const response = await request(app, "POST", "/", JSON.stringify(body));
	expect(response.status).toBe(201);
	return (await response.json()) as WebhookResponse;
}

async function patchWebhook(
	app: WebhooksApp,
	id: string,
	body: Record<string, unknown>,
): Promise<WebhookResponse> {
	const response = await request(app, "PATCH", `/${id}`, JSON.stringify(body));
	expect(response.status).toBe(200);
	return (await response.json()) as WebhookResponse;
}

async function listWebhooks(app: WebhooksApp): Promise<WebhookResponse[]> {
	const response = await request(app, "GET");
	expect(response.status).toBe(200);
	return (await response.json()) as WebhookResponse[];
}

async function getWebhook(app: WebhooksApp, id: string): Promise<WebhookResponse> {
	const response = await request(app, "GET", `/${id}`);
	expect(response.status).toBe(200);
	return (await response.json()) as WebhookResponse;
}

function linkedTaskValue<T>(webhookId: string, column: "model_hint" | "no_history"): T {
	const webhook = db.prepare("SELECT task_id FROM webhooks WHERE id = ?").get(webhookId) as {
		task_id: string;
	};
	return (
		db.prepare(`SELECT ${column} FROM tasks WHERE id = ?`).get(webhook.task_id) as Record<string, T>
	)[column];
}

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);

	// Set up site_id
	siteId = `test-site-${randomBytes(4).toString("hex")}`;
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
});

describe("webhooks routes", () => {
	describe("AC5.1: POST /api/webhooks creates webhook and returns secret", () => {
		it("creates a webhook with required fields", async () => {
			const app = createWebhooksRoutes(db);
			const body = JSON.stringify({
				name: "test-webhook",
				format: "github",
				description: "Test webhook",
				prompt: "Custom prompt",
			});

			const response = await app.fetch(new Request("http://localhost/", { method: "POST", body }));

			expect(response.status).toBe(201);
			const json = (await response.json()) as Record<string, unknown>;

			// Check that response includes secret
			expect(json).toHaveProperty("secret");
			expect(typeof json.secret).toBe("string");
			expect((json.secret as string).length).toBe(64); // 32 bytes = 64 hex chars

			// Check other fields are present
			expect(json.name).toBe("test-webhook");
			expect(json.signature_format).toBe("github");
			expect(json.description).toBe("Test webhook");
		});

		it("maps a persistence error to the existing 500 body without returning a created webhook", async () => {
			const app = createWebhooksRoutes(db);
			db.exec(`
				CREATE TRIGGER abort_http_webhook_task_insert
				BEFORE INSERT ON tasks
				WHEN NEW.trigger_spec = 'webhook:persistence-failure'
				BEGIN SELECT RAISE(ABORT, 'forced HTTP persistence failure'); END
			`);

			const response = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "persistence-failure" }),
				}),
			);

			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: "Failed to create webhook",
				details: "forced HTTP persistence failure",
			});
			expect(db.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 1 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT COUNT(*) AS count FROM webhooks").get()).toEqual({ count: 0 });
		});

		it("validates webhook name format", async () => {
			const app = createWebhooksRoutes(db);

			// Invalid name (uppercase)
			const body = JSON.stringify({ name: "TestWebhook" });
			const response = await app.fetch(new Request("http://localhost/", { method: "POST", body }));

			expect(response.status).toBe(400);
		});

		it("rejects duplicate webhook names", async () => {
			const app = createWebhooksRoutes(db);

			// Create first webhook
			const body1 = JSON.stringify({ name: "unique-webhook" });
			const response1 = await request(app, "POST", "/", body1);
			expect(response1.status).toBe(201);

			// Try to create duplicate
			const body2 = JSON.stringify({ name: "unique-webhook" });
			const response2 = await request(app, "POST", "/", body2);
			expect(response2.status).toBe(400);
		});

		it("allows reusing a name after the prior webhook was deleted", async () => {
			// Regression for #59: creating a webhook with the same name as a
			// soft-deleted webhook used to fail.
			const app = createWebhooksRoutes(db);

			// Create the original webhook.
			const body1 = JSON.stringify({ name: "reusable-name" });
			const response1 = await request(app, "POST", "/", body1);
			expect(response1.status).toBe(201);
			const created = (await response1.json()) as { id: string };

			// Delete it (soft-delete + cancel task).
			const deleteResponse = await request(app, "DELETE", `/${created.id}`);
			expect(deleteResponse.status).toBe(204);

			// Create a fresh webhook with the same name. This must succeed.
			const body2 = JSON.stringify({ name: "reusable-name" });
			const response2 = await request(app, "POST", "/", body2);
			if (response2.status !== 201) {
				console.error("recreate failed:", await response2.text());
			}
			expect(response2.status).toBe(201);
		});
	});

	describe("AC5.2: GET /api/webhooks returns list without secret", () => {
		it("returns list of webhooks without secret field", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "list-test-webhook" });
			const createResponse = await request(app, "POST", "/", createBody);
			expect(createResponse.status).toBe(201);

			// Get list
			const listResponse = await request(app, "GET", "/");

			expect(listResponse.status).toBe(200);
			const json = (await listResponse.json()) as unknown[];

			expect(Array.isArray(json)).toBe(true);
			expect(json.length).toBeGreaterThan(0);

			// Check that secret is NOT included
			for (const webhook of json) {
				const w = webhook as Record<string, unknown>;
				expect(w).not.toHaveProperty("secret");
				expect(w.name).toBeDefined();
			}
		});

		it("includes prompt (task.system_prompt_addition) in list entries", async () => {
			const app = createWebhooksRoutes(db);

			// Create one webhook with a prompt and one without
			const withPrompt = JSON.stringify({
				name: "with-prompt-webhook",
				prompt: "Handle GitHub events carefully",
			});
			const withoutPrompt = JSON.stringify({ name: "without-prompt-webhook" });

			await request(app, "POST", "/", withPrompt);
			await request(app, "POST", "/", withoutPrompt);

			const listResponse = await request(app, "GET", "/");
			expect(listResponse.status).toBe(200);
			const json = (await listResponse.json()) as Array<Record<string, unknown>>;

			const withPromptEntry = json.find((w) => w.name === "with-prompt-webhook");
			const withoutPromptEntry = json.find((w) => w.name === "without-prompt-webhook");

			expect(withPromptEntry).toBeDefined();
			expect(withPromptEntry?.prompt).toBe("Handle GitHub events carefully");

			expect(withoutPromptEntry).toBeDefined();
			expect(withoutPromptEntry).toHaveProperty("prompt");
			expect(withoutPromptEntry?.prompt).toBeNull();
		});
	});

	describe("AC5.6: GET /api/webhooks/:id does not include secret", () => {
		it("returns single webhook without secret field", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "get-test-webhook" });
			const createResponse = await request(app, "POST", "/", createBody);
			expect(createResponse.status).toBe(201);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Get single webhook
			const getResponse = await app.fetch(new Request(`http://localhost/${id}`, { method: "GET" }));

			expect(getResponse.status).toBe(200);
			const json = (await getResponse.json()) as Record<string, unknown>;

			// Check that secret is NOT included
			expect(json).not.toHaveProperty("secret");
			expect(json.name).toBe("get-test-webhook");
		});

		it("returns 404 for non-existent webhook", async () => {
			const app = createWebhooksRoutes(db);

			const response = await request(app, "GET", "/nonexistent-id");

			expect(response.status).toBe(404);
		});

		it("includes prompt (task.system_prompt_addition) in detail response", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook with a custom prompt
			const createBody = JSON.stringify({
				name: "detail-prompt-webhook",
				prompt: "Detail-view prompt content",
			});
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			const getResponse = await app.fetch(new Request(`http://localhost/${id}`, { method: "GET" }));
			expect(getResponse.status).toBe(200);
			const json = (await getResponse.json()) as Record<string, unknown>;

			expect(json.prompt).toBe("Detail-view prompt content");
		});
	});

	describe("AC5.3: PATCH /api/webhooks/:id updates editable fields", () => {
		it("updates description field", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "patch-test-webhook", description: "Old" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Update description
			const patchBody = JSON.stringify({ description: "New description" });
			const patchResponse = await request(app, "PATCH", `/${id}`, patchBody);

			expect(patchResponse.status).toBe(200);
			const updated = (await patchResponse.json()) as Record<string, unknown>;
			expect(updated.description).toBe("New description");
		});

		it("updates prompt field (task.system_prompt_addition)", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "prompt-test-webhook", prompt: "Old prompt" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Update prompt
			const patchBody = JSON.stringify({ prompt: "New prompt" });
			const patchResponse = await request(app, "PATCH", `/${id}`, patchBody);

			expect(patchResponse.status).toBe(200);

			// Response should include the updated prompt so the UI can refresh
			const patched = (await patchResponse.json()) as Record<string, unknown>;
			expect(patched.prompt).toBe("New prompt");

			// Verify task was updated
			const webhook = db.prepare("SELECT task_id FROM webhooks WHERE id = ?").get(id) as {
				task_id: string;
			};
			const task = db
				.prepare("SELECT system_prompt_addition FROM tasks WHERE id = ?")
				.get(webhook.task_id) as { system_prompt_addition: string };

			expect(task.system_prompt_addition).toBe("New prompt");
		});

		it("updates format field", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "format-test-webhook", format: "github" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Update format
			const patchBody = JSON.stringify({ format: "gitlab" });
			const patchResponse = await request(app, "PATCH", `/${id}`, patchBody);

			expect(patchResponse.status).toBe(200);
			const updated = (await patchResponse.json()) as Record<string, unknown>;
			expect(updated.signature_format).toBe("gitlab");
		});
	});

	describe("AC5.7: PATCH ignores non-editable fields", () => {
		it("ignores name field in PATCH", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "original-name" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Try to update name
			const patchBody = JSON.stringify({ name: "new-name" });
			const patchResponse = await request(app, "PATCH", `/${id}`, patchBody);

			expect(patchResponse.status).toBe(200);

			// Verify name was not changed
			const webhook = db.prepare("SELECT name FROM webhooks WHERE id = ?").get(id) as {
				name: string;
			};
			expect(webhook.name).toBe("original-name");
		});

		it("ignores thread_id field in PATCH", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "thread-test" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;
			const originalThreadId = created.thread_id as string;

			// Try to update thread_id
			const patchBody = JSON.stringify({ thread_id: "fake-thread-id" });
			const patchResponse = await request(app, "PATCH", `/${id}`, patchBody);

			expect(patchResponse.status).toBe(200);

			// Verify thread_id was not changed
			const webhook = db.prepare("SELECT thread_id FROM webhooks WHERE id = ?").get(id) as {
				thread_id: string;
			};
			expect(webhook.thread_id).toBe(originalThreadId);
		});

		it("ignores secret field in PATCH", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "secret-test" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;
			const originalSecret = created.secret as string;

			// Try to update secret
			const patchBody = JSON.stringify({ secret: "fake-secret" });
			const patchResponse = await request(app, "PATCH", `/${id}`, patchBody);

			expect(patchResponse.status).toBe(200);

			// Verify secret was not changed
			const webhook = db.prepare("SELECT secret FROM webhooks WHERE id = ?").get(id) as {
				secret: string;
			};
			expect(webhook.secret).toBe(originalSecret);
		});
	});

	describe("model_hint round-trip on tasks.model_hint", () => {
		function taskModelFor(webhookId: string): string | null {
			return linkedTaskValue<string | null>(webhookId, "model_hint");
		}

		it("POST without model_hint stores null on the task (uses cluster default)", async () => {
			const created = await createWebhook(createWebhooksRoutes(db), { name: "no-model-webhook" });
			expect(created.model_hint).toBeNull();
			expect(taskModelFor(created.id as string)).toBeNull();
		});

		it("POST with model_hint stores it on the linked task and thread", async () => {
			const created = await createWebhook(createWebhooksRoutes(db), {
				name: "kimi-webhook",
				model_hint: "kimi-k2",
			});
			expect(created.model_hint).toBe("kimi-k2");
			expect(taskModelFor(created.id as string)).toBe("kimi-k2");
			const webhook = db.prepare("SELECT thread_id FROM webhooks WHERE id = ?").get(created.id) as {
				thread_id: string;
			};
			const thread = db
				.prepare("SELECT model_hint FROM threads WHERE id = ?")
				.get(webhook.thread_id) as { model_hint: string | null };
			expect(thread.model_hint).toBe("kimi-k2");
		});

		it("POST with empty-string model_hint stores null", async () => {
			const created = await createWebhook(createWebhooksRoutes(db), {
				name: "empty-model-webhook",
				model_hint: "",
			});
			expect(created.model_hint).toBeNull();
			expect(taskModelFor(created.id as string)).toBeNull();
		});

		it("GET list and detail include model_hint", async () => {
			const app = createWebhooksRoutes(db);
			await createWebhook(app, { name: "list-model-webhook", model_hint: "kimi-k2" });
			const listed = await listWebhooks(app);
			expect(listed[0]?.model_hint).toBe("kimi-k2");
			const detail = await getWebhook(app, listed[0]?.id as string);
			expect(detail.model_hint).toBe("kimi-k2");
		});

		it("PATCH with model_hint sets it on the task", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, { name: "patch-model-webhook" });
			const patched = await patchWebhook(app, created.id as string, { model_hint: "kimi-k2" });
			expect(patched.model_hint).toBe("kimi-k2");
			expect(taskModelFor(created.id as string)).toBe("kimi-k2");
		});

		it("PATCH with model_hint=null clears it back to default", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, {
				name: "clear-model-webhook",
				model_hint: "kimi-k2",
			});
			expect(taskModelFor(created.id as string)).toBe("kimi-k2");
			const patched = await patchWebhook(app, created.id as string, { model_hint: null });
			expect(patched.model_hint).toBeNull();
			expect(taskModelFor(created.id as string)).toBeNull();
		});

		it("PATCH without model_hint key leaves existing model_hint alone", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, {
				name: "leave-model-webhook",
				model_hint: "kimi-k2",
			});
			const patched = await patchWebhook(app, created.id as string, {
				description: "unrelated change",
			});
			expect(patched.model_hint).toBe("kimi-k2");
			expect(taskModelFor(created.id as string)).toBe("kimi-k2");
		});
	});

	// no_history round-trip: stored as INTEGER 0/1 on tasks, exposed as boolean
	// over the JSON API (#54).
	describe("no_history round-trip on tasks.no_history", () => {
		function taskNoHistoryFor(webhookId: string): number | null {
			return linkedTaskValue<number | null>(webhookId, "no_history");
		}

		it.each([
			["default-no-history", undefined, false, 0],
			["no-history-true", true, true, 1],
			["no-history-false", false, false, 0],
		])(
			"POST with no_history=%p returns %p and stores %p",
			async (name, no_history, exposed, stored) => {
				const created = await createWebhook(createWebhooksRoutes(db), {
					name,
					...(no_history === undefined ? {} : { no_history }),
				});
				expect(created.no_history).toBe(exposed);
				expect(taskNoHistoryFor(created.id as string)).toBe(stored);
			},
		);

		it("GET list and detail include no_history as boolean", async () => {
			const app = createWebhooksRoutes(db);
			await createWebhook(app, { name: "listed-no-history", no_history: true });
			const listed = await listWebhooks(app);
			expect(listed[0]?.no_history).toBe(true);
			expect(typeof listed[0]?.no_history).toBe("boolean");
			const detail = await getWebhook(app, listed[0]?.id as string);
			expect(detail.no_history).toBe(true);
		});

		it("PATCH with no_history=true sets it on the task", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, { name: "patch-no-history" });
			const patched = await patchWebhook(app, created.id as string, { no_history: true });
			expect(patched.no_history).toBe(true);
			expect(taskNoHistoryFor(created.id as string)).toBe(1);
		});

		it("PATCH with no_history=false clears it back to 0", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, { name: "clear-no-history", no_history: true });
			expect(taskNoHistoryFor(created.id as string)).toBe(1);
			const patched = await patchWebhook(app, created.id as string, { no_history: false });
			expect(patched.no_history).toBe(false);
			expect(taskNoHistoryFor(created.id as string)).toBe(0);
		});

		it("PATCH without no_history key leaves existing no_history alone", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, { name: "leave-no-history", no_history: true });
			const patched = await patchWebhook(app, created.id as string, { description: "unrelated" });
			expect(patched.no_history).toBe(true);
			expect(taskNoHistoryFor(created.id as string)).toBe(1);
		});

		it("PATCH with non-boolean no_history returns 400", async () => {
			const app = createWebhooksRoutes(db);
			const created = await createWebhook(app, { name: "bad-no-history" });
			const response = await request(
				app,
				"PATCH",
				`/${created.id}`,
				JSON.stringify({ no_history: "yes" }),
			);
			expect(response.status).toBe(400);
			expect(((await response.json()) as WebhookResponse).error).toContain("no_history");
			expect(taskNoHistoryFor(created.id as string)).toBe(0);
		});
	});

	describe("AC5.4: DELETE /api/webhooks/:id soft-deletes and cancels task", () => {
		it("soft-deletes webhook and cancels task", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "delete-test-webhook" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Get the task_id
			const webhook = db.prepare("SELECT task_id FROM webhooks WHERE id = ?").get(id) as {
				task_id: string;
			};

			// Delete webhook
			const deleteResponse = await request(app, "DELETE", `/${id}`);

			expect(deleteResponse.status).toBe(204);

			// Verify webhook is soft-deleted
			const deletedWebhook = db.prepare("SELECT deleted FROM webhooks WHERE id = ?").get(id) as {
				deleted: number;
			};
			expect(deletedWebhook.deleted).toBe(1);

			// Verify task is cancelled
			const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(webhook.task_id) as {
				status: string;
			};
			expect(task.status).toBe("cancelled");
		});
	});

	describe("AC5.5: POST /api/webhooks/:id/rotate returns new secret", () => {
		it("rotates secret and returns only new secret", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "rotate-test-webhook" });
			const createResponse = await request(app, "POST", "/", createBody);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;
			const originalSecret = created.secret as string;

			// Rotate secret
			const rotateResponse = await request(app, "POST", `/${id}/rotate`);

			expect(rotateResponse.status).toBe(200);
			const json = (await rotateResponse.json()) as Record<string, unknown>;

			// Response should only have 'secret' field
			const keys = Object.keys(json);
			expect(keys.length).toBe(1);
			expect(json).toHaveProperty("secret");

			// New secret should be different
			const newSecret = json.secret as string;
			expect(newSecret).not.toBe(originalSecret);
			expect(newSecret.length).toBe(64);

			// Verify database was updated
			const webhook = db.prepare("SELECT secret FROM webhooks WHERE id = ?").get(id) as {
				secret: string;
			};
			expect(webhook.secret).toBe(newSecret);
		});
	});

	describe("#195: unauthenticated-webhook kill switch", () => {
		it("GET /unauthenticated-switch defaults to false (row absent)", async () => {
			const app = createWebhooksRoutes(db);
			const res = await request(app, "GET", "/unauthenticated-switch");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ allow_unauthenticated: false });
		});

		it("rejects creating a format=none webhook while the switch is off (403)", async () => {
			const app = createWebhooksRoutes(db);
			const res = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "unauth-hook", format: "none" }),
				}),
			);
			expect(res.status).toBe(403);
			const count = db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE deleted = 0").get() as {
				n: number;
			};
			expect(count.n).toBe(0);
		});

		it("PUT /unauthenticated-switch flips the switch and then format=none creates (201)", async () => {
			const app = createWebhooksRoutes(db);

			const put = await app.fetch(
				new Request("http://localhost/unauthenticated-switch", {
					method: "PUT",
					body: JSON.stringify({ allow_unauthenticated: true }),
				}),
			);
			expect(put.status).toBe(200);
			expect(await put.json()).toEqual({ allow_unauthenticated: true });

			const get = await request(app, "GET", "/unauthenticated-switch");
			expect(await get.json()).toEqual({ allow_unauthenticated: true });

			const create = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "unauth-hook", format: "none" }),
				}),
			);
			expect(create.status).toBe(201);
			const created = (await create.json()) as Record<string, unknown>;
			expect(created.signature_format).toBe("none");
		});

		it("PUT rejects a non-boolean allow_unauthenticated (400)", async () => {
			const app = createWebhooksRoutes(db);
			const res = await app.fetch(
				new Request("http://localhost/unauthenticated-switch", {
					method: "PUT",
					body: JSON.stringify({ allow_unauthenticated: "yes" }),
				}),
			);
			expect(res.status).toBe(400);
		});

		it("disabling the switch again blocks format=none creates (round-trip)", async () => {
			const app = createWebhooksRoutes(db);
			const set = (allow: boolean) =>
				app.fetch(
					new Request("http://localhost/unauthenticated-switch", {
						method: "PUT",
						body: JSON.stringify({ allow_unauthenticated: allow }),
					}),
				);
			await set(true);
			await set(false);
			const get = await request(app, "GET", "/unauthenticated-switch");
			expect(await get.json()).toEqual({ allow_unauthenticated: false });
			const res = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "unauth-hook-2", format: "none" }),
				}),
			);
			expect(res.status).toBe(403);
		});
	});
});
