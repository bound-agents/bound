/**
 * Read repository layer for synced tables. The read-side CI guard
 * (scripts/validate-read-centralization.ts) ratchets inline reads outside this
 * directory down against a baseline. Writes go through
 * insertRow/updateRow/softDelete in ../change-log.ts (invariant #1); the
 * exceptions here are create-webhook-binding.ts and the owner-only status
 * transitions in mcp-auth-challenges.ts, which call those same helpers.
 *
 * Conventions for every module here:
 *  - Standalone exported functions, `db: Database` as the first argument. No classes.
 *    (Mirrors the existing ../relay.ts and ../dispatch.ts thin-wrapper modules.)
 *  - Single-row finders return `SyncedTableRowMap[T] | null` (the row interface from
 *    @bound/shared); list finders return `T[]`.
 *  - bun:sqlite `.get()` returns `null` (NOT undefined) on an empty read — type the
 *    cast as `... | null` and guard for null at the call site (invariant #8).
 *  - Per-table modules (threads.ts, messages.ts, ...) hold single-table finders.
 *  - Cross-table JOINs / aggregates live under ./queries/, named by the operation.
 */

export * from "./threads";
export * from "./messages";
export * from "./semantic-memory";
export * from "./tasks";
export * from "./effective-model-hint";
export * from "./skills";
export * from "./agents";
export * from "./advisories";
export * from "./users";
export * from "./files";
export * from "./hosts";
export * from "./turns";
export * from "./cluster-config";
export * from "./connector-handles";
export * from "./memory-edges";
export * from "./client-sessions";
export * from "./webhooks";
export * from "./create-webhook-binding";
export * from "./rss-feeds";
export * from "./mcp-auth-challenges";
export * from "./model-routing";
export * from "./change-log";
export * from "./host-meta";
export * from "./sync-state";
export * from "./durable-work";
export * from "./queries/attached-session-hosts";
export * from "./queries/cross-thread-summaries";
export * from "./queries/connector-bindings-with-task";
export * from "./queries/file-modification-notices";
export * from "./queries/find-dark-connector-handles";
export * from "./queries/find-task-infra-binding";
export * from "./queries/get-webhook-with-task";
export * from "./queries/get-rss-feed-with-task";
export * from "./queries/memory-graph-neighbors";
export * from "./queries/memory-summary-children";
export * from "./queries/memory-with-source";
export * from "./queries/recent-task-runs-with-host";
export * from "./queries/recent-threads-with-messages";
export * from "./queries/thread-user-display-name";
export * from "./queries/threads-directory-listing";
export * from "./queries/thread-cost";
export * from "./queries/interrupted-tool-use";
export * from "./queries/model-reference-health";
