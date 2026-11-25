---
title: Web UI reference
description: Look up the purpose, contents, and related documentation for each Bound web UI view.
---

The Bound web UI runs on the web server, which defaults to
`http://localhost:3001`. Its top navigation has nine views: **System Map**, **Timetable**,
**Network**, **Advisories**, **Files**, **Connections**, **Metrics**, **Persona**, and
**Models**.
**Line** is the separate conversation view that opens on entering an individual thread.

## Line

**Purpose:** Work in an individual conversation.

**Contains:** The thread's messages, live activity, and interaction surface. Threads opened
from **System Map** appear here.

Use the pencil beside the header title to rename the thread. Enter or leaving the field saves
it, Escape cancels, and a blank or unchanged title leaves the thread as it was.

Each user-role message is labelled with its sender: the display name stamped when the message
was sent, else the thread owner's display name from the allowlist, else **You**. In an
auxiliary child thread, instructions dispatched by the main agent are labelled **agent**
instead of the operator's name.

The composer stages multiple attachments, including images pasted from the clipboard, then
sends them together. Press Escape with an empty input to clear staged attachments. Auxiliary
invocations show a live running card while the web UI is connected. That card is transient:
a client connecting after an invocation begins sees the completed result once it lands.

### Yard execution graphs

Yard runs render as interactive inline execution trees that can be panned and zoomed. Active
trees update live while a run is in flight; completed trees rebuild on reload, while older
results keep a compact final card.

Straight-line `yield` expressions form the execution chain and finish at a **Result**
terminus. `sequence([...])` children show source ordinals; `all([...])` children run in
parallel and show a `×N` tag. Yields inside conditionals, loops, and `try` blocks render as
dynamic regions rather than guaranteed steps.

Nodes show **Pending**, **Running**, **Complete**, **Failed**, or **Settled** status.
Select a node to open the inspector below the canvas with its source details and formatted
values. Press Escape or click the canvas to close the inspector.

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

**Related documentation:** [Sandbox and filesystems](/bound/concepts/sandbox/) explains how
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

- **Cost timeline:** Spending over time by model, split into input, output, cache-read, and
  cache-write components.
- **Token charts:** Input, output, cache-read, and cache-write tokens.
- **Providers:** Turns, tokens, cost, and errors per configured provider, with each
  provider's share of turns and cost. The provider comes from the turn's route
  (`site:provider:backend`), summed across hosts and backends. Turns recorded without a
  route are counted under `unattributed`.
- **Cache hit timeline:** Prompt-cache hit rate over time.
- **Latency:** Response latency by model.
- **Relay cycles:** Cross-host relay timing and success rates.

Per-component costs come from each turn's recorded cost breakdown captured at pricing time,
so they are exact for turns priced by a catalog, static operator pricing, or a
component-returning `price(turn)` callback. Older turns and turns priced by a plain-number
callback carry no breakdown and split their total proportionally by token count.

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

## Models

**Purpose:** Manage cluster-wide model routing preferences and inspect per-host route supply.

**Contains:** A searchable, alphabetical list of logical models, each labeled with its display name,
route and host counts, and a health dot. Display names come from the provider catalog, then
`models.dev`, then the raw provider model ID, with the highest-precedence source winning when routes
disagree. Models that would share a name append their snapshot suffix in parentheses, such as
`GPT-4o (2024-08-06)`. The health dot is green when a preferred route is healthy, amber when the
model is serving through a fallback route, and gray when no route is available or no host has
reported the route's health.

Selecting a model opens a detail pane listing its routes in preference order as
`provider:model on host` (for example, `zai:glm-5.3-flash on MSI`). Each route shows its read-only
automatic health status (such as `Backing off, retrying in 4m`), up and down controls for route
order, and an **Enabled** toggle that excludes the route when turned off. A route listed in the
order that no host currently advertises appears as **Unavailable** with a **Remove** button. The
**Fallback policy** selector sets how the model handles refusals: **Cluster default**, **Custom
list**, or **Never fall back**.

The **Roles & aliases** section maps the built-in `default`, `heavy`, and `fast` roles and custom
alias names to available cluster models.

Route health belongs to the host that serves the route. That host records the outcome of every
call it makes to the provider, including calls it runs for other hosts, and the page shows that
host's view. For a route on another host, the host serving the page asks it over the cluster's
authenticated sync connection, with a 4-second limit per host. It reuses an answer for 15 seconds
and discards it after 60 seconds. A route reads `Health not reported` when its host has not sent a
heartbeat in 5 minutes, did not answer in time, does not list the route, or last answered more
than 60 seconds ago. A recent heartbeat on its own never marks a route healthy, and a missing
answer never marks it failed. The page re-reads health every 30 seconds while open, and the model
picker re-reads it each time it opens and every minute. These reports only drive the display:
they never change how this host routes requests, and they are not synced. Route order, enabled
routes, fallback policies, and alias mappings are cluster-synced, so an edit on any host applies
everywhere.

**Related documentation:** [Inference and model routing](/bound/concepts/inference/) explains
route ranking, health recovery, drains, stickiness, and refusal fallback. [State, consistency,
and multi-host operation](/bound/concepts/sync/) explains cluster-wide state visibility.
