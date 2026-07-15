import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	findRssFeedDeletedFlagById,
	findRssFeedIdByName,
	findRssFeedIdsById,
	findRssFeedTaskIdById,
	getRssFeedWithTaskById,
	getSiteId,
	insertRow,
	listRssFeedsWithTask,
	softDelete,
	updateRow,
} from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { Hono } from "hono";

/**
 * REST surface for RSS feed bindings — the pull-side sibling of
 * ./webhooks.ts. A feed create provisions the same three-row consist as a
 * webhook (delivery thread + event task + binding row, deterministic id from
 * the name), so the scheduler-side delivery track is shared; what differs is
 * only that items arrive by the leader-gated poller instead of an HTTP POST,
 * which means: no secret, no signature format, no URL enumeration, no
 * unauthenticated switch — and an extra `url` + `poll_interval_seconds`.
 */

const MIN_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 900;

export function createRssFeedsRoutes(db: Database): Hono {
	const app = new Hono();

	function resolveSiteId(): string {
		return getSiteId(db);
	}

	// Coerce raw row → response shape: integer no_history becomes boolean.
	function shapeFeed(
		row: Record<string, unknown> | null | undefined,
	): Record<string, unknown> | null {
		if (!row) return null;
		const { no_history, ...rest } = row;
		return { ...rest, no_history: no_history === 1 };
	}

	/**
	 * Validate a feed URL: http/https only. Anything else (file:, gopher:,
	 * unparseable) is rejected — the poller fetches this server-side, so URL
	 * discipline here is what keeps a feed row from becoming an SSRF vector
	 * into schemes fetch would happily follow.
	 */
	function validateFeedUrl(url: unknown): string | null {
		if (typeof url !== "string" || url.length === 0) return null;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
			return url;
		} catch {
			return null;
		}
	}

	function validatePollInterval(value: unknown): number | null {
		if (typeof value !== "number" || !Number.isInteger(value)) return null;
		if (value < MIN_POLL_INTERVAL_SECONDS) return null;
		return value;
	}

	// GET / — List feeds
	app.get("/", (c) => {
		try {
			const rows = listRssFeedsWithTask(db) as unknown as Array<Record<string, unknown>>;
			return c.json(rows.map((r) => shapeFeed(r)));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to list RSS feeds", details: message }, 500);
		}
	});

	// GET /:id — Single feed
	app.get("/:id", (c) => {
		try {
			const id = c.req.param("id");
			const feed = getRssFeedWithTaskById(db, id) as Record<string, unknown> | null;
			if (!feed) {
				return c.json({ error: "RSS feed not found" }, 404);
			}
			return c.json(shapeFeed(feed));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to get RSS feed", details: message }, 500);
		}
	});

	// POST / — Create feed (thread + event task + feed row)
	app.post("/", async (c) => {
		try {
			const body = (await c.req.json()) as Record<string, unknown>;
			const siteId = resolveSiteId();

			const name = body.name as string | undefined;
			const description = body.description as string | undefined;
			const prompt = body.prompt as string | undefined;
			const rawModelHint = body.model_hint;
			const modelHint =
				typeof rawModelHint === "string" && rawModelHint.length > 0 ? rawModelHint : null;
			const noHistory = body.no_history === true ? 1 : 0;

			if (!name) {
				return c.json({ error: "name is required" }, 400);
			}
			// Same identifier grammar as webhooks — the name is a routing key
			// (trigger_spec `rss:<name>`, idempotency prefix), not display text.
			const nameRegex = /^[a-z0-9][a-z0-9_-]{0,63}$/;
			if (!nameRegex.test(name)) {
				return c.json(
					{
						error:
							"Invalid feed name. Must match /^[a-z0-9][a-z0-9_-]{0,63}$/ (lowercase, digits, underscores, dashes, 1-64 chars)",
					},
					400,
				);
			}

			const url = validateFeedUrl(body.url);
			if (!url) {
				return c.json({ error: "url is required and must be a valid http(s) URL" }, 400);
			}

			let pollInterval = DEFAULT_POLL_INTERVAL_SECONDS;
			if (body.poll_interval_seconds !== undefined) {
				const validated = validatePollInterval(body.poll_interval_seconds);
				if (validated === null) {
					return c.json(
						{
							error: `poll_interval_seconds must be an integer >= ${MIN_POLL_INTERVAL_SECONDS}`,
						},
						400,
					);
				}
				pollInterval = validated;
			}

			const existing = findRssFeedIdByName(db, name);
			if (existing) {
				return c.json({ error: `RSS feed '${name}' already exists` }, 400);
			}

			const now = new Date().toISOString();

			// Delivery thread — same shape as webhook threads; "rss" is a
			// non-user-facing interface like "webhook".
			const threadId = randomUUID();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "system",
					interface: "rss",
					host_origin: siteId,
					color: 0,
					title: `RSS: ${name}`,
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

			// Event task — woken by the poller's connector:event (trigger_key
			// `rss:<name>`), folds rss_intake rows via buildEventWakeupContent.
			const taskId = randomUUID();
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					status: "pending",
					trigger_spec: `rss:${name}`,
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

			// Feed row. Deterministic id from the name so concurrent creates on
			// different hosts converge (LWW); a previously soft-deleted row is
			// restored in place so the deterministic-id property holds.
			const feedId = deterministicUUID(BOUND_NAMESPACE, `rss:${name}`);
			const priorRow = findRssFeedDeletedFlagById(db, feedId);

			const rowData = {
				name,
				url,
				description: description || null,
				poll_interval_seconds: pollInterval,
				// Fresh cursor: null means "first poll seeds without delivering",
				// so creating a feed doesn't dump its entire backlog as events.
				seen_guids: null,
				task_id: taskId,
				thread_id: threadId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			};

			if (priorRow) {
				updateRow(db, "rss_feeds", feedId, rowData, siteId);
			} else {
				insertRow(db, "rss_feeds", { id: feedId, ...rowData }, siteId);
			}

			const fresh = getRssFeedWithTaskById(db, feedId) as Record<string, unknown> | null;
			return c.json(shapeFeed(fresh) ?? {}, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to create RSS feed", details: message }, 500);
		}
	});

	// PATCH /:id — Update feed (url, description, poll interval, prompt, model, history)
	app.patch("/:id", async (c) => {
		try {
			const id = c.req.param("id");
			const body = (await c.req.json()) as Record<string, unknown>;
			const siteId = resolveSiteId();

			const feed = findRssFeedIdsById(db, id);
			if (!feed) {
				return c.json({ error: "RSS feed not found" }, 404);
			}

			const description = body.description as string | undefined;
			const prompt = body.prompt as string | undefined;
			// model_hint three-state: absent → leave; null/"" → clear; string → set.
			const modelHintProvided = "model_hint" in body;
			const rawModelHint = body.model_hint;
			const modelHintValue =
				typeof rawModelHint === "string" && rawModelHint.length > 0 ? rawModelHint : null;
			// no_history two-state on PATCH: absent → leave; boolean → set.
			const noHistoryProvided = "no_history" in body;
			let noHistoryValue: 0 | 1 = 0;
			if (noHistoryProvided) {
				if (typeof body.no_history !== "boolean") {
					return c.json({ error: "no_history must be a boolean" }, 400);
				}
				noHistoryValue = body.no_history ? 1 : 0;
			}

			let url: string | undefined;
			if ("url" in body) {
				const validated = validateFeedUrl(body.url);
				if (!validated) {
					return c.json({ error: "url must be a valid http(s) URL" }, 400);
				}
				url = validated;
			}

			let pollInterval: number | undefined;
			if ("poll_interval_seconds" in body) {
				const validated = validatePollInterval(body.poll_interval_seconds);
				if (validated === null) {
					return c.json(
						{
							error: `poll_interval_seconds must be an integer >= ${MIN_POLL_INTERVAL_SECONDS}`,
						},
						400,
					);
				}
				pollInterval = validated;
			}

			if (prompt !== undefined) {
				updateRow(db, "tasks", feed.task_id, { system_prompt_addition: prompt || null }, siteId);
			}

			if (modelHintProvided) {
				updateRow(db, "tasks", feed.task_id, { model_hint: modelHintValue }, siteId);
				// Mirror onto the delivery thread (matches webhook PATCH semantics).
				updateRow(db, "threads", feed.thread_id, { model_hint: modelHintValue }, siteId);
			}

			if (noHistoryProvided) {
				updateRow(db, "tasks", feed.task_id, { no_history: noHistoryValue }, siteId);
			}

			const updateData: Record<string, unknown> = {};
			if (description !== undefined) updateData.description = description || null;
			if (url !== undefined) {
				updateData.url = url;
				// A new URL is a new stream — reset the dedup cursor so the next
				// poll seeds from the new feed's current contents (deliver-nothing
				// first poll) instead of treating every item as fresh.
				updateData.seen_guids = null;
			}
			if (pollInterval !== undefined) updateData.poll_interval_seconds = pollInterval;
			if (Object.keys(updateData).length > 0) {
				updateRow(db, "rss_feeds", id, updateData, siteId);
			}

			const updated = getRssFeedWithTaskById(db, id) as Record<string, unknown> | null;
			return c.json(shapeFeed(updated));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to update RSS feed", details: message }, 500);
		}
	});

	// DELETE /:id — Soft-delete feed and cancel its event task
	app.delete("/:id", (c) => {
		try {
			const id = c.req.param("id");
			const siteId = resolveSiteId();

			const feed = findRssFeedTaskIdById(db, id);
			if (!feed) {
				return c.json({ error: "RSS feed not found" }, 404);
			}

			softDelete(db, "rss_feeds", id, siteId);
			updateRow(db, "tasks", feed.task_id, { status: "cancelled" }, siteId);

			return new Response(null, { status: 204 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to delete RSS feed", details: message }, 500);
		}
	});

	return app;
}
