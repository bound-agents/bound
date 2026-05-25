/**
 * Stage 1.7 HISTORY_COMPACTION — replaces old `tool_result`
 * content with retrieval-pointer stubs and conditionally strips
 * thinking blocks from old `tool_call`s.
 *
 * **The cache-stability invariant** is what makes this stage
 * load-bearing for prefix caching:
 *
 *   The compaction boundary is anchored to `lastUserIdx` (the
 *   index of the most recent user message). Anything BEFORE the
 *   boundary is eligible for compaction; anything AT OR AFTER
 *   the boundary stays intact.
 *
 *   This anchor must be STABLE across multiple LLM round-trips
 *   within a single user request. If it slid forward as new
 *   assistant + tool_result rows append (the naive
 *   `length - recentWindow` boundary), then on every warm/cold
 *   pass a previously-preserved tool_result would get newly
 *   stubbed — mutating the prefix bytes and busting the
 *   provider's prefix cache.
 *
 *   The user-anchored boundary moves ONLY when the user sends a
 *   new message. That's a natural cache-invalidation point
 *   (it's a new turn anyway), so we accept the one-time miss.
 *
 * Properties pinned by `__tests__/compaction.property.test.ts`:
 *
 *   H1 Boundary anchoring — for any message sequence that
 *      contains a user message, `computeCompactionBoundary`
 *      returns the index of the LAST user message.
 *
 *   H2 Cache stability — appending assistant + tool_result
 *      messages after `lastUserIdx` does NOT change the boundary.
 *      (THE big invariant — the one that makes prefix caching
 *      work across LLM round-trips.)
 *
 *   H3 User-shift — appending a user message DOES advance the
 *      boundary forward to that new index.
 *
 *   H4 Fallback path — when no user message exists, the boundary
 *      is `max(0, messages.length - recentWindow)`.
 *
 *   H5 `compactToolResultsBeforeBoundary` idempotence — re-running
 *      on already-compacted messages produces no change.
 *
 *   H6 Compaction threshold respect — only `tool_result` rows
 *      with content > `COLD_COMPACTION_THRESHOLD` get stubbed.
 *
 *   H7 Compaction touches only pre-boundary rows — messages at
 *      index ≥ boundary are never modified.
 */

export {
	compactToolResultsBeforeBoundary,
	computeCompactionBoundary,
	stripThinkingBeforeBoundary,
} from "./compact";
