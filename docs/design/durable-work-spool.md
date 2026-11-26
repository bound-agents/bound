# Durable work spool and recovery

Internal operations and recovery design for the host-local `durable_work` spool and the `workspool`
sandbox command. For the architecture spec, see
`docs/design/specs/2026-08-31-durable-work-consolidation.md`.

## `workspool` command

Use `workspool` in an agent sandbox to inspect a host's local durable-work spool and redrive dead
letters once a recoverable failure has been identified. The command operates only on the current
host; `durable_work` is local-only and never synchronized between hosts.

```text
workspool list [--stale-ms MS]
workspool redrive --id ROW_ID
workspool redrive --kind KIND --all-dead-lettered
workspool purge --kind KIND --dead-lettered [--older-than MS]
workspool purge --all-unclaimed [--older-than MS] [--force]
```

- **`list`** surfaces dead-lettered rows, stale `pending`/`processing` rows older than the
  threshold (default 1 hour), and `transferring` rows older than the threshold (wedged spool
  transfers whose acknowledgement never returned). Output includes row ID, kind, age, idempotency
  key, claim state, attempt count, last error, and a bounded payload preview. Read-only.
- **`redrive`** returns a row to `pending` and clears its claim generation.
  - A dead letter keeps its attempt count and resets its expiry from the registered kind TTL; the
    normal consumer claims the row, and rows without a registered kind are rejected.
  - A stale `transferring` row is reclaimed the same way, except it charges one attempt and
    respects the attempt cap (dead-lettering if already at the cap). No registered-kind gate
    applies because the row carries the RPC TTL its producer set.
- **`purge`** physically deletes rows from `durable_work` and reports the deleted count. It reaches
  every target, including peer-targeted dead letters (`result`, `inference`, `platform_request`,
  `cancel`, `client_tool`). Both selectors accept `--kind`:
  - `--dead-lettered` removes terminally-classified dead letters of any target (`--older-than` has
    no minimum floor).
  - `--all-unclaimed` removes dead letters and unclaimed `pending` rows while leaving `processing`,
    `transferring`, and `consumed` rows untouched. Without `--force`, it enforces a 1-hour minimum
    age floor and limits pending-row deletion to `local`-targeted wakeups (preserving peer-targeted
    pending rows queued for offline peers). `--force` lifts both safeguards.

Periodic prune removes dead letters after seven days and never age-purges pending work.

## Recovery mechanics

### Local intake reconciliation

After a 15-minute grace window, every host reconciles its own local RSS, webhook, and connector
intake. A live binding is re-emitted locally as an event wakeup; repeated emissions are safe
because the scheduler claims the task once and marks intake processed only after its wakeup is
durable. Orphaned intake for a deleted feed or connector handle is dead-lettered. This local
recovery is not leader-gated, so a host that has since lost connector leadership still drains
intake it accepted.

Rows targeted `local` (dispatch wakeups) are consumed in-process by the owning host and are never
spool-transferred to a peer. Startup recovery resets any `local`-targeted row found in
`transferring` back to `pending` and logs a `[recovery]` warning with the row count. Peer-targeted
`transferring` rows are left untouched at boot so the sender resumes them with its retained token
on reconnect.

### Transfer recovery and dead-socket detection

A peer-targeted row can wedge at `transferring` while the process keeps running if a
`SPOOL_TRANSFER` frame is sent and its `SPOOL_TRANSFER_ACK` never returns. The sync transport's
periodic sweep (every 30 seconds, and on every peer reconnect) runs four recovery mechanisms:

- **Terminal expiry:** Runs first and unconditionally. Any non-dead-lettered row past its
  `expires_at` (`transferring`, `pending`, or `processing`) becomes a seven-day redrivable dead
  letter so short-TTL rows surface in `workspool list`.
- **Transfer reclaim:** Returns a still-live `transferring` row older than 30 seconds (measured
  from `claimed_at`) to `pending`, charges one attempt, and re-drives every live peer. Rows at the
  attempt cap dead-letter instead of requeuing. Stale `processing` rows are not reclaimed
  automatically because the owning consumer may still be running.
- **Flip only when sendable:** A row transitions `pending` to `transferring` only for a send that
  reaches the socket. If the channel is backpressured or the send is refused, the generation rolls
  back to `pending` without charging an attempt. Because client WebSockets lack a `drain` event,
  every send re-polls the live buffer and the receive-liveness timer clears any stale backpressure
  latch.
- **Buffer-stall persistence and reconnect auto-redrive:** A spoke socket can appear `OPEN` while
  dead over TCP, queueing frames in the client buffer without throwing. A 30-second stall detector
  force-closes a socket whose buffer stays non-zero and non-decreasing across two consecutive checks
  (~60 seconds) without backpressure. On peer reconnect, any dead letter targeted at that peer with
  `last_error` of `transfer retries exhausted (no SPOOL_TRANSFER_ACK)` from the last 15 minutes is
  automatically returned to `pending` with its attempt count reset to zero (capped at three
  reclassifications per row via `reclassify_count`).

### Receiver fault classification

- **Validation failure** (malformed identity field or non-JSON payload): skipped and logged per
  entry without poisoning the batch or closing the connection. Good siblings insert and ack; the
  malformed entry goes unacked and hits the sender's normal retry cap.
- **Local storage failure** (disk full, corruption, schema drift, closed database, constraint
  breach): escapes to the WebSocket server dispatch handler, which closes the connection with code
  `1011`.

### Terminal TTL clamping

A durable request or response row's terminal TTL (`expires_at`) is never shorter than its kind's
registry-declared TTL (300 seconds for RPC request kinds), keeping short caller timeouts from
expiring before transfer reclaim can run. Longer caller-supplied TTLs and kinds without a declared
TTL keep the caller's value verbatim.

## Rollback and startup gates

- **`BOUND_DURABLE_DISPATCH=0` (or `false`):** Routes new dispatch wakeups back to the legacy
  `dispatch_queue`. Existing durable rows remain readable and drain first. Relay and intake work
  always write to `durable_work`; non-advertising peer hops raise a typed routing error.
- **Scheduled task fire:** The scheduler always fires due tasks through a `task_fire` durable-work row with a 5-minute TTL (`RPC_REQUEST_TTL_MS`).
- **Startup refusal on populated legacy relay tables:** If a leftover `relay_outbox` or
  `relay_inbox` table exists at boot, Bound classifies rows per table into consumed
  (`delivered`/`processed = 1`), expired (`= 0` and valid ISO 8601
  `datetime(expires_at) <= datetime(now)`), and live (`total - consumed - expired`, including
  `NULL`/malformed rows). Tables with zero live rows are dropped with a warning; tables with live
  rows refuse startup and print the exact SQL inspection query built from the same predicates.
