# Notify Action-Selector Redesign

## Summary

This refactor simplifies the `notify` agent tool by replacing its current parameter model with an action-selector pattern. Today, the tool uses mutual exclusivity between `user` and `all` parameters to control routing, which has become error-prone as the tool evolved. The redesign introduces two explicit actions: `thread` (notify a known thread ID directly) and `user` (resolve a thread via username + platform lookup, then notify). Both actions share the same underlying dispatch path and validation guards (non-empty message, self-notify prevention), but provide clearer semantics at the LLM interface layer.

The implementation follows established patterns from `memory`, `skill`, and `cache` tools, which already use `action` enum dispatch with flat optional parameters. The `all` broadcast option is removed entirely without replacement — future broadcast needs can be implemented as higher-level patterns (e.g., a skill or scheduled task that iterates over users) rather than as a built-in action. No changes to the dispatch queue infrastructure or notification delivery mechanisms are required.

## Definition of Done
Refactor the `notify` agent tool into an action-selector pattern with two actions (`thread` and `user`), where the `thread` action provides direct thread-level notification by ID (with existence validation), and the `user` action resolves a target thread via username + platform lookup. The `all` broadcast option is removed entirely. The tool follows established codebase conventions (snake_case params, action enum dispatch), the test suite covers both actions and their error paths, and design documentation is updated.

## Acceptance Criteria

### notify-action-selector.AC1: Thread action delivers notification by ID
- **notify-action-selector.AC1.1 Success:** `action: "thread"` with valid, non-deleted thread_id enqueues notification and emits `notify:enqueued` event
- **notify-action-selector.AC1.2 Failure:** Missing `thread_id` returns descriptive error
- **notify-action-selector.AC1.3 Failure:** Non-existent or soft-deleted thread_id returns error
- **notify-action-selector.AC1.4 Failure:** `thread_id` matching current thread (self-notify) returns error
- **notify-action-selector.AC1.5 Failure:** Empty/whitespace-only message returns error

### notify-action-selector.AC2: User action resolves thread via platform lookup
- **notify-action-selector.AC2.1 Success:** `action: "user"` with valid username and platform resolves DM thread, enqueues notification, emits event
- **notify-action-selector.AC2.2 Failure:** Missing `user` or `platform` returns descriptive error
- **notify-action-selector.AC2.3 Failure:** Non-existent username returns error
- **notify-action-selector.AC2.4 Failure:** User exists but has no DM thread on specified platform returns error
- **notify-action-selector.AC2.5 Failure:** Resolved thread matches current thread (self-notify) returns error

### notify-action-selector.AC3: Codebase conventions followed
- **notify-action-selector.AC3.1:** Tool uses `action` enum dispatch pattern matching `memory`/`skill`/`cache`
- **notify-action-selector.AC3.2:** `docs/design/agent-system.md` tool table reflects new parameters
- **notify-action-selector.AC3.3:** `all` parameter and broadcast logic are fully removed

## Glossary

- **Action-selector pattern**: A tool design pattern where an `action` enum parameter discriminates between multiple operation modes (e.g., `"thread"` vs `"user"`), and the handler dispatches to separate functions based on the action value.
- **Agent tool**: A command available to the agent loop during LLM inference. Defined with JSON schemas (via Zod), registered in the tool registry, and invoked when the LLM emits a structured tool call.
- **DM thread**: A direct-message thread between a user and the agent on a specific platform (e.g., Discord). Each user can have zero or one DM thread per platform, stored in the `threads` table with `interface` matching the platform name.
- **Self-notify guard**: A validation rule that rejects `notify` calls where the target thread matches the current thread (`ctx.threadId`). Prevents feedback loops where the agent sends itself a notification in the thread it's already processing.
- **Soft delete**: Deletion pattern for synced tables — rows are marked with `deleted = 1` rather than physically removed. Queries filter with `WHERE deleted = 0`.
- **`notify:enqueued`**: Event emitted on the event bus after a notification is successfully enqueued in the dispatch queue. Signals the server to run inference on the target thread.

## Architecture

Refactor the `notify` tool from a flat parameter model with mutual exclusivity (`user` XOR `all`) into an action-selector pattern with an `action` enum discriminant. The tool exposes two actions:

- **`thread`**: Direct notification to a known thread ID. Validates existence before enqueueing.
- **`user`**: Resolves a target thread by looking up the user's most recent DM thread on a given platform. Convenience layer over the thread primitive.

Both actions converge on the same dispatch path: `enqueueAndSignal(ctx, threadId, sourceThreadId, message)` → `enqueueNotification` (from `@bound/core`) → `notify:enqueued` event. No changes to the underlying dispatch infrastructure.

### Schema Contract

```typescript
const notifySchema = z.object({
	action: z.enum(["thread", "user"]).describe("Notification target mode"),
	thread_id: z.string().optional().describe("Target thread ID (for thread action)"),
	user: z.string().optional().describe("Target bound username (for user action)"),
	platform: z.string().optional().describe("Platform name, e.g. 'discord' (for user action)"),
	message: z.string().describe("Notification message content"),
});
```

Tool definition description: `"Send a proactive notification to a thread or user on a configured platform"`

### Handler Dispatch

```typescript
switch (input.action) {
	case "thread": return handleThread(input, ctx);
	case "user": return handleUser(input, ctx);
}
```

### Shared Guards

Both handlers apply:
1. Message non-empty validation
2. Self-notify guard: error if resolved target `threadId === ctx.threadId`

## Existing Patterns

This design follows established patterns found across the agent tool suite:

- **Action-selector with flat schema**: `memory`, `skill`, and `cache` tools all use `action: z.enum([...])` with flat optional params. The LLM infers which params apply from `.describe()` annotations.
- **`thread_id` snake_case naming**: Matches `purge` and `archive` tools.
- **Thread existence validation**: `SELECT id FROM threads WHERE id = ? AND deleted = 0` matches the `archive` tool's pattern exactly.
- **Handler function naming**: `handleThread` / `handleUser` follows `memory`'s `handleStore` / `handleForget` / `handleSearch` convention.
- **`parseToolInput` + `zodToToolParams`**: Standard tool schema conversion, unchanged.

No new patterns introduced. This is a pure simplification that aligns an outlier tool with the established conventions.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Refactor notify tool to action-selector pattern
**Goal:** Replace the current `user`/`all` mutual-exclusivity model with `action` enum dispatch and two handler functions.

**Components:**
- `packages/agent/src/tools/notify.ts` — new schema, `handleThread` and `handleUser` functions, switch dispatch, remove `getAllUsers` helper and broadcast logic
- `docs/design/agent-system.md` — update tool parameter table

**Dependencies:** None

**Done when:** Tool accepts `action: "thread"` with `thread_id` and `action: "user"` with `user` + `platform`, dispatches correctly, self-notify guard works on both paths, thread existence validation rejects deleted/missing threads, and all tests for notify-action-selector.AC1.* and notify-action-selector.AC2.* pass.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Rewrite test suite
**Goal:** Replace existing tests with comprehensive coverage of both actions and their error paths.

**Components:**
- `packages/agent/src/tools/__tests__/notify.test.ts` — full rewrite covering all acceptance criteria

**Dependencies:** Phase 1

**Done when:** All 10 test cases pass (2 happy paths, 8 error cases), covering notify-action-selector.AC1.* and notify-action-selector.AC2.*.
<!-- END_PHASE_2 -->

## Additional Considerations

**Self-notify guard rationale:** Notifying the current thread creates a feedback loop — the agent receives a notification in the thread it's already processing. The guard forces notifications to originate from background tasks or other threads, ensuring they arrive as interrupts rather than echoes.

**No broadcast replacement:** The `all` broadcast was removed without replacement. If broadcast is needed in the future, it can be implemented as a higher-level pattern (e.g., a skill or scheduled task that iterates over users and calls `notify` per-user), rather than as a built-in action.
