# RFC: Memory & Task Visibility in Context Assembly

**Version:** 0.3  
**Date:** 2026-03-29  
**Status:** Draft  
**Amends:** §9.2 (Prompt Structure & Caching), §13.1 (Context Assembly Pipeline)  
**References:** R-U30, R-O3, R-E19, §5.5, §5.6, §5.8, §6.2, §9.5, §9.7, §10.2, §10.3, §10.6, §12.7, §13.4

---

## 1. Problem Statement

### 1.1 The Visibility Gap

The context assembly pipeline (§13.1) surfaces semantic memory to the agent as a count:

```
Memory: 47 entries | Files: 12 (cache: 89/200MB, 3 pinned)
```

The agent must issue a `query` tool call to read any memory entry. This creates a structural blind spot: when a scheduled task calls `memorize`, the new or updated entry exists in the database but is invisible to every other thread until the agent in that thread independently decides to query for it — a decision that costs one tool turn and relies on the LLM inferring that something changed.

### 1.2 Affected Scenarios

**Scenario A: Recurring task writes structured state, interactive thread is unaware.**
A cron task checks PRs every hour and runs `memorize --key "monitor.pr-check.known_failing" --value '[\"#42\",\"#45\"]'`. The user opens a new interactive thread and asks "what's failing right now?" The agent has no signal that `monitor.pr-check.known_failing` was updated 12 minutes ago. It must either (a) guess that the key exists and query for it, or (b) call the GitHub MCP tool directly, duplicating the work the cron task already did.

**Scenario B: Quiet task results are completely invisible.**
A `--quiet` DAG step completes and memorizes its findings. Because `--quiet` suppresses thread messages (§6.2), no entry appears in the cross-thread activity digest (R-U30). The volatile context contains zero signal that the task ran.

**Scenario C: Quiescence suppresses all recurring output.**
During off-peak or night service (§9.7), recurring tasks behave as `--quiet` — results go to `tasks.result` without posting to the thread. A user returns after 8 hours of quiescence. The agent has accumulated dozens of memory updates from overnight monitoring runs, but the first interactive turn's volatile context shows only `Memory: 63 entries` (up from 47 — but the agent doesn't know what 47 was).

**Scenario D: Event-driven task reacts to memory, but sibling threads don't.**
A `memory.updated` event fires when a task memorizes a status change. The event-driven task that subscribes to it runs and acts. But every other active thread is oblivious — neither the event nor the resulting memory change appears in their context.

### 1.3 Root Cause

The cross-thread activity digest (R-U30) is generated from the **messages** table. Semantic memory writes (`memorize`) do not produce messages — they produce `change_log` events for sync and `memory_ops` rows for telemetry, neither of which feeds into context assembly. The digest answers "what happened in other threads" but not "what does the agent now know that it didn't know before."

The task summary line in volatile context shows pending/running task counts but omits **recently completed** tasks and their outcomes.

These are two distinct information channels that are absent from the context assembly pipeline:

1. **Memory deltas** — what changed in semantic memory since this thread's last turn.
2. **Task completions** — what tasks finished recently and what they produced.

---

## 2. Proposed Requirements

### 2.1 Memory Delta Injection

**R-MV1.** The volatile context shall include a **memory delta** section listing semantic memory entries whose `modified_at` is more recent than the current thread's `last_message_at` (i.e., entries that changed since the agent last spoke in this thread). Each entry is rendered as a single line: `{key}: {value} (updated {relative_time}, source: {resolved_source})`. The resolved source is a human-readable label derived from the `source` column — see §2.3 for resolution rules. The section is omitted when there are no recent changes.

**R-MV2.** The memory delta shall be capped at **10 entries**, ordered by `modified_at DESC` (most recent first). When more than 10 entries have changed, the volatile context shall display the 10 most recent and append: `... and {N} more (query semantic_memory for full list)`.

**R-MV3.** Memory entries with `deleted = 1` (tombstoned) shall appear in the delta as: `{key}: [forgotten] ({relative_time}, source: {resolved_source})`. This prevents the agent from referencing stale facts that were actively removed since the last turn.

**R-MV4.** The memory delta baseline shall be selected from the following fallback chain:

| Context | Baseline | Rationale |
|---|---|---|
| Interactive thread with prior messages | `thread.last_message_at` | Delta since the agent's last turn in this thread. |
| Interactive thread, first turn | `thread.created_at` | Delta since the thread was opened. |
| Autonomous task, `no_history=false` | `thread.last_message_at` | Same as interactive — the task inherits thread context. |
| Autonomous task, `no_history=true`, subsequent run | `task.last_run_at` | Delta since this task's last execution. |
| Autonomous task, `no_history=true`, first run | `task.created_at` | Delta since the task was scheduled. Ensures the first run sees memory written between scheduling and first execution. |

Implementors should use the first non-NULL value in the applicable row. This prevents the NULL `last_run_at` case (first run of a task) from producing an empty delta via a SQL `> NULL` comparison.

**R-MV5.** The `semantic_memory.last_accessed_at` field shall NOT be updated by delta injection reads. Delta injection is passive context — it should not interfere with the staleness detection used by the agent's periodic memory audit (§6.2 system prompt guidance). Only explicit `query` calls and `memorize` writes update `last_accessed_at`. This amends the §5.5 schema comment, which states that `last_accessed_at` is "updated when queried by context assembly or agent" — delta injection is excluded from that definition.

**Volatile context example (with memory delta):**

```
Memory: 49 entries (2 changed since your last turn in this thread)
  monitor.pr-check.known_failing: ["#42","#45"] (updated 12m ago, source: task "pr_check")
  project.acme.deploy_status: "staging-green" (updated 3h ago, source: task "deploy_watch")
```

**Volatile context example (many changes, e.g., after returning from quiescence):**

```
Memory: 63 entries (18 changed since your last turn in this thread)
  monitor.pr-check.known_failing: ["#42"] (updated 8m ago, source: task "pr_check")
  monitor.ci-watch.last_failure: "timeout in auth-service integ..." (updated 1h ago, source: task "ci_watch")
  project.acme.deploy_status: "prod-green" (updated 2h ago, source: task "deploy_watch")
  user.alice.last_seen: "2026-03-29T06:00:00Z" (updated 6h ago, source: thread "Daily Standup")
  monitor.uptime.p99_latency_ms: 142 (updated 6h ago, source: task "uptime_check")
  monitor.pr-check.total_open: 12 (updated 8m ago, source: task "pr_check")
  project.acme.blockers: ["CI flake in auth-service"] (updated 1h ago, source: task "ci_watch")
  monitor.deps.outdated_count: 3 (updated 12h ago, source: task "dep_check")
  project.acme.last_standup: "2026-03-28" (updated 18h ago, source: thread "Daily Standup")
  user.alice.timezone: "America/New_York" (updated 2d ago, source: thread "Onboarding")
  ... and 8 more (query semantic_memory for full list)
```

### 2.2 Task Run Digest

**R-MV6.** The volatile context shall include a **task run digest** listing tasks whose `last_run_at` is more recent than the baseline (same fallback chain as R-MV4). Each entry shows: `{trigger_spec} ({outcome}, {relative_time}, on {host_name}): {result_summary}`. The `result_summary` is the first 100 characters of `tasks.result`, truncated with `...` if longer. The `outcome` label is `ran` for tasks with `consecutive_failures = 0`, and `failed` for tasks with `consecutive_failures > 0`. The `host_name` is resolved from `claimed_by` (a site ID) via the `hosts` table (§5.8); if the host row is missing, the assembler falls back to the truncated site ID `"{claimed_by[0:8]}"`.

This design is necessary because recurring tasks (cron, event-driven) reset to `status = 'pending'` after each run (§10.3). A status-based filter (`status IN ('completed', 'failed')`) would never match a recurring task between runs. `last_run_at` persists across the status reset and is the correct indicator that a task has executed recently. The System Map's "RECENT ARRIVALS" view (§11.2) already uses `last_run_at` for this purpose.

The digest is **global** — it includes all tasks regardless of which thread scheduled them. This is consistent with the cross-thread activity digest (R-U30), which is also global, and with the memory delta (R-MV1), which includes all memory entries regardless of source. Thread-scoped filtering would defeat the purpose: the user asking "what happened while I was away?" in any thread should see all recent task activity.

**R-MV7.** The task run digest shall be capped at **5 entries**, ordered by `last_run_at DESC` (most recent run first). When more than 5 qualifying tasks exist, append: `... and {N} more (query tasks for full list)`.

**R-MV8.** `--quiet` tasks shall appear in the task run digest. The `--quiet` flag suppresses thread message delivery (§6.2) but shall NOT suppress digest visibility. The digest is a summary line, not a full message — it serves a different purpose (awareness vs. narrative continuity) and does not violate `--quiet`'s intent of keeping the thread clean.

**R-MV9.** During quiescence (§9.7), recurring tasks that are forced into `--quiet` behavior shall still be visible in the digest on subsequent context assembly. When the user returns and triggers the first interactive turn, the task run digest shows a bounded window of what happened while they were away. The 5-entry cap (R-MV7) naturally prevents flooding.

**Volatile context example (with task run digest):**

```
Tasks: 2 pending (cron "daily_report" next in 4h, cron "pr_check" next in 18m)
  Recent runs:
    "pr_check" (ran 12m ago, on cloud-vm): Found 2 failing PRs (#42 CI, #45 timeout)
    "deploy_watch" (ran 3h ago, on cloud-vm): Staging deploy succeeded, prod pending
    "dep_check" (failed 12h ago, on laptop): GitHub API rate limit exceeded
```

### 2.3 Source Resolution

**R-MV10.** The `semantic_memory.source` column stores a raw identifier (thread ID or task ID). For display in the memory delta, the context assembler shall resolve it to a human-readable label:

| `source` value | Resolves to | Example |
|---|---|---|
| Matches a `tasks.id` | `task "{trigger_spec}"` | `task "pr_check"` |
| Matches a `threads.id` where `deleted = 0` | `thread "{title}"` (or `thread "{id[0:8]}"` if untitled) | `thread "Auth Refactor"` |
| `NULL` | `unknown` | `unknown` |

Resolution is performed by a single query with LEFT JOINs against `tasks` and `threads` at delta computation time. The threads JOIN filters on `deleted = 0` — quarantined threads (§12.7) must not have their titles surfaced in context, as quarantine exists to exclude poisoned threads from all future context assembly. If the source ID doesn't match either table (e.g., the originating task was pruned per §10.6, or the source thread was quarantined), the assembler falls back to the truncated raw ID: `"{source[0:8]}"`.

Note: idle-extracted memories (R-E19) have `source` set to the originating thread's ID. They resolve via the `threads` JOIN and display as `thread "{title}"`, not as a special `idle_extract` label. The literal string `"idle_extract"` appears in the `memory_ops` telemetry table (§9.7), not in `semantic_memory.source`. If the originating thread is later quarantined, the resolution falls back to the truncated ID — the thread title is no longer displayed.

### 2.4 Context Assembly Pipeline Amendment

**R-MV11.** The context assembly pipeline (§13.1) shall add a new stage between Stage 5 (ANNOTATION) and Stage 6 (ASSEMBLY):

```
Stage 5.5: VOLATILE ENRICHMENT
  Compute :baseline per R-MV4 fallback chain.

  Compute memory delta:
    SELECT m.key, m.value, m.modified_at, m.source, m.deleted,
           t_src.trigger_spec AS task_name,
           th_src.title AS thread_title
    FROM semantic_memory m
    LEFT JOIN tasks t_src ON m.source = t_src.id
    LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
    WHERE m.modified_at > :baseline
    ORDER BY m.modified_at DESC
    LIMIT 11  -- fetch 11 to detect overflow (show 10 + "N more")

  Compute task run digest:
    SELECT t.trigger_spec, t.last_run_at, t.claimed_by,
           t.consecutive_failures,
           SUBSTR(t.result, 1, 100) AS result_summary,
           h.host_name
    FROM tasks t
    LEFT JOIN hosts h ON t.claimed_by = h.site_id
    WHERE t.last_run_at > :baseline
      AND t.last_run_at IS NOT NULL
      AND t.deleted = 0
    ORDER BY t.last_run_at DESC
    LIMIT 6  -- fetch 6 to detect overflow (show 5 + "N more")

  Inject both into volatile context block.
```

**R-MV12.** The memory delta and task run digest are computed from the LOCAL database state at assembly time. Cross-host visibility depends on sync having delivered the relevant `change_log` events. No additional sync mechanism is introduced — the existing eventual consistency model (R-S2) applies. The volatile context shall NOT annotate entries with sync provenance (the agent doesn't need to know whether a memory entry arrived via local write or sync — it's in the DB, it's current).

### 2.5 Token Budget Expectations

The memory delta and task run digest add variable-length content to the volatile context block. Precise token costs depend on key/value lengths and model-specific tokenization, so hard ceilings are deferred until measurement is available. The following are provisional expectations based on the entry caps in R-MV2 and R-MV7:

- **Memory delta (10 entries):** Expected ~30–60 tokens per entry (key + truncated value + metadata). Rough estimate: ~300–600 tokens at cap.
- **Task run digest (5 entries):** Expected ~30–50 tokens per entry (trigger_spec + outcome + truncated result). Rough estimate: ~150–250 tokens at cap.
- **Combined:** Roughly doubles the existing volatile context block (~300–500 tokens per §9.2), keeping total volatile context well under 1% of a 200k window even at cap.

**R-MV13 (provisional).** If the context budget (§13.1 Stage 7) is critically constrained, the memory delta and task run digest should be truncated to 3 entries each before history truncation is attempted. The exact threshold for triggering this truncation is left to implementation; a reasonable starting point is when remaining headroom after history and response reservation falls below 2,000 tokens.

---

## 3. Interactions & Edge Cases

### 3.1 First Turn in a New Thread

A new thread has no prior messages. The baseline falls back to the thread's `created_at` (per R-MV4). On the very first turn, the agent sees memory entries modified after thread creation — typically nothing (the thread was just created) unless the user created the thread significantly after the last task run.

### 3.2 Long-Idle Threads & Recency Bias

If a thread has been idle for days, the memory delta could be enormous. The 10-entry cap (R-MV2) handles this naturally — the agent sees the 10 most recent changes and a count of how many more exist. For threads idle for weeks, the `... and 147 more` signal tells the agent it should query selectively rather than trying to absorb everything.

The most-recent ordering means that noisy, frequently-updated keys (e.g., a monitoring task that writes 5 keys every hour) may crowd out less frequent but more important changes (e.g., a deploy status change from 6 hours ago). This is an acceptable trade-off for V1 — importance is subjective and ordering by it would require either LLM curation (adding a tool turn) or operator-configured priority weights (adding schema complexity). Recency is deterministic, cheap, and correct more often than not.

### 3.3 Rapid Task Execution

A DAG with 20 `--quiet` leaf tasks completing within seconds could flood the task run digest. The 5-entry cap (R-MV7) and most-recent ordering ensure the agent sees the final summary task, not the intermediate data-gathering steps. DAG architects should use `--quiet` on leaf nodes and let the summary task post normally — this is already the recommended pattern (§6.2).

### 3.4 Memory Oscillation

If two tasks are writing the same key with conflicting values (the "silent oscillation" problem documented in §6.2's write contention rule), the memory delta will show the key flipping between values across turns. This is actually **beneficial** — the oscillation becomes visible in context rather than silently corrupting state. The agent can detect the pattern and alert the operator, whereas today the oscillation is invisible unless the agent happens to query at the right moment.

### 3.5 Redacted Messages and Tombstoned Memories

When a message is redacted (R-E18) and the post-redaction cascade tombstones related memory entries, those tombstones appear in the delta as `[forgotten]` (R-MV3). This ensures the agent in a different thread doesn't continue referencing data that was deliberately purged.

### 3.6 Interaction with Cross-Thread Activity Digest

The memory delta and cross-thread activity digest (R-U30) are complementary:

| Signal | Source | Answers |
|---|---|---|
| Cross-thread digest | `messages` table | "What happened in other conversations?" |
| Memory delta | `semantic_memory` table | "What does the agent know now that it didn't before?" |
| Task run digest | `tasks` table | "What background work ran recently?" |

All three may describe the same underlying event from different angles. For example, a PR monitoring task might produce: a cross-thread digest entry ("PR Monitoring" thread got a new message), a memory delta entry (`monitor.pr-check.known_failing` updated), and a task run digest entry (`pr_check` ran). This redundancy is acceptable — the three signals serve different purposes (narrative, state, outcome) and the agent can synthesize them naturally.

However, during quiescence, `--quiet` tasks produce NO messages and therefore NO cross-thread digest entries. In this regime, the memory delta and task run digest are the ONLY signals. This is the scenario that motivated this RFC.

### 3.7 Cache Impact

The memory delta and task run digest live in the volatile context block, which is already outside the cached prefix (§9.2). Adding content to volatile context does not bust the prompt cache. The stable orientation, conversation history, and system prompt remain cached.

### 3.8 Task Pruning Interaction

Completed tasks are tombstoned after `TASK_RETENTION` (default 7 days, §10.6). The task run digest query filters on `deleted = 0`, so pruned tasks naturally drop out. Similarly, source resolution for memory entries (R-MV10) may fail to resolve a task source if the originating task has been pruned — the assembler falls back to a truncated raw ID in this case.

Recurring tasks that are between runs (`status = 'pending'` with a future `next_run_at`) are NOT pruned (§10.6). Their `last_run_at` persists indefinitely, so a cron task that ran 3 days ago still appears in the digest if the baseline is older than 3 days (e.g., a long-idle thread).

### 3.9 Intra-Loop Delta Advancement

During a multi-turn agent loop (e.g., the agent makes several tool calls before producing a final response), `last_message_at` advances with each persisted message (tool_call, tool_result). The memory delta on Turn N reflects only changes since Turn N-1, not since the user's original message. This means a delta entry visible on Turn 1 (before the first tool call) may not appear on Turn 2 (after the tool result is persisted), because the baseline has advanced past it.

This is correct behavior — the delta is a "what's new since you last looked" signal, not a persistent record. The agent saw the entry on Turn 1 and incorporated it into its reasoning. If the agent needs to reference delta information across tool turns within the same loop, it should act on it immediately or query for the full value. This is consistent with volatile context's existing semantics: cluster topology, context budget, and task counts are also ephemeral and may change between tool turns.

**`await` as a special case.** When the agent calls `await` to block on sub-task completion, the tool_call is persisted (advancing the baseline), the sub-tasks execute (potentially on remote hosts, calling `memorize`), and eventually the tool_result is persisted (advancing the baseline again). Memory entries written by the sub-tasks during the blocking period have `modified_at` timestamps that fall BETWEEN the tool_call and tool_result — after the baseline was last set but before it advances again. On the post-await turn, the baseline is the tool_result timestamp, which is AFTER the sub-task writes. The entries are excluded from the delta.

This means the agent never sees sub-task memory writes in any delta: they didn't exist when the pre-await turn ran, and they predate the post-await baseline. The agent's view of sub-task output comes exclusively through `await`'s return value (`tasks.result`). This is acceptable because `await` is designed as the primary data channel from sub-tasks to the parent loop — `tasks.result` should contain all findings the parent needs to act on. Memory writes from sub-tasks serve cross-run persistence (structured state that survives context truncation), not parent-loop communication.

**System prompt guidance:** Sub-tasks that use `memorize` for structured state should ALSO include their key findings in `tasks.result`. The parent should not depend on the memory delta to discover sub-task output.

### 3.10 Forget-and-Re-Memorize on the Same Key

If a key is forgotten and re-memorized within the same delta window (both `modified_at` values fall after the baseline), both events appear:

```
project.acme.status: [forgotten] (2m ago, source: thread "Acme Planning")
project.acme.status: "completed" (1m ago, source: thread "Acme Planning")
```

These are distinct `semantic_memory` rows (the unique index `ON key WHERE deleted = 0` allows the tombstoned and live rows to coexist) and each consumes one delta slot. Under the 10-entry cap, a bulk key rotation (many forget+re-memorize pairs) could crowd out unrelated changes. This is an acceptable edge case for V1 — a future optimization could coalesce same-key pairs into a single "updated" entry, but this adds assembler complexity for a marginal gain.

---

## 4. Implementation Notes

### 4.1 Query Cost

Both queries (memory delta and task run digest) hit indexed columns:

- `semantic_memory.modified_at` — add index: `CREATE INDEX idx_memory_modified ON semantic_memory(modified_at DESC)`. The index is NOT partial-filtered on `deleted = 0` because R-MV3 requires tombstoned entries in the delta.
- `tasks.last_run_at` — add index: `CREATE INDEX idx_tasks_last_run ON tasks(last_run_at DESC) WHERE deleted = 0 AND last_run_at IS NOT NULL`. The partial filter is safe here because the digest query includes both conditions.

Each query is a bounded `LIMIT 11` / `LIMIT 6` scan on a small table (<1,000 rows typical). Execution time is sub-millisecond on SQLite.

### 4.2 Sync Dependency & Clock Skew

The memory delta reflects LOCAL database state. If a remote host memorized a value 30 seconds ago but sync hasn't run yet, the delta won't include it. This is consistent with the existing eventual consistency model — the agent never sees "the future," it sees what has been synced. No special sync prioritization is needed.

**Clock skew between hosts** can cause synced entries to be temporarily invisible in the delta. The baseline is computed from the local host's clock (via `last_message_at` or `created_at`), but `modified_at` on synced memory entries and `last_run_at` on synced task rows reflect the originating host's clock. When the local host's clock is ahead of the originating host's clock, synced entries may have timestamps that predate the baseline despite representing events that occurred after it in real time.

Example: laptop's clock is 3 minutes ahead of cloud-vm. A cron task on cloud-vm memorizes a value (stamped at cloud-vm's clock). The user sends a message on laptop (stamped at laptop's clock, 3 minutes ahead). The memory entry's `modified_at` is earlier than the baseline, so it's excluded from the delta — even though the memorize happened after the user's message in wall-clock time.

The entry becomes visible once the skew period elapses (i.e., the user sends another message after enough real time has passed for the originating host's timestamp to exceed the baseline). Under the base spec's ±5 minute tolerance (§13.4), entries could be invisible for up to 5 minutes.

This is a fundamental limitation shared with all LWW-based operations in the base spec (R-E4, §8.3). The `X-Clock-Skew` header (§13.4) already alerts operators when skew exceeds 30 seconds. The recommended mitigation is NTP configuration on all hosts, which the base spec already advises. No skew compensation is attempted in the assembler — adjusting timestamps by measured skew is fragile (skew changes over time) and adds complexity disproportionate to the benefit.

### 4.3 Baseline Timestamp Precision

Using `last_message_at` as the baseline means the delta shows everything that changed since the agent's last response in this thread. For rapid multi-turn exchanges (user sends 3 messages in 10 seconds), the baseline advances with each turn and the delta shrinks accordingly. For idle threads, the baseline stays stale and the delta grows. Both behaviors are correct.

### 4.4 Value Truncation

Memory values can be arbitrarily long (the schema imposes no length limit). The context assembler should truncate displayed values at a reasonable length (suggested: 120 characters, with `...` suffix) to prevent a single large JSON blob from consuming the entire delta budget. The full value remains available via `query`.

---

## 5. Requirement Summary

| ID | Summary | Amends |
|---|---|---|
| R-MV1 | Memory delta in volatile context (entries changed since last turn) | §9.2, §13.1 |
| R-MV2 | Cap at 10 entries, most recent first | §9.2 |
| R-MV3 | Tombstoned entries shown as `[forgotten]` | §9.2 |
| R-MV4 | Baseline fallback chain: `last_message_at` → `created_at` (threads), `last_run_at` → `created_at` (tasks) | §9.5 |
| R-MV5 | Delta reads don't update `last_accessed_at` (amends §5.5 comment) | §5.5 |
| R-MV6 | Task run digest via `last_run_at`, global scope, host name resolution | §9.2, §13.1, §5.8 |
| R-MV7 | Cap at 5 task runs, most recent first | §9.2 |
| R-MV8 | `--quiet` tasks appear in run digest | §6.2, §9.2 |
| R-MV9 | Quiescence-suppressed tasks appear in run digest | §9.7 |
| R-MV10 | Source resolution: raw ID → human-readable label via JOINs (quarantine-safe) | §9.2, §12.7 |
| R-MV11 | New Stage 5.5 (VOLATILE ENRICHMENT) in context assembly pipeline | §13.1 |
| R-MV12 | Delta uses local DB state, no new sync mechanism | §8.3 |
| R-MV13 | (Provisional) Truncate to 3+3 entries under context pressure | §13.1 Stage 7 |
