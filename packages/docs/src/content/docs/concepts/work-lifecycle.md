---
title: Work lifecycle and reliability
description: How Bound moves work from intake through execution, state replication, and completion.
---

The stages below are a common way to analyze Bound work; they describe the full path a
source can take, and any given source runs the subset that applies to it. Depending on the source, Bound may validate and authorize a
trigger, deduplicate it where supported, persist or enqueue durable work, select a host,
run an agent loop, call a model and tools, and persist the result. Selected state can
replicate to other hosts, while each source defines its own completion, failure, and retry
behavior.

See [System model](/bound/concepts/system-model/) for the components involved,
[Agent system](/bound/concepts/agent-system/) for the loop and scheduler, and
[Sync and multi-host behavior](/bound/concepts/sync/) for selected-state replication and
commit timing.

## Stages

1. **Trigger.** A message, scheduled deadline, external event, invocation, or API request
   asks Bound to do work.
2. **Validate and authorize.** The intake path checks the request and applies its available
   authorization rules.
3. **Deduplicate where supported.** Some intake paths recognize a stable source identifier;
   others do not provide that boundary.
4. **Persist or enqueue.** Bound records the message, task, or invocation state and makes the
   work available to run.
5. **Claim or route.** The scheduler or intake path selects a host to own the loop. This
   host is the **loop host**.
6. **Run the agent loop.** The loop host builds context and runs the agent.
7. **Call the model and tools.** Individual model and tool operations can be local or relayed;
   only those operations relay, while the agent loop remains with the loop host.
8. **Persist the result.** The loop records its response and relevant task or invocation
   state.
9. **Replicate selected state.** In a cluster, selected state follows the behavior described
   in [Sync and multi-host behavior](/bound/concepts/sync/).
10. **Complete, fail, or retry.** The outcome follows the behavior of the source that created
    the work.

The Responses API is outside these durable scheduler stages. It handles a stateless model
request, and the caller manages conversation state and retries.

## Source comparison

| Source | Durable Bound work? | Ownership | Deduplication | Retry or delivery note |
| --- | --- | --- | --- | --- |
| Interactive message | Yes; the message is recorded in its thread. | Receiving host is the loop host. | None. | Runs one turn per recorded message. |
| Scheduled or deferred task | Yes; the scheduler wakes recorded work. | Task claiming selects the loop host. | Claimed once per due firing. | Controlled by the task schedule and retry policy. |
| Webhook | Yes; a valid HTTP event wakes linked work. | Selected host is the loop host. | Delivery ID headers when present. | Delivery retries depend on the sending service. See [Webhooks](/bound/guides/webhooks/). |
| RSS feed | Yes; polling discovers an item and wakes work. | Selected host is the loop host. | Bounded recent-ID cursor (first poll seeds). | Delivery depends on polling. See [RSS feeds](/bound/guides/rss-feeds/). |
| Connector event | Yes; an external event wakes work. | Selected host is the loop host. | Platform-dependent. | Local durable intake with 15-minute reconciliation. |
| Auxiliary invocation | Yes; the main agent starts foreground or background work. | Selected host is the loop host. | None. | Work may restart from its initial input after interruption. See [Auxiliary agents](/bound/concepts/auxiliary-agents/). |
| Responses API | No. | Caller owns conversation state; there is no durable loop host. | Caller-managed. | Caller-managed. |

## Reliability boundaries

Intake deduplication and single-host claiming reduce duplicate execution, but they do not
guarantee exactly-once external side effects. Retry and delivery semantics vary by source.

Make automation idempotent. In particular, tools that create, send, charge, or update an
external resource should tolerate a repeated request and use a stable external idempotency
key when the target supports one.
