---
title: Durable work recovery
description: Inspect local durable work and redrive dead letters with the workspool sandbox command.
---

Use `workspool` in an agent sandbox to inspect a host's local durable-work spool and redrive dead letters after you have identified a recoverable failure. The command operates only on the current host; durable work is not synchronized between hosts.

## Command reference

List dead-lettered work and pending or processing work older than one hour:

```text
workspool list
```

Set the stale threshold in milliseconds when investigating a crash or stalled consumer:

```text
workspool list --stale-ms 300000
```

Each result includes the row ID, kind, age, idempotency key, claim state, attempt count, last error, and a bounded payload preview. `list` never changes a row.

Redrive one dead letter by ID:

```text
workspool redrive --id ROW_ID
```

Redrive every dead letter of one registered kind:

```text
workspool redrive --kind client_tool --all-dead-lettered
```

A redrive returns the dead letter to `pending`, clears its claim generation, preserves its attempt count, and resets its expiry from the registered kind TTL. It does not directly invoke a handler: the normal consumer claims the row. Rows without a registered kind are rejected because their expiry cannot be determined.

## Operations runbook

Redrive dead letters after a transient outage has ended and you have checked the row's error and payload preview. Inspect stale pending or processing rows after a crash; restart recovery or the owning consumer may resolve them without a redrive.

Do not redrive a row when its payload describes an action that is no longer safe, when the error indicates invalid input or a permanent authorization failure, or before the failed dependency has recovered.

A `not found or already consumed` result is a safe no-op. Consumption retires the row, and a redrive does not recreate it. The durable `(kind, idempotency_key)` fence also prevents duplicate receipt during normal delivery and transfer.

When a passive intake binding has been removed, its durable intake rows become dead letters instead of being discarded. They remain visible to `workspool` and can be redriven after the binding is restored; legacy relay-inbox rows remain mark-processed and retired.

## Roll back new dispatch enqueues

Set `BOUND_DURABLE_DISPATCH=0` (or `false`) before starting Bound to route new dispatch wakeups back to the legacy `dispatch_queue` during a recovery rollback. Durable rows already written remain readable and are drained first; do not delete them to make the rollback take effect. Remove the variable or set any other value to return new enqueues to durable work.

Set `BOUND_DURABLE_INTAKE=0` (or `false`) before startup to route webhook, RSS, and connector intake back to legacy `relay_inbox` writes. Existing durable intake rows remain readable during the transition; remove the variable or set any other value to restore durable intake writes.

Set `BOUND_DURABLE_RELAY=0` (or `false`) before startup to route active relay traffic — requests (remote tool calls, client tools, notification wakeups, platform requests, intake forwards, the inference request, and multi-part `inference_part` requests) AND responses (`result`/`error`/`client_result`/`trace_data`, `stream_chunk`/`stream_end`) — back to legacy `relay_outbox` writes. When enabled (the default), a message travels the durable work spool instead, but only when the toggle is on AND every hop it must traverse advertises spool capability: the final target always, plus the hub when this host is a spoke and the target is not the hub. A capable target reachable only through a non-advertising hub falls back to legacy so nothing strands pending at a spoke. Self-targeted (loopback) requests always stay legacy. Responses and stream chunks carry deterministic dedup keys (`response:<requestId>`, `stream:<streamId>:<seq>`) so a redelivered transfer is fenced, and the requester awaits the union of legacy `relay_inbox` and pending durable response rows targeted at self. Remove the variable or set any other value to restore durable relay writes.

Set `BOUND_TASK_FIRE_MODE` before startup to control how the scheduler produces `task_fire` durable work for due scheduled firings. Three states: `legacy` runs only the in-process phase-1 claim-and-run path, byte-identical to pre-consolidation behavior — the rollback posture; `compare` (the default) runs that same legacy path unchanged and, in addition, records comparison telemetry (a `task_fire_comparison` log line plus the `bound.scheduler.task_fire.comparison` counter) for the would-be durable enqueue decision without writing any durable row; `durable` is reserved for a later release and, until then, warns once per process that durable task firing is not yet available and behaves as `compare`. Any unset or unrecognized value is treated as `compare`. No mode writes an executable `task_fire` row during the comparison window, so the consumer never double-runs a firing.
