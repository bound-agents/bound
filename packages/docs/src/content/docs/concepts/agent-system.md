---
title: Agent system
description: How Bound turns triggers into model decisions, tool calls, and persisted conversation state.
---

Bound presents one persistent agent across threads and interfaces. This page explains the
loop that advances that agent and the kinds of capabilities the loop can use. For the
larger architectural picture, see the [system model](/bound/concepts/system-model/).

## The agent loop

A trigger starts or resumes work on a thread. The trigger can be a user message, scheduled
work, or an external event. The loop then:

1. Assembles the thread's conversation, relevant memory, active skills, and live state.
2. Resolves a model and sends it the assembled context.
3. Interprets the model response as either a reply or one or more tool calls.
4. Executes each requested tool, adds its result to the conversation, and asks the model for
   the next decision. Steps 3 and 4 repeat while the model requests more tools.
5. Exits the decision cycle when the model returns a reply without another tool call, then
   persists the resulting messages and state before the turn becomes idle.

The loop host coordinates this cycle. [Inference routing](/bound/concepts/inference/) and
tool routing can place individual operations on another host without moving the loop itself.

## Tool categories

Bound combines several sources of tools in one registry:

- **State and coordination tools** work with memory, tasks, advisories, threads, and host
  information.
- **Agent extension tools** activate skills or delegate bounded work to
  [auxiliary agents](/bound/concepts/auxiliary-agents/).
- **Integration tools** come from platform connectors and Model Context Protocol (MCP)
  servers.
- **Client tools** are supplied by a live client session, such as the file and shell tools
  exposed by the `boundless` terminal client.

Which tools a turn receives depends on its interface, thread context, connected services,
and capability boundaries. See [Agent tools](/bound/reference/agent-tools/) for tool names,
actions, and parameters.

## Scheduled and event-driven turns

Recurring, deferred, and event-driven tasks all trigger the same agent loop. Once triggered,
they follow the same model-decision, tool-call, and tool-result cycle as a user message.

External events enter through integrations such as [webhooks](/bound/guides/webhooks/),
[RSS feeds](/bound/guides/rss-feeds/), and platform connectors. Connectors can also
contribute scoped tools appropriate to the receiving thread.

Task dependencies, scheduling, claiming, interruption, and recovery are lifecycle concerns
rather than parts of the model's decision cycle. See the [work
lifecycle](/bound/concepts/work-lifecycle/) for those boundaries and guarantees.

## Persistence and distribution

Conversation and tool results are durable Bound state; host-local capabilities remain tied
to the host or client that provides them. See [State, consistency, and multi-host
operation](/bound/concepts/sync/) for how durable state and remote capabilities cross host
boundaries.
