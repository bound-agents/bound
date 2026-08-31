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

Set `BOUND_DURABLE_RELAY=0` (or `false`) before startup to route active non-stream relay requests — remote tool calls, client tools, notification wakeups, platform requests, intake forwards, and the inference request itself — back to legacy `relay_outbox` writes. When enabled (the default), a request travels the durable work spool instead, but only when the toggle is on AND every hop it must traverse advertises spool capability: the final target always, plus the hub when this host is a spoke and the target is not the hub. A capable target reachable only through a non-advertising hub falls back to legacy so a request never strands pending at a spoke. Self-targeted (loopback) requests and stream chunks always stay legacy. Remove the variable or set any other value to restore durable relay writes.

Set `BOUND_DURABLE_RELAY=0` (or `false`) before startup to route active non-stream relay RPC requests (tool calls, client tools, notify wakeups, platform requests, the inference request, and hub-forwarded intake) back to legacy `relay_outbox` writes. Durable requests are otherwise written to the work spool and transferred to the target host, which claims and dispatches them; responses always ride back through `relay_outbox` regardless of this toggle. Requests only take the durable path when every hop — the final target, plus the hub when this host is a spoke and the target is not the hub — advertises work-spool capability; a capable target reachable only through a non-advertising hub falls back to legacy so no request strands pending at a spoke. Existing durable request rows remain readable during the transition; remove the variable or set any other value to restore durable relay writes.
