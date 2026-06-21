# Trace Query Map

Bound's operational tables form a coarse distributed trace at turn granularity. Reconstructing "who ran what, where, and why" across the cluster is possible through the read-only `query` tool — the join paths just aren't written down anywhere, so each investigation re-derives them by hand.

This file is the map. Use it instead of reverse-engineering the schema each time.

## Canonical join keys

- **`thread_id` is the spine.** `threads.id` = `turns.thread_id` = `messages.thread_id` = `tasks.thread_id` = `client_sessions.thread_id`. Everything that happened in one conversation hangs off this column.
- `turns.task_id` → `tasks.id` — which task spawned a turn (null for interactive turns).
- `turns.dag_root_id` — groups all turns in one fan-out DAG. Parallel and chained tasks share a root.
- `tasks.origin_thread_id` — the thread that created a task. `tasks.depends_on` — task-to-task dependency. `tasks.thread_id` — where the task runs.
- `messages.tool_name` + `messages.exit_code` — tool invocations and outcomes within a thread.
- `turns.host_origin` + `turns.relay_target` — which host ran inference and where it relayed (cross-host).
- `client_sessions.thread_id` + `site_id` + `connection_id` (filtered on `deleted = 0`) — which host holds the live boundless/web attachment for a thread.

These are join keys by convention (CRDT-synced tables), not enforced foreign keys. Invariant #20: no FK constraints on synced tables, because replay inserts rows out of order.

## Common questions → queries

**What did this conversation cost?**

```sql
SELECT SUM(cost_usd), SUM(tokens_in + tokens_out)
FROM turns WHERE thread_id = ?;
```

**Which tasks spawned work in this thread?**

```sql
SELECT * FROM tasks
WHERE thread_id = ? OR origin_thread_id = ?;
```

Join `turns ON task_id` to see which turns each task produced.

**Is a thread attached to a live session, and where?**

```sql
SELECT site_id, connection_id FROM client_sessions
WHERE thread_id = ? AND deleted = 0;
```

The `site_id` maps to a host via the `hosts` table.

**Trace a fan-out (parallel/chained task DAG).**

```sql
SELECT * FROM turns WHERE dag_root_id = ?;
```

Follow the `depends_on` chain in `tasks` for task-level dependencies.

**Which host ran this turn, and did it relay?**

```sql
SELECT host_origin, relay_target, relay_latency_ms
FROM turns WHERE thread_id = ?;
```

`relay_target` is null when inference ran locally; non-null means it was delegated to a remote host.

**What tools ran, and which failed?**

```sql
SELECT tool_name, exit_code, created_at FROM messages
WHERE thread_id = ? AND tool_name IS NOT NULL
ORDER BY created_at;
```

`exit_code != 0` (or null) means the tool failed.

**What model ran each turn?**

```sql
SELECT model_id, cost_usd, tokens_in, tokens_out, created_at
FROM turns WHERE thread_id = ?
ORDER BY created_at;
```

## Scope boundary

The trace stops at the turn edge. Within a single turn there's no sub-step causality or timing — which tool call ran first, how long each took. The envelope is one turn = one inference call + its tool executions. Finer-grained spans live in OpenTelemetry traces (when tracing is configured), not in the database.
