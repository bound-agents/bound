import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RssFeed } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	findActiveRssFeedByThreadId,
	findRssFeedByName,
	findRssFeedDeletedFlagById,
	findRssFeedIdByName,
	findRssFeedIdsById,
	findRssFeedTaskIdById,
	listActiveRssFeeds,
} from "../rss-feeds";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function seedFeed(db: Database, overrides: Partial<RssFeed> & { id: string; name: string }): void {
	const base: RssFeed = {
		id: overrides.id,
		name: overrides.name,
		url: overrides.url ?? "https://example.com/feed.xml",
		description: null,
		poll_interval_seconds: 300,
		seen_guids: null,
		task_id: overrides.task_id ?? "task-default",
		thread_id: overrides.thread_id ?? "thread-default",
		created_at: TS,
		deleted: 0,
		modified_at: TS,
		...overrides,
	};
	insertRow(db, "rss_feeds", base, SITE_ID);
}

describe("rss-feeds repository", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb();
	});

	afterEach(() => {
		db.close();
	});

	describe("findRssFeedByName", () => {
		it("returns the full row for a live feed", () => {
			seedFeed(db, { id: "f1", name: "blog", url: "https://blog.example/rss" });
			const row = findRssFeedByName(db, "blog");
			expect(row?.id).toBe("f1");
			expect(row?.url).toBe("https://blog.example/rss");
		});

		it("returns null for an unknown name", () => {
			expect(findRssFeedByName(db, "ghost")).toBeNull();
		});

		it("returns null for a soft-deleted feed", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			softDelete(db, "rss_feeds", "f1", SITE_ID);
			expect(findRssFeedByName(db, "blog")).toBeNull();
		});
	});

	describe("findRssFeedIdByName", () => {
		it("returns just the id for a live feed", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			expect(findRssFeedIdByName(db, "blog")).toEqual({ id: "f1" });
		});

		it("returns null for a soft-deleted feed", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			softDelete(db, "rss_feeds", "f1", SITE_ID);
			expect(findRssFeedIdByName(db, "blog")).toBeNull();
		});
	});

	describe("findRssFeedIdsById", () => {
		it("returns id/task_id/thread_id for a live feed", () => {
			seedFeed(db, { id: "f1", name: "blog", task_id: "task-9", thread_id: "thr-9" });
			expect(findRssFeedIdsById(db, "f1")).toEqual({
				id: "f1",
				task_id: "task-9",
				thread_id: "thr-9",
			});
		});

		it("returns null for a soft-deleted feed", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			softDelete(db, "rss_feeds", "f1", SITE_ID);
			expect(findRssFeedIdsById(db, "f1")).toBeNull();
		});
	});

	describe("findRssFeedTaskIdById", () => {
		it("returns just the task_id for a live feed", () => {
			seedFeed(db, { id: "f1", name: "blog", task_id: "task-7" });
			expect(findRssFeedTaskIdById(db, "f1")).toEqual({ task_id: "task-7" });
		});

		it("returns null for a soft-deleted feed", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			softDelete(db, "rss_feeds", "f1", SITE_ID);
			expect(findRssFeedTaskIdById(db, "f1")).toBeNull();
		});
	});

	describe("listActiveRssFeeds", () => {
		it("returns [] when empty", () => {
			expect(listActiveRssFeeds(db)).toEqual([]);
		});

		it("returns live feeds ordered by name ASC and excludes soft-deleted", () => {
			seedFeed(db, { id: "f-c", name: "charlie" });
			seedFeed(db, { id: "f-a", name: "alpha" });
			seedFeed(db, { id: "f-b", name: "bravo" });
			seedFeed(db, { id: "f-gone", name: "deleted" });
			softDelete(db, "rss_feeds", "f-gone", SITE_ID);
			expect(listActiveRssFeeds(db).map((f) => f.name)).toEqual(["alpha", "bravo", "charlie"]);
		});
	});

	describe("findActiveRssFeedByThreadId", () => {
		it("finds a live feed bound to a thread", () => {
			seedFeed(db, { id: "f1", name: "blog", task_id: "task-1", thread_id: "thr-1" });
			expect(findActiveRssFeedByThreadId(db, "thr-1")).toEqual({
				id: "f1",
				name: "blog",
				task_id: "task-1",
			});
		});

		it("returns null for an unbound thread", () => {
			expect(findActiveRssFeedByThreadId(db, "nobody")).toBeNull();
		});

		it("returns null when the bound feed is soft-deleted", () => {
			seedFeed(db, { id: "f1", name: "blog", thread_id: "thr-1" });
			softDelete(db, "rss_feeds", "f1", SITE_ID);
			expect(findActiveRssFeedByThreadId(db, "thr-1")).toBeNull();
		});
	});

	describe("findRssFeedDeletedFlagById", () => {
		it("returns deleted=0 for a live feed", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			expect(findRssFeedDeletedFlagById(db, "f1")).toEqual({ deleted: 0 });
		});

		it("still returns a soft-deleted row (NO deleted=0 filter — restore path)", () => {
			seedFeed(db, { id: "f1", name: "blog" });
			softDelete(db, "rss_feeds", "f1", SITE_ID);
			// Unlike the other finders, this one intentionally sees tombstones.
			expect(findRssFeedDeletedFlagById(db, "f1")).toEqual({ deleted: 1 });
		});

		it("returns null for an id that was never inserted", () => {
			expect(findRssFeedDeletedFlagById(db, "never")).toBeNull();
		});
	});
});
