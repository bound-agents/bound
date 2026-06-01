import type { Database } from "bun:sqlite";
import { predictCacheState } from "./cache-prediction";
import { isClientSessionLive } from "./delegation";

/**
 * Cache-warming "warm poke" target selection (issue #10).
 *
 * A warm poke is a cheap, tool-less, near-zero-output agent turn enqueued on an
 * active thread to keep its LLM prompt cache hot, so the next real message
 * lands on a discounted cache-read instead of a full-price cache-write.
 *
 * Economics drive every gate here. A poke costs roughly one cache-read of the
 * thread prefix; a *caught* cold arrival saves roughly one cache-write. With
 * opus pricing (~1.25x base input for a write, ~0.1x for a read) break-even is
 * ~11.5 pokes per caught arrival. So a poke is only ever net-positive when:
 *
 *  - the cache is currently WARM and about to lapse (we extend an existing
 *    warm prefix with a cheap read — we never *re-warm* a cold cache, since
 *    that costs a full write with no guarantee a real message follows), and
 *  - the thread is plausibly going to receive a follow-up message soon
 *    (anchored on real activity), and
 *  - we have not already poked it more than `maxPokesPerActivePeriod` times
 *    since its last real activity (bounds the loss on threads that go quiet).
 */

/**
 * Marker prefix stamped on warm-poke notification content. Lets the selector
 * count prior pokes since the last real user message via a content LIKE,
 * without a dedicated column. Must match the prefix produced by the warm-poke
 * notification formatter in the start server.
 */
export const WARM_POKE_MARKER = "[cache-warm-poke]";

/**
 * Output-token ceiling for a warm-poke turn. Defense-in-depth alongside the
 * empty tool list: the poke only needs to read the cached prefix, the reply is
 * discarded, so we clamp generation hard.
 */
export const WARM_POKE_MAX_OUTPUT_TOKENS = 16;

/**
 * Interfaces whose threads can only run their tools on the host holding a live
 * client session. Poking such a thread with no live session is pointless: there
 * is no imminent interaction to keep the cache warm for, and the woken loop
 * cannot run its client tools anyway. Mirrors `CLIENT_TOOL_INTERFACES` in
 * delegation.ts.
 */
const CLIENT_TOOL_INTERFACES = new Set(["boundless"]);

export interface WarmPokeSelectionOptions {
	/**
	 * Resolve a thread's warm-poke policy from its backend, or null when caching
	 * is not configured for that backend (nothing to keep warm — a poke would
	 * re-warm a prefix the provider won't cache anyway). Both knobs are derived
	 * per-thread from one model resolution so a single driver serves a mixed
	 * cluster correctly:
	 *  - `ttlMs`: the cache TTL in ms (from the backend's `cache_ttl`), which
	 *    sets the just-in-time poke window (backends differ, e.g. 5m vs 1h).
	 *  - `maxPokes`: the per-active-period poke cap (from the backend's
	 *    `max_pokes_per_active_period`), the load-bearing economic control —
	 *    break-even varies dramatically by provider's cache-write/read pricing.
	 *    0 means "never warm threads on this backend".
	 */
	resolvePokePolicy: (threadId: string) => { ttlMs: number; maxPokes: number } | null;
	/**
	 * Driver scan period in ms. A thread is "near expiry" when it would go cold
	 * before the next scan, so the just-in-time window for a thread is
	 * `ttlMs − scanIntervalMs`. Must be < the smallest TTL in play to stay
	 * positive.
	 */
	scanIntervalMs: number;
	/** A thread counts as active if it had real activity within this window. */
	activeWindowMs: number;
	/** Wall clock override (tests). */
	now?: number;
	/** Client-session staleness window (passed through to isClientSessionLive). */
	staleClientSessionMs?: number;
}

interface CandidateRow {
	thread_id: string;
	anchor: string;
}

/**
 * Returns the thread ids that should receive a warm poke right now.
 *
 * Note: `predictCacheState` reads the wall clock internally, so callers that
 * inject `now` for deterministic tests should use timestamps relative to the
 * real current time for the warm/cold determination to stay consistent.
 */
export function selectWarmPokeTargets(db: Database, options: WarmPokeSelectionOptions): string[] {
	const { resolvePokePolicy, scanIntervalMs, activeWindowMs, staleClientSessionMs } = options;
	const now = options.now ?? Date.now();
	const activeCutoff = new Date(now - activeWindowMs).toISOString();

	// Anchor per thread = the timestamp of its last real activity. Pokes created
	// after the anchor count against the per-period cap.
	const candidates = new Map<string, string>();

	// Category A: threads with a real user message in the active window.
	const userThreads = db
		.query(
			`SELECT thread_id, MAX(created_at) AS anchor
			 FROM messages
			 WHERE role = 'user' AND deleted = 0 AND created_at > ?
			 GROUP BY thread_id`,
		)
		.all(activeCutoff) as CandidateRow[];
	for (const { thread_id, anchor } of userThreads) {
		candidates.set(thread_id, anchor);
	}

	// Category B: noHistory cron/heartbeat threads that ran in the active window.
	// These never have user messages, so their active period is anchored on the
	// last task run. (They cold-assemble per run, so only the *shared* system
	// prefix benefits — included because the issue lists them, but the same caps
	// keep the cost bounded.)
	const cronThreads = db
		.query(
			`SELECT thread_id, MAX(last_run_at) AS anchor
			 FROM tasks
			 WHERE no_history = 1 AND deleted = 0 AND thread_id IS NOT NULL
			       AND last_run_at IS NOT NULL AND last_run_at > ?
			 GROUP BY thread_id`,
		)
		.all(activeCutoff) as CandidateRow[];
	for (const { thread_id, anchor } of cronThreads) {
		const existing = candidates.get(thread_id);
		if (!existing || anchor > existing) candidates.set(thread_id, anchor);
	}

	const targets: string[] = [];

	for (const [threadId, anchor] of candidates) {
		// Per-thread warm-poke policy from the thread's backend. Null = caching
		// not configured for that backend, so there is no warm prefix to keep
		// alive. Both the TTL window and the poke cap ride on this one lookup.
		const policy = resolvePokePolicy(threadId);
		if (policy === null) continue;
		const { ttlMs, maxPokes } = policy;

		// Must have prior inference (something to keep cached).
		const turn = db
			.query("SELECT created_at FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(threadId) as { created_at: string } | null;
		if (!turn) continue;

		// Only extend a currently-WARM prefix. Never re-warm a cold cache — that
		// costs a full write with no guarantee a real message follows.
		if (predictCacheState(db, threadId, ttlMs) !== "warm") continue;

		// Just-in-time: skip threads whose cache will still be warm at the next
		// scan. Only poke when it would otherwise lapse before then. The window
		// width is exactly one scan interval, so a scan running every
		// `scanIntervalMs` is guaranteed to catch the thread before it goes cold.
		const msSinceTurn = now - new Date(turn.created_at).getTime();
		if (msSinceTurn < ttlMs - scanIntervalMs) continue;

		// Per-active-period poke cap (the load-bearing economic control,
		// derived per-backend). maxPokes === 0 means "never warm this backend",
		// which this check enforces naturally (0 >= 0).
		const pokeRow = db
			.query(
				`SELECT COUNT(*) AS n FROM messages
				 WHERE thread_id = ? AND role = 'developer' AND deleted = 0
				       AND created_at > ? AND content LIKE ?`,
			)
			.get(threadId, anchor, `${WARM_POKE_MARKER}%`) as { n: number };
		if (pokeRow.n >= maxPokes) continue;

		// Client-tool threads (boundless) with no live session: nothing to warm
		// for, and the woken loop can't run client tools anyway.
		const threadRow = db
			.query("SELECT interface FROM threads WHERE id = ? AND deleted = 0")
			.get(threadId) as { interface: string } | null;
		if (
			threadRow &&
			CLIENT_TOOL_INTERFACES.has(threadRow.interface) &&
			!isClientSessionLive(db, threadId, staleClientSessionMs)
		) {
			continue;
		}

		targets.push(threadId);
	}

	return targets;
}
