import type { Database } from "bun:sqlite";
import type { RssFeed } from "@bound/shared";

/**
 * Read repository for the `rss_feeds` table. See ./index.ts for conventions.
 *
 * Mirrors ./webhooks.ts — RSS feeds share the webhook binding shape (feed row
 * + delivery thread + event task), so the finder surface is intentionally
 * parallel. The extra reads here serve the poller (`listActiveRssFeeds`) and
 * the stale-intake reconciler (`findActiveRssFeedByThreadId`).
 */

export function findRssFeedByName(db: Database, name: string): RssFeed | null {
	return db
		.query("SELECT * FROM rss_feeds WHERE name = ? AND deleted = 0")
		.get(name) as RssFeed | null;
}

export function findRssFeedIdByName(db: Database, name: string): { id: string } | null {
	return db.query("SELECT id FROM rss_feeds WHERE name = ? AND deleted = 0").get(name) as {
		id: string;
	} | null;
}

export function findRssFeedIdsById(
	db: Database,
	id: string,
): { id: string; task_id: string; thread_id: string } | null {
	return db
		.query("SELECT id, task_id, thread_id FROM rss_feeds WHERE id = ? AND deleted = 0")
		.get(id) as { id: string; task_id: string; thread_id: string } | null;
}

export function findRssFeedTaskIdById(db: Database, id: string): { task_id: string } | null {
	return db.query("SELECT task_id FROM rss_feeds WHERE id = ? AND deleted = 0").get(id) as {
		task_id: string;
	} | null;
}

/**
 * All live feeds, for the leader-gated poller's tick. The poller owns cadence
 * (per-feed `poll_interval_seconds`) in memory; this read is deliberately
 * unfiltered by time so a fresh leader starts from the full set.
 */
export function listActiveRssFeeds(db: Database): RssFeed[] {
	return db.query("SELECT * FROM rss_feeds WHERE deleted = 0 ORDER BY name ASC").all() as RssFeed[];
}

/**
 * Finds the live (non-soft-deleted) feed bound to a handler thread, or null.
 *
 * RSS intake rows are written with `ref_id = rss_feed.thread_id` (the same
 * contract as webhook intake), and only drain when a task whose `thread_id`
 * matches runs. The stale-intake reconciler uses this to classify undrained
 * `rss_intake` rows as RECOVERABLE (live binding, dark handler) vs ORPHANED
 * (feed deregistered — dead-letter, nothing can ever drain it).
 */
export function findActiveRssFeedByThreadId(
	db: Database,
	threadId: string,
): { id: string; name: string } | null {
	return db
		.query("SELECT id, name FROM rss_feeds WHERE thread_id = ? AND deleted = 0")
		.get(threadId) as { id: string; name: string } | null;
}

/**
 * Read-back that intentionally OMITS the `deleted = 0` filter — used by the
 * deterministic-id restore path, which must see a previously soft-deleted row.
 */
export function findRssFeedDeletedFlagById(db: Database, id: string): { deleted: number } | null {
	return db.query("SELECT deleted FROM rss_feeds WHERE id = ?").get(id) as {
		deleted: number;
	} | null;
}
