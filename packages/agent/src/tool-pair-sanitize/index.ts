/**
 * Tool-pair sanitization — Stage 3 of the context-assembly pipeline.
 *
 * Tool-pair adjacency is a wire-protocol contract enforced by every
 * supported provider:
 *   - Anthropic (direct + on Bedrock): each `tool_use` block in the
 *     assistant turn must be paired with a `tool_result` block in
 *     the SAME user turn that follows. Mid-pair non-tool messages
 *     trigger 400 "Each tool_use_id must have a corresponding
 *     tool_result block".
 *   - Bedrock Converse: same shape; "Expected toolResult blocks at
 *     messages.0.content for the following Ids: …" is the rejection
 *     when the first message is an orphan tool_result whose tool_call
 *     was sliced off by truncation.
 *   - OpenAI-compatible: tool_call → tool with `tool_call_id` must be
 *     adjacent.
 *
 * The sanitizer makes the persisted message stream wire-legal by
 * doing two passes:
 *
 *   **Pass 1 — Reorder.** For each `tool_call`, look ahead for its
 *   matching `tool_result` rows. If non-tool messages were
 *   interleaved between (e.g. a system-injected developer note that
 *   landed mid-batch, or assistant text persisted with the same
 *   timestamp as a co-emitted tool_call), move those non-tool rows
 *   ahead of the `tool_call` so the pair is adjacent on the wire.
 *
 *   The pass is multi-tool aware: a single `tool_call` message can
 *   contain N `tool_use` blocks expecting N matching `tool_result`
 *   rows. Pass 1 collects all N before deciding the pair is closed,
 *   AND will scan past a subsequent `tool_call` boundary to claim
 *   stragglers (parallel-tool racing: the agent loop re-entered
 *   inference before a slow result returned), constrained to results
 *   whose `tool_use_id` is in OUR pending set so we never steal
 *   results that belong to the next tool_call.
 *
 *   Assistant messages between a `tool_call` and its `tool_result` are
 *   NOT reordered — only "system-shaped" non-tool messages are
 *   hoisted. Reordering assistant text was a historical regression
 *   that corrupted conversation flow. Pass 2 handles the structural
 *   case where an assistant message sits mid-pair.
 *
 *   **Pass 2 — Structural repair.** After Pass 1 the stream is
 *   adjacency-correct in the common case but can still contain:
 *     - `tool_call` rows whose results were never persisted
 *       (interrupted execution, agent crashed mid-tool, the assistant
 *       streamed the request but the loop yielded before the result
 *       was returned). Synthesize stub `tool_result` rows with
 *       `"Tool execution was interrupted"` content, one per pending
 *       `tool_use_id`.
 *     - `tool_result` rows with no preceding `tool_call` (orphans,
 *       typically from a slice-off after truncation). Synthesize a
 *       stub `tool_call` row with the result's `tool_use_id`.
 *     - Consecutive multi-tool `tool_result`s — the second, third…
 *       results of a parallel call extend the synthetic tool_call
 *       (when one was injected) instead of getting their own.
 *
 *   The Bedrock driver requires that synthetic tool_calls carry a
 *   non-empty `tool_use` block — falling back to `[{ text: "" }]`
 *   triggers `"text field is blank"`. We always emit a `tool_use`
 *   block with the result's `tool_use_id` to keep this branch
 *   wire-legal.
 *
 * The post-sanitize stream is the contract every downstream stage
 * (annotation, content substitution, budget validation) operates on.
 *
 * **Architecture decision:** the sanitizer takes a `threadId` param
 * because synthetic messages need a `thread_id` field for
 * `Message`-shape compatibility, but the function is otherwise pure
 * — no DB, no clock for the messages themselves (synthetic timestamps
 * use `new Date().toISOString()` at construction, but property tests
 * mock that branch via `nowMs` parameterization).
 *
 * Property-tested at
 * `__tests__/tool-pair-sanitize.property.test.ts`. Parity with the
 * historical inline implementation pinned by
 * `__tests__/parity-with-production.test.ts`.
 */

export {
	sanitizeToolPairs,
	type SanitizeToolPairsParams,
} from "./sanitize";
export {
	extractToolUseIds,
	hasOrphanedToolResult,
	hasUnclosedToolCall,
} from "./helpers";
