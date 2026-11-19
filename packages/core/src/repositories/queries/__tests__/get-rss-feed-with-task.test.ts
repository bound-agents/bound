import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RssFeed, Task } from "@bound/shared";
import { createCoreTestDb } from "../../../__tests__/test-database";
import { insertRow, softDelete } from "../../../index";
import {
	type RssFeedWithTaskRow,
	getRssFeedWithTaskById,
	listRssFeedsWithTask,
} from "../get-rss-feed-with-task";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function seedTask(db: Database, overrides: Partial<Task> & { id: string }): void {
	const base: Task = {
		id: overrides.id,
		type: "event",
		status: "pending",
		trigger_spec: "rss",
		payload: null,
		thread_id: null,
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
		system_prompt_addition: null,
		heartbeat_at: null,
		result: null,
		error: null,
		created_at: TS,
		created_by: null,
		modified_at: TS,
		deleted: 0,
		...overrides,
	};
	insertRow(db, "tasks", base, SITE_ID);
}

function seedFeed(db: Database, overrides: Partial<RssFeed> & { id: string; name: string }): void {
	const base: RssFeed = {
		id: overrides.id,
		name: overrides.name,
		url: "https://example.com/feed.xml",
		description: null,
		poll_interval_seconds: 300,
		seen_guids: null,
		task_id: "task-default",
		thread_id: "thread-default",
		created_at: TS,
		deleted: 0,
		modified_at: TS,
		...overrides,
	};
	insertRow(db, "rss_feeds", base, SITE_ID);
}

describe("get-rss-feed-with-task finders", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	describe("getRssFeedWithTaskById", () => {
		it("projects the exact column set with task fields surfaced; seen_guids omitted", () => {
			seedTask(db, {
				id: "task-1",
				model_hint: "opus",
				no_history: 1,
				system_prompt_addition: "be terse",
			});
			seedFeed(db, {
				id: "feed-1",
				name: "blog",
				url: "https://blog.example/rss",
				description: "a blog",
				poll_interval_seconds: 600,
				seen_guids: '["a","b"]',
				task_id: "task-1",
				thread_id: "thread-1",
				created_at: "2026-02-02T00:00:00.000Z",
				modified_at: "2026-02-02T00:00:00.000Z",
			});

			const row = getRssFeedWithTaskById(db, "feed-1");
			expect(row).toEqual({
				id: "feed-1",
				name: "blog",
				url: "https://blog.example/rss",
				description: "a blog",
				poll_interval_seconds: 600,
				task_id: "task-1",
				thread_id: "thread-1",
				created_at: "2026-02-02T00:00:00.000Z",
				modified_at: "2026-02-02T00:00:00.000Z",
				prompt: "be terse",
				model_hint: "opus",
				no_history: 1,
			});
			// seen_guids is poller-internal, must not be projected.
			expect(Object.keys(row as object)).not.toContain("seen_guids");
		});

		it("returns null for an absent id", () => {
			expect(getRssFeedWithTaskById(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted feed (r.deleted=0 filter)", () => {
			seedTask(db, { id: "task-1" });
			seedFeed(db, { id: "feed-1", name: "blog", task_id: "task-1" });
			softDelete(db, "rss_feeds", "feed-1", SITE_ID);
			expect(getRssFeedWithTaskById(db, "feed-1")).toBeNull();
		});

		it("LEFT JOIN null case: missing task yields null prompt/model_hint and no_history=0", () => {
			seedFeed(db, { id: "feed-orphan", name: "orphan", task_id: "ghost" });
			const row = getRssFeedWithTaskById(db, "feed-orphan") as RssFeedWithTaskRow;
			expect(row.prompt).toBeNull();
			expect(row.model_hint).toBeNull();
			expect(row.no_history).toBe(0);
			expect(row.id).toBe("feed-orphan");
		});

		it("excludes a soft-deleted task from the join (t.deleted=0)", () => {
			seedTask(db, { id: "task-dead", model_hint: "sonnet", no_history: 1 });
			softDelete(db, "tasks", "task-dead", SITE_ID);
			seedFeed(db, { id: "feed-2", name: "stale", task_id: "task-dead" });
			const row = getRssFeedWithTaskById(db, "feed-2") as RssFeedWithTaskRow;
			expect(row.prompt).toBeNull();
			expect(row.model_hint).toBeNull();
			expect(row.no_history).toBe(0);
		});
	});

	describe("listRssFeedsWithTask", () => {
		it("returns [] when there are no feeds", () => {
			expect(listRssFeedsWithTask(db)).toEqual([]);
		});

		it("orders by created_at DESC and excludes soft-deleted feeds", () => {
			seedTask(db, { id: "task-a", model_hint: "opus" });
			seedFeed(db, {
				id: "feed-old",
				name: "old",
				task_id: "task-a",
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
			});
			seedFeed(db, {
				id: "feed-new",
				name: "new",
				task_id: "task-a",
				created_at: "2026-05-05T00:00:00.000Z",
				modified_at: "2026-05-05T00:00:00.000Z",
			});
			seedFeed(db, {
				id: "feed-gone",
				name: "gone",
				task_id: "task-a",
				created_at: "2026-04-04T00:00:00.000Z",
				modified_at: "2026-04-04T00:00:00.000Z",
			});
			softDelete(db, "rss_feeds", "feed-gone", SITE_ID);

			const rows = listRssFeedsWithTask(db);
			expect(rows.map((r) => r.id)).toEqual(["feed-new", "feed-old"]);
			expect(rows.every((r) => r.model_hint === "opus")).toBe(true);
		});
	});
});
