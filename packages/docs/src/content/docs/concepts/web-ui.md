---
title: Web UI reference
description: Look up the purpose, contents, and related documentation for each Bound web UI view.
---

The Bound web UI runs on the web server, which defaults to
`http://localhost:3001`. Its top navigation has eight views: **System Map**, **Timetable**,
**Network**, **Advisories**, **Files**, **Connections**, **Metrics**, and **Persona**.
**Line** is the separate conversation view that opens when you enter an individual thread.

## Line

**Purpose:** Work in an individual conversation.

**Contains:** The thread's messages, live activity, and interaction surface. Yard runs render as
interactive inline execution trees: nodes update from the lifecycle stream, show running,
completed, or failed status, and can be panned or zoomed. The tree stays under its originating
Yard call when that call is available; a tree that arrives first remains safely at the end of the
conversation. Execution trees are live-only: lifecycle events are not persisted or replayed, so
reloading or reconnecting during a run shows only events received after the connection resumes.
Threads opened from **System Map** appear here.

**Related documentation:** [Agent system](/bound/concepts/agent-system/) explains how a
thread advances through the agent loop. [Work lifecycle](/bound/concepts/work-lifecycle/)
explains the states around active and interrupted work.

## System Map

**Purpose:** Find and inspect conversations and memory relationships.

**Contains:** Thread search, live activity, thread creation, inline thread renaming, links into
**Line**, and an interactive memory graph. Use the pencil beside a thread's timestamp to edit its
title; Enter or leaving the field saves it, while Escape cancels.

**Related documentation:** [System model](/bound/concepts/system-model/) explains the place
of threads in Bound. [Memory and knowledge graph](/bound/concepts/memory/) explains the
memory relationships shown here.

## Timetable

**Purpose:** Inspect scheduled and event-driven work.

**Contains:** Cron, deferred, event-driven, and heartbeat tasks; status filters; and
expandable scheduling and execution details.

**Related documentation:** [Work lifecycle](/bound/concepts/work-lifecycle/) explains task
execution and recovery boundaries. [Agent tools](/bound/reference/agent-tools/) documents
the task actions available to the agent.

## Network

**Purpose:** Inspect the multi-host deployment.

**Contains:** Hosts, synchronization state, connectivity, and advertised models—the models
each host reports it can serve through its configured backends.

**Related documentation:** [State, consistency, and multi-host
operation](/bound/concepts/sync/) explains replication and relay. [Inference and model
routing](/bound/concepts/inference/) explains advertised models, and [Security
boundaries](/bound/concepts/security-boundaries/) explains the cluster trust boundary.

## Advisories

**Purpose:** Review operational findings and their current state.

**Contains:** Advisories in `proposed`, `approved`, `applied`, `dismissed`, or `deferred`
state. State changes require a note.

**Related documentation:** [Work lifecycle](/bound/concepts/work-lifecycle/) explains how
operational state relates to ongoing work. [Agent tools](/bound/reference/agent-tools/)
documents advisory actions available to the agent.

## Files

**Purpose:** Browse the agent's durable virtual files.

**Contains:** A browser and preview for the replicated virtual filesystem.

**Related documentation:** [Sandbox and filesystem](/bound/concepts/sandbox/) explains how
these files differ from files exposed by a terminal client.

## Connections

**Purpose:** Manage external event sources, reusable instructions, and MCP capabilities.

**Contains:** Five sections with connection-specific controls:

| Section | Contains | Related documentation |
| --- | --- | --- |
| **Webhooks** | Controls for creating endpoints, inspecting deliveries, rotating secrets, and changing whether unauthenticated webhooks are permitted cluster-wide | [Manage webhooks](/bound/guides/webhooks/) and [Security boundaries](/bound/concepts/security-boundaries/) |
| **RSS feeds** | RSS or Atom subscriptions, polling settings, and task behavior | [Manage RSS feeds](/bound/guides/rss-feeds/) |
| **Connector bindings** | Platform event subscriptions, backing tasks, model settings, and detach controls | [Agent system](/bound/concepts/agent-system/) |
| **Skills** | Skill import, inspection, and removal | [Manage skills](/bound/guides/manage-skills/) and [Skills and activation](/bound/concepts/skills/) |
| **MCP servers** | Connected MCP servers, their tools, and the host that owns each connection | [Agent tools](/bound/reference/agent-tools/) and [System model](/bound/concepts/system-model/) |

Allowing unauthenticated webhooks weakens the default request-authentication boundary. Review
the [security guidance](/bound/concepts/security-boundaries/) before enabling it.

## Metrics

**Purpose:** Inspect inference cost, token use, caching, latency, and relay behavior over a
selected time range.

**Contains:** A time-range selector and:

- **Cost timeline:** Spending over time by model.
- **Token charts:** Input, output, cache-read, and cache-write tokens.
- **Cache hit timeline:** Prompt-cache hit rate over time.
- **Latency:** Response latency by model.
- **Relay cycles:** Cross-host relay timing and success rates.

The view refreshes automatically when the selected range includes the current time.

**Related documentation:** [Inference and model routing](/bound/concepts/inference/)
explains provider requests and prompt caching. [State, consistency, and multi-host
operation](/bound/concepts/sync/) explains relay roles.

## Persona

**Purpose:** Inspect and edit the agent's shared persona.

**Contains:** A Markdown editor for the cluster-wide persona, capped at 64 KB. Changes are
used by later turns and synchronize to other hosts according to the cluster state model.

**Related documentation:** [Configuration reference](/bound/reference/configuration/) covers
configuration lookup, and [State, consistency, and multi-host
operation](/bound/concepts/sync/) explains cluster-wide state visibility.
