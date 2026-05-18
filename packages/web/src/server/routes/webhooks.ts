import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { SignatureFormat } from "@bound/shared";
import { Hono } from "hono";

export function createWebhooksRoutes(db: Database): Hono {
	const app = new Hono();

	function resolveSiteId(): string {
		return getSiteId(db);
	}

	// GET / — List webhooks (AC5.2)
	app.get("/", (c) => {
		try {
			const webhooks = db
				.prepare(
					"SELECT id, name, signature_format, description, task_id, thread_id, created_at, modified_at FROM webhooks WHERE deleted = 0 ORDER BY created_at DESC",
				)
				.all() as Array<{
				id: string;
				name: string;
				signature_format: string;
				description: string | null;
				task_id: string;
				thread_id: string;
				created_at: string;
				modified_at: string;
			}>;

			return c.json(webhooks);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list webhooks",
					details: message,
				},
				500,
			);
		}
	});

	// GET /:id — Get single webhook (AC5.6)
	app.get("/:id", (c) => {
		try {
			const id = c.req.param("id");

			const webhook = db
				.prepare(
					"SELECT id, name, signature_format, description, task_id, thread_id, created_at, modified_at FROM webhooks WHERE id = ? AND deleted = 0",
				)
				.get(id) as Record<string, unknown> | null;

			if (!webhook) {
				return c.json({ error: "Webhook not found" }, 404);
			}

			return c.json(webhook);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get webhook",
					details: message,
				},
				500,
			);
		}
	});

	// POST / — Create webhook (AC5.1)
	app.post("/", async (c) => {
		try {
			const body = (await c.req.json()) as Record<string, unknown>;
			const siteId = resolveSiteId();

			const name = body.name as string | undefined;
			const format = (body.format || "github") as SignatureFormat;
			const description = body.description as string | undefined;
			const prompt = body.prompt as string | undefined;

			// Validate name: /^[a-z0-9][a-z0-9_-]{0,63}$/
			if (!name) {
				return c.json({ error: "name is required" }, 400);
			}

			const nameRegex = /^[a-z0-9][a-z0-9_-]{0,63}$/;
			if (!nameRegex.test(name)) {
				return c.json(
					{
						error:
							"Invalid webhook name. Must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase, digits, underscores, dashes, 2-64 chars)",
					},
					400,
				);
			}

			// Check for existing non-deleted webhook
			const existing = db
				.prepare("SELECT id FROM webhooks WHERE name = ? AND deleted = 0")
				.get(name) as { id: string } | null;

			if (existing) {
				return c.json({ error: `Webhook '${name}' already exists` }, 400);
			}

			// Generate 256-bit secret (64 hex chars)
			const secret = randomBytes(32).toString("hex");
			const now = new Date().toISOString();

			// Create thread for webhook message delivery
			const threadId = randomUUID();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "system",
					interface: "webhook",
					host_origin: siteId,
					color: 0,
					title: `Webhook: ${name}`,
					summary: null,
					summary_through: null,
					summary_model_id: null,
					extracted_through: null,
					model_hint: null,
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Create event task
			const taskId = randomUUID();
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `webhook:${name}`,
					payload: null,
					created_at: now,
					created_by: siteId,
					thread_id: threadId,
					origin_thread_id: null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: null,
					last_run_at: null,
					run_count: 0,
					max_runs: null,
					requires: null,
					model_hint: null,
					no_history: 0,
					inject_mode: "results",
					depends_on: null,
					require_success: 0,
					alert_threshold: 3,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					system_prompt_addition: prompt || null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Create webhook row
			const webhookId = deterministicUUID(BOUND_NAMESPACE, `webhook:${name}`);
			insertRow(
				db,
				"webhooks",
				{
					id: webhookId,
					name,
					secret,
					signature_format: format,
					description: description || null,
					task_id: taskId,
					thread_id: threadId,
					created_at: now,
					deleted: 0,
					modified_at: now,
				},
				siteId,
			);

			// Return full webhook object INCLUDING secret
			return c.json(
				{
					id: webhookId,
					name,
					secret,
					signature_format: format,
					description: description || null,
					task_id: taskId,
					thread_id: threadId,
					created_at: now,
					modified_at: now,
				},
				201,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to create webhook",
					details: message,
				},
				500,
			);
		}
	});

	// PATCH /:id — Update webhook (AC5.3, AC5.7)
	app.patch("/:id", async (c) => {
		try {
			const id = c.req.param("id");
			const body = (await c.req.json()) as Record<string, unknown>;
			const siteId = resolveSiteId();

			// Look up webhook by id
			const webhook = db
				.prepare("SELECT id, task_id FROM webhooks WHERE id = ? AND deleted = 0")
				.get(id) as { id: string; task_id: string } | null;

			if (!webhook) {
				return c.json({ error: "Webhook not found" }, 404);
			}

			const description = body.description as string | undefined;
			const prompt = body.prompt as string | undefined;
			const format = body.format as SignatureFormat | undefined;

			// Update task system_prompt_addition if prompt provided
			if (prompt !== undefined) {
				updateRow(
					db,
					"tasks",
					webhook.task_id,
					{
						system_prompt_addition: prompt || null,
						modified_at: new Date().toISOString(),
					},
					siteId,
				);
			}

			// Update webhook row with description or format
			if (description !== undefined || format !== undefined) {
				const updateData: Record<string, unknown> = {
					modified_at: new Date().toISOString(),
				};
				if (description !== undefined) {
					updateData.description = description || null;
				}
				if (format !== undefined) {
					updateData.signature_format = format;
				}

				updateRow(db, "webhooks", id, updateData, siteId);
			}

			// Fetch and return updated webhook (without secret)
			const updated = db
				.prepare(
					"SELECT id, name, signature_format, description, task_id, thread_id, created_at, modified_at FROM webhooks WHERE id = ?",
				)
				.get(id) as Record<string, unknown>;

			return c.json(updated);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to update webhook",
					details: message,
				},
				500,
			);
		}
	});

	// DELETE /:id — Soft-delete webhook (AC5.4)
	app.delete("/:id", (c) => {
		try {
			const id = c.req.param("id");
			const siteId = resolveSiteId();

			// Look up webhook
			const webhook = db
				.prepare("SELECT task_id FROM webhooks WHERE id = ? AND deleted = 0")
				.get(id) as { task_id: string } | null;

			if (!webhook) {
				return c.json({ error: "Webhook not found" }, 404);
			}

			// Soft-delete webhook
			softDelete(db, "webhooks", id, siteId);

			// Cancel associated task
			updateRow(
				db,
				"tasks",
				webhook.task_id,
				{ status: "cancelled", modified_at: new Date().toISOString() },
				siteId,
			);

			return new Response(null, { status: 204 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to delete webhook",
					details: message,
				},
				500,
			);
		}
	});

	// POST /:id/rotate — Rotate secret (AC5.5)
	app.post("/:id/rotate", (c) => {
		try {
			const id = c.req.param("id");
			const siteId = resolveSiteId();

			// Look up webhook
			const webhook = db
				.prepare("SELECT id FROM webhooks WHERE id = ? AND deleted = 0")
				.get(id) as { id: string } | null;

			if (!webhook) {
				return c.json({ error: "Webhook not found" }, 404);
			}

			// Generate new secret
			const newSecret = randomBytes(32).toString("hex");

			// Update webhook
			updateRow(
				db,
				"webhooks",
				id,
				{ secret: newSecret, modified_at: new Date().toISOString() },
				siteId,
			);

			// Return only the new secret
			return c.json({ secret: newSecret });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to rotate secret",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
