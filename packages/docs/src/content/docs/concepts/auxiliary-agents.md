---
title: Auxiliary Agents
description: Scoped side identities with their own memory namespace, invoked to run errands without dragging the main agent's context along.
---

An auxiliary agent is a durable, named identity the main agent can hand an errand to. It runs in its own thread with its own memory namespace, reports back a result, and the conversation is thrown away. The identity persists; each invocation is ephemeral.

This exists because subagents don't map cleanly onto bound's threading model. Every ordinary thread is a *view* of one agent that spans all of them — same identity, same memory, peers by construction. A subagent breaks that: it takes instructions from another instance of itself and gets discarded when it's done, which is not a peer relationship. Auxiliary agents make that authority split explicit instead of pretending it isn't there.

## Identity, not job description

The persona says who the aux **is** — temperament, working style, standing habits. It does not say what the aux is for. The job arrives per-invocation in `instructions`.

That split is what makes an identity reusable. An aux defined as "brief and methodical; investigates a narrow question and reports what it found and what it couldn't find" can be handed a dozen unrelated errands. An aux defined as "the agent that audits our CI logs" can only ever do that one thing, and you end up with a sprawl of near-duplicate identities.

## The aux tool

The agent manages auxiliary agents through the `aux` tool:

| Action | What it does |
| --- | --- |
| `define` | Create a new identity |
| `update` | Change an existing identity's persona, tools, or model |
| `retire` | Retire an identity — drops from `list`/`invoke`, memory stays readable |
| `list` | Show active identities |
| `invoke` | Hand an errand to an identity and wait for the result |

### define

| Parameter | Required | Notes |
| --- | --- | --- |
| `name` | Yes | kebab-case, matching `^[a-z0-9]+(-[a-z0-9]+)*$`, up to 64 chars |
| `persona` | Yes | Non-empty, up to 8192 chars |
| `tools` | No | Allowlist of tool names. Omit for unrestricted (structural denials still apply) |
| `model_hint` | No | Default model for this identity |

Defining over an existing active name fails rather than silently overwriting it — an identity-sprawl guard. Use `update` to change one, or pick a different name.

### invoke

| Parameter | Required | Notes |
| --- | --- | --- |
| `name` | Yes | Must be an active (non-retired) identity |
| `instructions` | Yes | The errand — what to do this invocation |
| `model` | No | Override the definition's `model_hint` for this call only |

`invoke` is synchronous. It creates the child thread, seeds the instructions, runs the nested loop to completion, and returns the aux's final response as the result. The main agent's turn blocks until the aux finishes.

### retire

Retiring is domain state, not deletion. The identity drops out of `list` and can no longer be invoked, but its memory namespace stays readable to the main agent — a retired aux's findings don't evaporate. Retiring an already-retired identity is a no-op, not an error. A later `define` under the same name starts a genuinely fresh identity.

## Memory namespaces

Every memory entry carries an owning identity. The main agent's entries have no owner; an aux's entries are tagged with its identity. Key uniqueness is per-namespace, so two auxes can both store `findings` without colliding.

The visibility rule is deliberately asymmetric:

- An **aux cannot read the main agent's memory.** It only sees its own namespace.
- The **main agent can read and write any aux's memory**, by passing `agent_name` to the `memory` tool.

```json
{ "action": "search", "key": "findings", "agent_name": "scout" }
```

The asymmetry is the point. A memory written from the main agent's vantage can mean something different read from a subordinate one — a workflow note that ends in "then discard yourself" is coherent for the aux and alarming for the leader. Walling the aux off keeps its context small and its framing consistent; leaving the main agent's view unrestricted means nothing an aux learns is lost to you.

Passing `agent_name` while already running as an aux is ignored, not honored — an aux can't reach a sibling's namespace by naming it.

## Capability boundary

An aux never receives the orchestration tools, regardless of its allowlist:

`aux` · `task` · `cancel` · `notify` · `introspect`

No aux can define or invoke another aux, schedule work, or message other threads. Delegation is one level deep by construction, and the main agent stays the only scheduler. An explicit `tools` allowlist narrows things further from whatever remains.

## Threading

An aux invocation creates a child thread with a strict parent relationship: it records the dispatching thread as its parent and inherits that thread's owning user, so archival and deletion cascade naturally from parent to children. The thread is tagged with the `aux` interface and titled `aux: <name>`.

The seeded instructions arrive as a user-role message marked as sent by the main agent, so the aux can distinguish an errand dispatched by the leader from a message sent by a human.

Concurrent invocations are capped at 20 per host. Past that, `invoke` returns an error rather than queueing — an agent can't spawn unbounded nested loops.

## Worked example

Define the identity once:

```json
{
  "action": "define",
  "name": "scout",
  "persona": "Brief and methodical. Investigate a narrow question and report what you found and what you couldn't find. Never speculate. Under 200 words."
}
```

Then hand it errands, as many times as you like:

```json
{
  "action": "invoke",
  "name": "scout",
  "instructions": "Find every call site of resolveModel() outside packages/llm and report which ones ignore the error branch."
}
```

The scout runs in its own thread, greps around, and reports back. Its intermediate reasoning — every file it opened, every dead end — never enters the main thread's context. Only the result does.

That's the practical case for reaching for an aux: an errand with a wide search and a narrow answer, where the searching would otherwise crowd out the conversation you're actually having.

## See also

- [Memory & Knowledge Graph](/bound/concepts/memory/) — tiers, edges, and how entries surface in context
- [Agent System](/bound/concepts/agent-system/) — the full native tool set and the scheduler
