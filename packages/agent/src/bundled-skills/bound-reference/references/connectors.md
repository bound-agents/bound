# Connectors Reference

A **platform connector** is how bound talks to an outside event source — Discord
is the one shipped today, but the mechanism is general. Connectors are *in-process
MCP servers*: bound runs them inside its own process and reaches their tools the
same way it reaches any MCP server. What makes them connectors rather than plain
MCP servers is that they emit **events** you can subscribe to, and those
subscriptions wake bound tasks.

If you are reading this because an event woke you and you are not sure where the
message came from or what you are allowed to do with it, the short version is at
the bottom under "When an event wakes you."

## The `connector` tool

One native tool drives the whole subsystem. It dispatches on an `action`:

- **`list`** — discover connector servers across the cluster. No other args.
- **`channels`** — list the events a server emits, annotated with any
  subscriptions already bound to them. Requires `server_name`.
- **`attach`** — subscribe to an event stream. Requires `server_name`,
  `event_name`, and `event_args` (the subscription filter, e.g.
  `{ channel_id: "123" }`).
- **`detach`** — unsubscribe. Requires `handle_id`.

`list` and `channels` are read-only discovery; `attach` and `detach` mutate
subscriptions.

## Connector handles

A subscription is a row in the `connector_handles` table (synced, LWW). The
handle's id is **derived deterministically** from `(server_name, event_name,
event_args)`, which is what makes `attach` idempotent — attaching the same
triple twice returns an "already exists" error rather than creating a duplicate.
Query the table directly when you want to see live subscriptions:

```sql
SELECT id, server_name, event_name, event_args, delivery_mode, task_id
FROM connector_handles WHERE deleted = 0;
```

## What `attach` actually does

A single `attach` call performs four writes, in order:

1. Creates a **thread** (`interface = "platform"`, titled `server:event`) to hold
   that subscription's conversation, with history retention on.
2. Creates an **event task** (`type = "event"`, `trigger_spec =
   connector:event:<handleId>`) linked to that thread. The per-handle
   `trigger_spec` is the routing key: only *this* task wakes when *this* handle
   delivers.
3. Creates the **connector handle** linking server, event, args, and the task.
4. **Activates** the subscription on the platform leader (see below). If the
   current host is the leader, activation happens immediately; otherwise the
   handle syncs to the leader via the change log and a `connector:handle_synced`
   event activates it there.

So one `attach` gives you a dedicated thread + a dedicated task + a handle, all
wired so deliveries on that stream land as wakeups on that one task.

## Tool scoping — two branches

Whether you can see a connector's *write* tools depends on how you were spawned:

- **Event-task threads** (the ones `attach` creates) get the **scoped tool set**
  for their bound server, resolved via `getToolsForThread(threadId)`. A thread
  genuinely operating a Discord subscription gets Discord's send/react/etc.
  tools.
- **Every other thread** gets only the **read-only** platform tools (those whose
  MCP annotations mark `readOnlyHint === true`) plus the `connector` tool itself.

This is why a general chat thread can `list`/`channels`/`attach` but does not
carry, say, `discord_send_message`: it is not bound to that event stream. If you
find yourself wanting a connector write tool you do not have, check whether you
are actually the event-bound thread for that stream — usually you are not, and
the right move is to route through the thread that is.

## Connector-authored instructions

bound makes **no claims** about what a connector's tools do or how to use them.
Instead, a connector can carry its own orientation prose in the MCP server-level
`instructions` field, and bound surfaces that text verbatim to threads bound to
that connector. (Discord, for example, declares its markdown dialect and the
2000-character message limit this way.)

Two consequences worth internalizing:

- If you are an event-bound thread, **read the connector instructions in your
  context** — they are the connector's own guidance, not bound's, and they are
  the authoritative word on that platform's quirks.
- The instructions are scoped to event-bound threads only. A general thread with
  incidental read-only tools gets none; its tool descriptions are its orientation.

## Leader election

Only one host in the cluster runs the *active* subscriptions for a given
platform, chosen by leader election through `cluster_config`
(`platform_leader:<platform>`). Hosts that lose the race enter standby and poll;
if the leader's heartbeat goes stale past the failover threshold, a standby
promotes itself and reconnects all subscriptions. This is why `attach` from a
non-leader host writes the handle and lets it sync to the leader rather than
opening a socket locally.

## Webhooks — the adjacent path

Inbound HTTP events (GitHub, Stripe, Slack, raw) are a *related but distinct*
ingestion path, not the `connector` tool. They arrive at `POST /webhook/:name`
on the sync server, get HMAC-validated, land in `relay_inbox` as a passive
`webhook_intake` row, emit a `connector:event`, and the scheduler folds the
envelope into the woken task's wakeup `tool_result`. Dedup uses the platform's
delivery header (e.g. `X-GitHub-Delivery`). You consume a webhook event the same
way you consume a connector event — it shows up as a wakeup — but you do not
`attach` to it; the operator registers the webhook out of band.

## When an event wakes you

1. The payload that woke you is in your `tool_result` context (the scheduler
   folds it in via the event wakeup). Read it there — do not go hunting in the
   database first.
2. If a connector authored instructions, they are in your context too. Treat
   them as authoritative for that platform's formatting and limits.
3. You have the scoped tools for that stream because you are the event-bound
   thread. Use them to respond.
4. To inspect or change subscriptions, use the `connector` tool; to see live
   handles, query `connector_handles`.
