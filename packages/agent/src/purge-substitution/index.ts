/**
 * Stage 2 PURGE_SUBSTITUTION — replace purge-targeted messages
 * with summary developer-message stubs.
 *
 * The `purge` agent tool emits a `role: "purge"` message whose
 * content is `{ target_ids: string[], summary: string }`. The
 * substitution stage drops the targeted messages and inserts a
 * single developer-role summary in place of the first purged
 * message of each group.
 *
 * **Tool-pair symmetric expansion** is the load-bearing
 * invariant: purging either side of a `tool_call` ↔ `tool_result`
 * pair MUST also purge the other side, otherwise the wire payload
 * lands an orphan that Bedrock / Anthropic rejects with the
 * "Each tool_use_id must have a corresponding tool_result block"
 * 400.
 *
 * **Provenance marking** on the summary developer message: the
 * summary text comes from the agent's own input to `purge` —
 * there's no system verification of truthfulness at write time.
 * The prefix `(purged N messages — agent-authored summary,
 * unverified; verify against source tables before relying)`
 * flags it. Live precedent for the necessity of this prefix:
 * thread `d0372be6-...` 2026-05-24 where the agent's confabulated
 * "Issues #20-36 captured" purge summary drove ~50 turns of
 * "stand down" decisions against actual fresh webhook deliveries.
 *
 * Properties pinned by `__tests__/purge.property.test.ts`:
 *
 *   P1 Purge messages themselves are dropped from output (the
 *      role:"purge" rows never reach the LLM).
 *   P2 Tool-pair symmetric expansion — purging a tool_call also
 *      drops its paired tool_result (and vice versa).
 *   P3 Each purge group emits exactly one summary message.
 *   P4 The summary message carries the unverified-provenance prefix.
 *   P5 Non-purged messages survive.
 *   P6 Determinism — same input produces same output.
 *   P7 Malformed purge metadata is silently skipped (the row is
 *      still dropped from output but it doesn't crash the stage).
 *   P8 Empty input → empty output.
 */

export {
	substitutePurgedMessages,
	type SubstitutePurgedMessagesParams,
} from "./substitute";
