import {
	countThreadsDirectory,
	findLatestThreadColorExcludingInterfaces,
	findLiveThreadById,
	findRunningTaskIdForThread,
	findThreadById,
	getAttachedSessionHosts,
	getSiteId,
	insertRow,
	listContextDebugTurnsByThread,
	listThreadsDirectory,
} from "@bound/core";

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { StatusForwardPayload, Thread } from "@bound/shared";
import { NON_USER_FACING_INTERFACES, createLogger } from "@bound/shared";
import { Hono } from "hono";

const logger = createLogger("@bound/web", "threads-routes");

function getAttachedSessionHostLabels(db: Database, threadId: string): string[] {
	return getAttachedSessionHosts(db, threadId)
		.map((row) => row.label)
		.filter((label): label is string => typeof label === "string");
}

export function createThreadsRoutes(
	db: Database,
	operatorUserId: string,
	defaultModel?: string,
	statusForwardCache?: Map<string, StatusForwardPayload>,
	activeLoops?: Set<string>,
): Hono {
	const app = new Hono();
	const webUserId = operatorUserId;

	app.get("/", (c) => {
		try {
			// Directory hides threads with no user messages by default to reduce
			// clutter from task-only / system-only threads. Opt in to the full
			// list with ?include_empty=true.
			const includeEmpty = c.req.query("include_empty") === "true";

			// Optional cursor-based pagination on (last_message_at, id). Both
			// `before_ts` and `before_id` must be present together; an
			// incomplete cursor is treated as "no cursor" rather than rejected
			// so that hand-edited URLs degrade gracefully. Pagination is
			// opt-in: with no `limit` given the route returns the full set,
			// preserving the original contract for callers that don't yet
			// page.
			const beforeTsRaw = c.req.query("before_ts");
			const beforeIdRaw = c.req.query("before_id");
			const hasCursor = !!beforeTsRaw && !!beforeIdRaw;
			const beforeTs = hasCursor ? beforeTsRaw : null;
			const beforeId = hasCursor ? beforeIdRaw : null;

			let limit: number | null = null;
			const limitRaw = c.req.query("limit");
			if (limitRaw !== undefined) {
				const parsed = Number.parseInt(limitRaw, 10);
				// Cap at 200 to keep a single page bounded — well above the
				// typical UI page size of 50, large enough for ad-hoc tools
				// to fetch a chunk without paging.
				if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
					return c.json(
						{
							error: "Invalid limit",
							details: "limit must be a positive integer between 1 and 200",
						},
						400,
					);
				}
				limit = parsed;
			}

			const threads = listThreadsDirectory(db, {
				userId: webUserId,
				includeEmpty,
				beforeTs,
				beforeId,
				limit,
			});

			// Decorate each thread with `active` using the same logic as the
			// per-thread /status endpoint: local loop, running task, or a
			// non-idle forwarded status. This lets the client render accurate
			// "Live" indicators without fanning out one HTTP request per thread.
			const enriched = threads.map((t) => {
				const forwarded = statusForwardCache?.get(t.id);
				const localLoopActive = activeLoops?.has(t.id) ?? false;
				const active =
					localLoopActive ||
					!!t.hasRunningTask ||
					forwarded?.status === "thinking" ||
					forwarded?.status === "tool_call";
				const { hasRunningTask: _, attachedSessionHostsJson, ...rest } = t;
				let attachedSessionHosts: string[] = [];
				try {
					const parsed = JSON.parse(attachedSessionHostsJson ?? "[]");
					if (Array.isArray(parsed)) {
						attachedSessionHosts = parsed.filter(
							(host): host is string => typeof host === "string",
						);
					}
				} catch {
					attachedSessionHosts = [];
				}
				return { ...rest, attachedSessionHosts, active };
			});

			// Total count of threads matching the same filter, independent of
			// the cursor/limit window, exposed via X-Total-Count so the UI can
			// render an accurate "N threads" total even while paginating. The
			// JSON body stays a bare array, preserving the existing contract.
			const totalRow = countThreadsDirectory(db, {
				userId: webUserId,
				includeEmpty,
			});
			c.header("X-Total-Count", String(totalRow?.total ?? enriched.length));

			return c.json(enriched);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list threads",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/", async (c) => {
		try {
			// Parse optional body; callers may omit it or send `{}`. The only
			// recognized field today is `interface`, which lets non-web
			// clients (notably `boundless`) self-identify so the agent can
			// inject the right platform context. Values must be a simple
			// alphanumeric/dash token — the column feeds directly into the
			// agent's volatile context and server-side routing checks.
			let interfaceTag = "web";
			let rawBody: unknown = null;
			try {
				rawBody = await c.req.json();
			} catch {
				// No body or non-JSON body — use defaults.
			}
			if (rawBody && typeof rawBody === "object" && "interface" in rawBody) {
				const candidate = (rawBody as Record<string, unknown>).interface;
				if (typeof candidate === "string") {
					if (!/^[a-z0-9-]+$/i.test(candidate) || candidate.length > 32) {
						return c.json(
							{
								error: "Invalid interface value",
								details: "interface must match /^[a-z0-9-]+$/i and be <= 32 chars",
							},
							400,
						);
					}
					interfaceTag = candidate;
				}
			}

			const threadId = randomUUID();
			const now = new Date().toISOString();

			logger.info("Creating thread", { threadId, interfaceTag });

			const siteId = getSiteId(db);

			// Assign next palette color by cycling (0-9) per spec R-U18.
			// Pick up from the last *user-facing* thread's color so colors always
			// advance. Excluding system-driven threads (scheduler, mcp, webhook)
			// from the lookup prevents the user-visible cycle from being pinned
			// to a single color by bursts of system thread creates that all
			// hardcode color: 0.
			const lastThread = findLatestThreadColorExcludingInterfaces(db, NON_USER_FACING_INTERFACES);
			const nextColor = lastThread !== null ? (lastThread.color + 1) % 10 : 0;

			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: webUserId,
					interface: interfaceTag,
					host_origin: "localhost:3000",
					color: nextColor,
					title: "",
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

			const thread = findThreadById(db, threadId) as Thread;

			return c.json(thread, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to create thread",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/:id", (c) => {
		try {
			const { id } = c.req.param();
			const thread = findLiveThreadById(db, id);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			return c.json({
				...thread,
				attachedSessionHosts: getAttachedSessionHostLabels(db, id),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get thread",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/:id/status", (c) => {
		try {
			const { id } = c.req.param();

			const thread = findLiveThreadById(db, id);

			if (!thread) {
				return c.json(
					{
						error: "Thread not found",
					},
					404,
				);
			}

			// Check for forwarded status (delegated loops)
			const forwarded = statusForwardCache?.get(id);

			const runningTask = findRunningTaskIdForThread(db, id);

			const localLoopActive = activeLoops?.has(id) ?? false;
			const isActive =
				localLoopActive ||
				!!runningTask ||
				forwarded?.status === "thinking" ||
				forwarded?.status === "tool_call";

			return c.json({
				active: isActive,
				state: forwarded?.status ?? (localLoopActive || runningTask ? "thinking" : null),
				detail: forwarded?.detail ?? null,
				tokens: forwarded?.tokens ?? 0,
				model: defaultModel ?? null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get thread status",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/:id/context-debug", (c) => {
		try {
			const { id } = c.req.param();

			const rows = listContextDebugTurnsByThread(db, id);

			const result = rows
				.map((row) => {
					try {
						return {
							turn_id: row.id,
							model_id: row.model_id,
							tokens_in: row.tokens_in,
							tokens_out: row.tokens_out,
							tokens_cache_read: row.tokens_cache_read,
							tokens_cache_write: row.tokens_cache_write,
							context_debug: JSON.parse(row.context_debug ?? ""),
							created_at: row.created_at,
						};
					} catch {
						// Skip turns with malformed context_debug JSON
						return null;
					}
				})
				.filter((r) => r !== null);

			return c.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get context debug data",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
