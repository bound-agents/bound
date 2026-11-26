import type { Database } from "bun:sqlite";
import type { RssFeed } from "@bound/shared";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** Live (`deleted = 0`) feed rows. */
function liveRssFeeds() {
	return queryBuilder.selectFrom("rss_feeds").where("deleted", "=", 0);
}

export function findRssFeedIdByName(db: Database, name: string): { id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("rss_feeds")
			.select("id")
			.where("name", "=", name)
			.where("deleted", "=", 0),
	);
}

export function findRssFeedIdsById(
	db: Database,
	id: string,
): { id: string; task_id: string; thread_id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("rss_feeds")
			.select(["id", "task_id", "thread_id"])
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

export function findRssFeedTaskIdById(db: Database, id: string): { task_id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("rss_feeds")
			.select("task_id")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

/**
 * All live feeds, for the leader-gated poller's tick. The poller owns cadence
 * (per-feed `poll_interval_seconds`) in memory; this read is deliberately
 * unfiltered by time so a fresh leader starts from the full set.
 */
export function listActiveRssFeeds(db: Database): RssFeed[] {
	return getAll(db, liveRssFeeds().selectAll().$castTo<RssFeed>().orderBy("name", "asc"));
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
): { id: string; name: string; task_id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("rss_feeds")
			.select(["id", "name", "task_id"])
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0),
	);
}

/**
 * Read-back that intentionally OMITS the `deleted = 0` filter — used by the
 * deterministic-id restore path, which must see a previously soft-deleted row.
 */
export function findRssFeedDeletedFlagById(db: Database, id: string): { deleted: number } | null {
	return getOne(db, queryBuilder.selectFrom("rss_feeds").select("deleted").where("id", "=", id));
}
