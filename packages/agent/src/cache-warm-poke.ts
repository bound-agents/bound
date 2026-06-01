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
	/** Cache TTL in ms (e.g. `CACHE_TTL_MS["1h"]`). */
	ttlMs: number;
	/** Driver cadence in ms. A thread is "near expiry" when it would go cold
	 *  before the next driver tick. Must be < ttlMs. */
	cadenceMs: number;
	/** A thread counts as active if it had real activity within this window. */
	activeWindowMs: number;
	/** Max warm pokes per thread since its last real activity. */
	maxPokesPerActivePeriod: number;
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
	const { ttlMs, cadenceMs, activeWindowMs, maxPokesPerActivePeriod, staleClientSessionMs } =
		options;
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
		// Must have prior inference (something to keep cached).
		const turn = db
			.query("SELECT created_at FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(threadId) as { created_at: string } | null;
		if (!turn) continue;

		// Only extend a currently-WARM prefix. Never re-warm a cold cache — that
		// costs a full write with no guarantee a real message follows.
		if (predictCacheState(db, threadId, ttlMs) !== "warm") continue;

		// Just-in-time: skip threads whose cache will still be warm at the next
		// tick. Only poke when it would otherwise lapse before then.
		const msSinceTurn = now - new Date(turn.created_at).getTime();
		if (msSinceTurn < ttlMs - cadenceMs) continue;

		// Per-active-period poke cap (the load-bearing economic control).
		const pokeRow = db
			.query(
				`SELECT COUNT(*) AS n FROM messages
				 WHERE thread_id = ? AND role = 'developer' AND deleted = 0
				       AND created_at > ? AND content LIKE ?`,
			)
			.get(threadId, anchor, `${WARM_POKE_MARKER}%`) as { n: number };
		if (pokeRow.n >= maxPokesPerActivePeriod) continue;

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
