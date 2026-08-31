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

## Roll back new dispatch enqueues

Set `BOUND_DURABLE_DISPATCH=0` (or `false`) before starting Bound to route new dispatch wakeups back to the legacy `dispatch_queue` during a recovery rollback. Durable rows already written remain readable and are drained first; do not delete them to make the rollback take effect. Remove the variable or set any other value to return new enqueues to durable work.
