import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { createWebhooksRoutes } from "../routes/webhooks";

let db: Database;
let siteId: string;

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
			const response1 = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: body1 }),
			);
			expect(response1.status).toBe(201);

			// Try to create duplicate
			const body2 = JSON.stringify({ name: "unique-webhook" });
			const response2 = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: body2 }),
			);
			expect(response2.status).toBe(400);
		});
	});

	describe("AC5.2: GET /api/webhooks returns list without secret", () => {
		it("returns list of webhooks without secret field", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "list-test-webhook" });
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			expect(createResponse.status).toBe(201);

			// Get list
			const listResponse = await app.fetch(new Request("http://localhost/", { method: "GET" }));

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

			await app.fetch(new Request("http://localhost/", { method: "POST", body: withPrompt }));
			await app.fetch(new Request("http://localhost/", { method: "POST", body: withoutPrompt }));

			const listResponse = await app.fetch(new Request("http://localhost/", { method: "GET" }));
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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
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

			const response = await app.fetch(
				new Request("http://localhost/nonexistent-id", { method: "GET" }),
			);

			expect(response.status).toBe(404);
		});

		it("includes prompt (task.system_prompt_addition) in detail response", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook with a custom prompt
			const createBody = JSON.stringify({
				name: "detail-prompt-webhook",
				prompt: "Detail-view prompt content",
			});
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Update description
			const patchBody = JSON.stringify({ description: "New description" });
			const patchResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "PATCH", body: patchBody }),
			);

			expect(patchResponse.status).toBe(200);
			const updated = (await patchResponse.json()) as Record<string, unknown>;
			expect(updated.description).toBe("New description");
		});

		it("updates prompt field (task.system_prompt_addition)", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "prompt-test-webhook", prompt: "Old prompt" });
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Update prompt
			const patchBody = JSON.stringify({ prompt: "New prompt" });
			const patchResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "PATCH", body: patchBody }),
			);

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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Update format
			const patchBody = JSON.stringify({ format: "gitlab" });
			const patchResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "PATCH", body: patchBody }),
			);

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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Try to update name
			const patchBody = JSON.stringify({ name: "new-name" });
			const patchResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "PATCH", body: patchBody }),
			);

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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;
			const originalThreadId = created.thread_id as string;

			// Try to update thread_id
			const patchBody = JSON.stringify({ thread_id: "fake-thread-id" });
			const patchResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "PATCH", body: patchBody }),
			);

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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;
			const originalSecret = created.secret as string;

			// Try to update secret
			const patchBody = JSON.stringify({ secret: "fake-secret" });
			const patchResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "PATCH", body: patchBody }),
			);

			expect(patchResponse.status).toBe(200);

			// Verify secret was not changed
			const webhook = db.prepare("SELECT secret FROM webhooks WHERE id = ?").get(id) as {
				secret: string;
			};
			expect(webhook.secret).toBe(originalSecret);
		});
	});

	describe("model_hint round-trip on tasks.model_hint", () => {
		const taskModelFor = (db: Database, webhookId: string): string | null => {
			const wh = db
				.prepare("SELECT task_id, thread_id FROM webhooks WHERE id = ?")
				.get(webhookId) as { task_id: string; thread_id: string };
			const task = db.prepare("SELECT model_hint FROM tasks WHERE id = ?").get(wh.task_id) as {
				model_hint: string | null;
			};
			return task.model_hint;
		};

		it("POST without model_hint stores null on the task (uses cluster default)", async () => {
			const app = createWebhooksRoutes(db);
			const createResponse = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "no-model-webhook" }),
				}),
			);
			expect(createResponse.status).toBe(201);
			const created = (await createResponse.json()) as Record<string, unknown>;

			expect(created.model_hint).toBeNull();
			expect(taskModelFor(db, created.id as string)).toBeNull();
		});

		it("POST with model_hint stores it on the linked task and thread", async () => {
			const app = createWebhooksRoutes(db);
			const createResponse = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "kimi-webhook", model_hint: "kimi-k2" }),
				}),
			);
			expect(createResponse.status).toBe(201);
			const created = (await createResponse.json()) as Record<string, unknown>;

			expect(created.model_hint).toBe("kimi-k2");
			expect(taskModelFor(db, created.id as string)).toBe("kimi-k2");

			// Thread should be mirrored too (matches CLI behaviour)
			const wh = db
				.prepare("SELECT thread_id FROM webhooks WHERE id = ?")
				.get(created.id as string) as { thread_id: string };
			const thread = db
				.prepare("SELECT model_hint FROM threads WHERE id = ?")
				.get(wh.thread_id) as { model_hint: string | null };
			expect(thread.model_hint).toBe("kimi-k2");
		});

		it("POST with empty-string model_hint stores null", async () => {
			const app = createWebhooksRoutes(db);
			const createResponse = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "empty-model-webhook", model_hint: "" }),
				}),
			);
			expect(createResponse.status).toBe(201);
			const created = (await createResponse.json()) as Record<string, unknown>;
			expect(created.model_hint).toBeNull();
			expect(taskModelFor(db, created.id as string)).toBeNull();
		});

		it("GET list and detail include model_hint", async () => {
			const app = createWebhooksRoutes(db);
			await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "list-model-webhook", model_hint: "kimi-k2" }),
				}),
			);

			const listResp = await app.fetch(new Request("http://localhost/", { method: "GET" }));
			const listed = (await listResp.json()) as Array<Record<string, unknown>>;
			expect(listed[0]?.model_hint).toBe("kimi-k2");

			const id = listed[0]?.id as string;
			const detailResp = await app.fetch(new Request(`http://localhost/${id}`, { method: "GET" }));
			const detail = (await detailResp.json()) as Record<string, unknown>;
			expect(detail.model_hint).toBe("kimi-k2");
		});

		it("PATCH with model_hint sets it on the task", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "patch-model-webhook" }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ model_hint: "kimi-k2" }),
				}),
			);
			expect(patchResp.status).toBe(200);
			const patched = (await patchResp.json()) as Record<string, unknown>;
			expect(patched.model_hint).toBe("kimi-k2");
			expect(taskModelFor(db, id)).toBe("kimi-k2");
		});

		it("PATCH with model_hint=null clears it back to default", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "clear-model-webhook", model_hint: "kimi-k2" }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;
			expect(taskModelFor(db, id)).toBe("kimi-k2");

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ model_hint: null }),
				}),
			);
			expect(patchResp.status).toBe(200);
			const patched = (await patchResp.json()) as Record<string, unknown>;
			expect(patched.model_hint).toBeNull();
			expect(taskModelFor(db, id)).toBeNull();
		});

		it("PATCH without model_hint key leaves existing model_hint alone", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "leave-model-webhook", model_hint: "kimi-k2" }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ description: "unrelated change" }),
				}),
			);
			expect(patchResp.status).toBe(200);
			const patched = (await patchResp.json()) as Record<string, unknown>;
			expect(patched.model_hint).toBe("kimi-k2");
			expect(taskModelFor(db, id)).toBe("kimi-k2");
		});
	});

	// no_history round-trip: stored as INTEGER 0/1 on tasks, exposed as boolean
	// over the JSON API (#54).
	describe("no_history round-trip on tasks.no_history", () => {
		const taskNoHistoryFor = (db: Database, webhookId: string): number | null => {
			const wh = db.prepare("SELECT task_id FROM webhooks WHERE id = ?").get(webhookId) as {
				task_id: string;
			};
			const task = db.prepare("SELECT no_history FROM tasks WHERE id = ?").get(wh.task_id) as {
				no_history: number | null;
			};
			return task.no_history;
		};

		it("POST without no_history defaults to no_history=0 on the task", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "default-no-history" }),
				}),
			);
			expect(createResp.status).toBe(201);
			const created = (await createResp.json()) as Record<string, unknown>;
			expect(created.no_history).toBe(false);
			expect(taskNoHistoryFor(db, created.id as string)).toBe(0);
		});

		it("POST with no_history=true stores 1 on the task and returns true", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "no-history-true", no_history: true }),
				}),
			);
			expect(createResp.status).toBe(201);
			const created = (await createResp.json()) as Record<string, unknown>;
			expect(created.no_history).toBe(true);
			expect(taskNoHistoryFor(db, created.id as string)).toBe(1);
		});

		it("POST with no_history=false stores 0 explicitly", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "no-history-false", no_history: false }),
				}),
			);
			expect(createResp.status).toBe(201);
			const created = (await createResp.json()) as Record<string, unknown>;
			expect(created.no_history).toBe(false);
			expect(taskNoHistoryFor(db, created.id as string)).toBe(0);
		});

		it("GET list and detail include no_history as boolean", async () => {
			const app = createWebhooksRoutes(db);
			await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "listed-no-history", no_history: true }),
				}),
			);

			const listResp = await app.fetch(new Request("http://localhost/", { method: "GET" }));
			const listed = (await listResp.json()) as Array<Record<string, unknown>>;
			expect(listed[0]?.no_history).toBe(true);
			expect(typeof listed[0]?.no_history).toBe("boolean");

			const id = listed[0]?.id as string;
			const detailResp = await app.fetch(new Request(`http://localhost/${id}`, { method: "GET" }));
			const detail = (await detailResp.json()) as Record<string, unknown>;
			expect(detail.no_history).toBe(true);
		});

		it("PATCH with no_history=true sets it on the task", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "patch-no-history" }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ no_history: true }),
				}),
			);
			expect(patchResp.status).toBe(200);
			const patched = (await patchResp.json()) as Record<string, unknown>;
			expect(patched.no_history).toBe(true);
			expect(taskNoHistoryFor(db, id)).toBe(1);
		});

		it("PATCH with no_history=false clears it back to 0", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "clear-no-history", no_history: true }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;
			expect(taskNoHistoryFor(db, id)).toBe(1);

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ no_history: false }),
				}),
			);
			expect(patchResp.status).toBe(200);
			const patched = (await patchResp.json()) as Record<string, unknown>;
			expect(patched.no_history).toBe(false);
			expect(taskNoHistoryFor(db, id)).toBe(0);
		});

		it("PATCH without no_history key leaves existing no_history alone", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "leave-no-history", no_history: true }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ description: "unrelated" }),
				}),
			);
			expect(patchResp.status).toBe(200);
			const patched = (await patchResp.json()) as Record<string, unknown>;
			expect(patched.no_history).toBe(true);
			expect(taskNoHistoryFor(db, id)).toBe(1);
		});

		it("PATCH with non-boolean no_history returns 400", async () => {
			const app = createWebhooksRoutes(db);
			const createResp = await app.fetch(
				new Request("http://localhost/", {
					method: "POST",
					body: JSON.stringify({ name: "bad-no-history" }),
				}),
			);
			const created = (await createResp.json()) as Record<string, unknown>;
			const id = created.id as string;

			const patchResp = await app.fetch(
				new Request(`http://localhost/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ no_history: "yes" }),
				}),
			);
			expect(patchResp.status).toBe(400);
			const body = (await patchResp.json()) as Record<string, unknown>;
			expect(body.error).toContain("no_history");
			// Original value preserved on rejection.
			expect(taskNoHistoryFor(db, id)).toBe(0);
		});
	});

	describe("AC5.4: DELETE /api/webhooks/:id soft-deletes and cancels task", () => {
		it("soft-deletes webhook and cancels task", async () => {
			const app = createWebhooksRoutes(db);

			// Create a webhook
			const createBody = JSON.stringify({ name: "delete-test-webhook" });
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;

			// Get the task_id
			const webhook = db.prepare("SELECT task_id FROM webhooks WHERE id = ?").get(id) as {
				task_id: string;
			};

			// Delete webhook
			const deleteResponse = await app.fetch(
				new Request(`http://localhost/${id}`, { method: "DELETE" }),
			);

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
			const createResponse = await app.fetch(
				new Request("http://localhost/", { method: "POST", body: createBody }),
			);
			const created = (await createResponse.json()) as Record<string, unknown>;
			const id = created.id as string;
			const originalSecret = created.secret as string;

			// Rotate secret
			const rotateResponse = await app.fetch(
				new Request(`http://localhost/${id}/rotate`, { method: "POST" }),
			);

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
});
