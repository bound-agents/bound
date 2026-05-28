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

	// SELECT projection used by list/detail/patch responses. The webhook's
	// custom prompt and model_hint live on the linked event task, so we
	// LEFT JOIN tasks and surface them as `prompt` / `model_hint` for the UI/client.
	// `no_history` is stored as INTEGER (0/1) on the task row; we coerce to a
	// boolean here so the JSON shape matches what callers expect ergonomically
	// (and what UpdateWebhookOptions accepts on PATCH).
	const WEBHOOK_SELECT = `SELECT
			w.id,
			w.name,
			w.signature_format,
			w.description,
			w.task_id,
			w.thread_id,
			w.created_at,
			w.modified_at,
			t.system_prompt_addition AS prompt,
			t.model_hint AS model_hint,
			CASE WHEN t.no_history = 1 THEN 1 ELSE 0 END AS no_history
		FROM webhooks w
		LEFT JOIN tasks t ON t.id = w.task_id AND t.deleted = 0`;

	// Coerce raw row → response shape: integer no_history becomes boolean.
	function shapeWebhook(
		row: Record<string, unknown> | null | undefined,
	): Record<string, unknown> | null {
		if (!row) return null;
		const { no_history, ...rest } = row;
		return { ...rest, no_history: no_history === 1 };
	}

	// GET / — List webhooks (AC5.2)
	app.get("/", (c) => {
		try {
			const rows = db
				.prepare(`${WEBHOOK_SELECT} WHERE w.deleted = 0 ORDER BY w.created_at DESC`)
				.all() as Array<Record<string, unknown>>;

			return c.json(rows.map((r) => shapeWebhook(r)));
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
				.prepare(`${WEBHOOK_SELECT} WHERE w.id = ? AND w.deleted = 0`)
				.get(id) as Record<string, unknown> | null;

			if (!webhook) {
				return c.json({ error: "Webhook not found" }, 404);
			}

			return c.json(shapeWebhook(webhook));
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
			// model_hint: missing/null/empty all mean "use system default"
			const rawModelHint = body.model_hint;
			const modelHint =
				typeof rawModelHint === "string" && rawModelHint.length > 0 ? rawModelHint : null;
			// no_history: missing or non-boolean → false (default). Boolean values
			// are stored as 0/1 on the task row; the response coerces back to bool.
			const noHistory = body.no_history === true ? 1 : 0;

			// Validate name: /^[a-z0-9][a-z0-9_-]{0,63}$/
			if (!name) {
				return c.json({ error: "name is required" }, 400);
			}

			const nameRegex = /^[a-z0-9][a-z0-9_-]{0,63}$/;
			if (!nameRegex.test(name)) {
				return c.json(
					{
						error:
							"Invalid webhook name. Must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase, digits, underscores, dashes, 1-64 chars)",
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
					model_hint: modelHint,
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
					model_hint: modelHint,
					no_history: noHistory,
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

			// Create webhook row. The webhook id is derived deterministically
			// from the name so concurrent creates on different hosts converge
			// on the same row (LWW handles divergence). When the same name has
			// previously been used and soft-deleted, that row is still present
			// with deleted=1 — insert would fail on the PK. Restore it in
			// place via updateRow so the deterministic-id property holds.
			const webhookId = deterministicUUID(BOUND_NAMESPACE, `webhook:${name}`);
			const priorRow = db.prepare("SELECT deleted FROM webhooks WHERE id = ?").get(webhookId) as {
				deleted: number;
			} | null;

			if (priorRow) {
				// Existing row must be soft-deleted at this point — the active
				// uniqueness check above would have short-circuited otherwise.
				updateRow(
					db,
					"webhooks",
					webhookId,
					{
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
			} else {
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
			}

			// Return full webhook object INCLUDING secret. Re-SELECT through
			// WEBHOOK_SELECT so the response shape (prompt, model_hint, etc.)
			// matches GET/PATCH and the client can avoid a follow-up fetch.
			const fresh = db.prepare(`${WEBHOOK_SELECT} WHERE w.id = ?`).get(webhookId) as
				| Record<string, unknown>
				| undefined;
			const shaped = shapeWebhook(fresh) ?? {};
			return c.json({ ...shaped, secret }, 201);
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
				.prepare("SELECT id, task_id, thread_id FROM webhooks WHERE id = ? AND deleted = 0")
				.get(id) as { id: string; task_id: string; thread_id: string } | null;

			if (!webhook) {
				return c.json({ error: "Webhook not found" }, 404);
			}

			const description = body.description as string | undefined;
			const prompt = body.prompt as string | undefined;
			const format = body.format as SignatureFormat | undefined;
			// model_hint three-state:
			//   key absent          → leave alone
			//   null / ""           → clear back to system default
			//   non-empty string    → set
			const modelHintProvided = "model_hint" in body;
			const rawModelHint = body.model_hint;
			const modelHintValue =
				typeof rawModelHint === "string" && rawModelHint.length > 0 ? rawModelHint : null;
			// no_history is two-state on PATCH:
			//   key absent → leave alone
			//   boolean    → set 0/1
			// Non-boolean values are rejected with 400 to avoid ambiguity.
			const noHistoryProvided = "no_history" in body;
			let noHistoryValue: 0 | 1 = 0;
			if (noHistoryProvided) {
				if (typeof body.no_history !== "boolean") {
					return c.json({ error: "no_history must be a boolean" }, 400);
				}
				noHistoryValue = body.no_history ? 1 : 0;
			}

			// Update task system_prompt_addition if prompt provided
			if (prompt !== undefined) {
				updateRow(
					db,
					"tasks",
					webhook.task_id,
					{
						system_prompt_addition: prompt || null,
					},
					siteId,
				);
			}

			// Update task model_hint if provided
			if (modelHintProvided) {
				updateRow(
					db,
					"tasks",
					webhook.task_id,
					{
						model_hint: modelHintValue,
					},
					siteId,
				);
				// Mirror onto the delivery thread (matches CLI + create semantics)
				updateRow(
					db,
					"threads",
					webhook.thread_id,
					{
						model_hint: modelHintValue,
					},
					siteId,
				);
			}

			// Update task no_history if provided. The flag is read by the
			// relay-processor at delivery time, so a PATCH takes effect on the
			// next webhook fire without needing to recreate the task.
			if (noHistoryProvided) {
				updateRow(
					db,
					"tasks",
					webhook.task_id,
					{
						no_history: noHistoryValue,
					},
					siteId,
				);
			}

			// Update webhook row with description or format
			if (description !== undefined || format !== undefined) {
				const updateData: Record<string, unknown> = {};
				if (description !== undefined) {
					updateData.description = description || null;
				}
				if (format !== undefined) {
					updateData.signature_format = format;
				}

				updateRow(db, "webhooks", id, updateData, siteId);
			}

			// Fetch and return updated webhook (without secret, with prompt)
			const updated = db.prepare(`${WEBHOOK_SELECT} WHERE w.id = ?`).get(id) as Record<
				string,
				unknown
			>;

			return c.json(shapeWebhook(updated));
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
			updateRow(db, "tasks", webhook.task_id, { status: "cancelled" }, siteId);

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
			updateRow(db, "webhooks", id, { secret: newSecret }, siteId);

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
