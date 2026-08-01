---
title: Auxiliary Agents
description: Scoped side identities with their own memory namespace, invoked to run errands without dragging the main agent's context along.
---

An auxiliary agent is a durable, named identity the main agent can hand an errand to. It runs in its own thread with its own memory namespace, reports back a result, and the conversation is thrown away. The identity persists; each invocation is ephemeral.

This exists because subagents don't map cleanly onto bound's threading model. Every ordinary thread is a *view* of one agent that spans all of them — same identity, same memory, peers by construction. A subagent breaks that: it takes instructions from another instance of itself and gets discarded when it's done, which is not a peer relationship. Auxiliary agents make that authority split explicit instead of pretending it isn't there.

## You ask; the agent dispatches

There is no CLI command, config file, or UI panel for auxiliary agents. The entire surface is the agent's `aux` tool, and the agent is its only caller — so your side of this is conversation:

> Set up a scout identity for codebase spelunking — terse, reports what it found and what it couldn't, no speculation.

> Have the scout figure out which call sites of `resolveModel()` outside `packages/llm` ignore the error branch.

The agent decides when an errand is worth delegating, defines an identity when it needs one it doesn't have, and folds the result back into the conversation. Everything below describes what the agent controls on your behalf — worth reading so you know what's available to ask for, and so you can follow what the agent tells you it did.

## Identity, not job description

The persona says who the aux **is** — temperament, working style, standing habits. It does not say what the aux is for. The job arrives per-invocation in `instructions`.

That split is what makes an identity reusable. An aux defined as "brief and methodical; investigates a narrow question and reports what it found and what it couldn't find" can be handed a dozen unrelated errands. An aux defined as "the agent that audits our CI logs" can only ever do that one thing, and you end up with a sprawl of near-duplicate identities.

## Actions

Five actions on the `aux` tool, all agent-invoked:

| Action | What it does |
| --- | --- |
| `define` | Create a new identity |
| `update` | Change an existing identity's persona, tools, or model |
| `retire` | Retire an identity — drops from `list`/`invoke`, memory stays readable |
| `list` | Show active identities |
| `invoke` | Hand an errand to an identity and wait for the result |

### define

What the agent supplies when creating an identity:

| Parameter | Required | Notes |
| --- | --- | --- |
| `name` | Yes | kebab-case, matching `^[a-z0-9]+(-[a-z0-9]+)*$`, up to 64 chars |
| `persona` | Yes | Non-empty, up to 8192 chars |
| `tools` | No | Allowlist of tool names. Omit for unrestricted (structural denials still apply) |
| `model_hint` | No | Default model for this identity |

Defining over an existing active name fails rather than silently overwriting it — an identity-sprawl guard. The agent updates the existing identity or picks a different name.

### invoke

What the agent supplies when dispatching an errand:

| Parameter | Required | Notes |
| --- | --- | --- |
| `name` | Yes | Must be an active (non-retired) identity |
| `instructions` | Yes | The errand — what to do this invocation |
| `model` | No | Override the definition's `model_hint` for this call only |
| `background` | No | Don't block on the result — dispatch and keep going |

By default `invoke` is synchronous. It creates the child thread, seeds the instructions, runs the nested loop to completion, and returns the aux's final response as the result. The main agent's turn blocks until the aux finishes — from your side, one pause in the conversation and then the answer.

### Backgrounding an errand

With `background: true`, `invoke` returns the moment the child thread is seeded. The main agent gets a placeholder result — *this is running, the answer will arrive later* — and carries on with the rest of its turn. When the aux finishes, its result replaces the placeholder and the main agent wakes to read it.

The practical difference is parallelism. Three synchronous invocations run one after another and you wait for the sum; three backgrounded ones leave together and you wait for the slowest. When the agent has several independent questions to farm out, that's the difference between one long pause and one short one.

The agent picks per call, not per identity. The same scout can be backgrounded for a broad survey whose answer isn't needed until later in the turn, and awaited synchronously when the next step depends on what it found. Deciding which is which is the agent's judgment call — if it needs the answer to choose its next move, blocking is correct.

A backgrounded errand that fails surfaces as a failed tool result rather than vanishing: an aux that reports an error, or a nested loop that throws, both land as the result the main agent reads on wake. What a background invocation does *not* survive is the server restarting mid-flight — the child thread and its seeded instructions persist in the database, but nothing re-drives the loop, so the errand needs re-dispatching.


### retire

Retiring is domain state, not deletion. The identity drops out of `list` and can no longer be invoked, but its memory namespace stays readable to the main agent — a retired aux's findings don't evaporate. Retiring an already-retired identity is a no-op, not an error. A later `define` under the same name starts a genuinely fresh identity.

## Memory namespaces

Every memory entry carries an owning identity. The main agent's entries have no owner; an aux's entries are tagged with its identity. Key uniqueness is per-namespace, so two auxes can both store `findings` without colliding.

The visibility rule is deliberately asymmetric:

- An **aux cannot read the main agent's memory.** It only sees its own namespace.
- The **main agent can read and write any aux's memory**, by naming the identity on a memory call. So "what did the scout turn up?" is answerable in your main conversation later, without re-running the errand.

The asymmetry is the point. A memory written from the main agent's vantage can mean something different read from a subordinate one — a workflow note that ends in "then discard yourself" is coherent for the aux and alarming for the leader. Walling the aux off keeps its context small and its framing consistent; leaving the main agent's view unrestricted means nothing an aux learns is lost to you.

That reach is one-directional by construction: an aux naming a sibling identity on a memory call gets its own namespace anyway, so no aux can read another's findings.

## Capability boundary

An aux never receives the orchestration tools, regardless of its allowlist:

`aux` · `task` · `cancel` · `notify` · `introspect`

No aux can define or invoke another aux, schedule work, or message other threads. Delegation is one level deep by construction, and the main agent stays the only scheduler. An explicit `tools` allowlist narrows things further from whatever remains.

What an aux *does* inherit is the dispatching thread's **client tools** — the host-side file and shell tools a boundless session registers. An aux dispatched from a terminal session can read the repo you're working in; one dispatched from the web UI, where no such session exists, gets only the sandboxed filesystem. This is why a scout can be sent to investigate real code rather than only what's already in the database. The allowlist applies here too: name a subset and the aux sees only those.

The orchestration exclusions above are absolute and unaffected by inheritance — no client tool grants an aux the ability to delegate or schedule.

## Threading

An aux invocation creates a child thread with a strict parent relationship: it records the dispatching thread as its parent and inherits that thread's owning user, so archival and deletion cascade naturally from parent to children. The thread is tagged with the `aux` interface and titled `aux: <name>`.

The seeded instructions arrive as a user-role message marked as sent by the main agent, so the aux can distinguish an errand dispatched by the leader from a message sent by a human.

Concurrent invocations are capped at 20 per host. Past that, `invoke` returns an error rather than queueing — an agent can't spawn unbounded nested loops.

Because an aux runs as a nested loop inside the dispatching thread's turn, its inherited client tools resolve **inline**: the aux waits for each result rather than suspending the way the main agent does. Delivery reaches your client through the parent thread's session, since nothing subscribes to an aux thread directly. A client tool called by an aux whose parent has no live session fails with an explanatory result rather than hanging.

## Worked example

You ask for the identity once:

> Define a scout aux — brief and methodical, investigates a narrow question, reports what it found and what it couldn't find, never speculates. Keep it under 200 words.

Then hand it errands, as many times as you like:

> Ask the scout to find every call site of `resolveModel()` outside `packages/llm` and report which ones ignore the error branch.

The scout runs in its own thread, greps around, and reports back. Its intermediate reasoning — every file it opened, every dead end — never enters the main thread's context. Only the result does.

That's the practical case for reaching for an aux: an errand with a wide search and a narrow answer, where the searching would otherwise crowd out the conversation you're actually having.

## See also

- [Memory & Knowledge Graph](/bound/concepts/memory/) — tiers, edges, and how entries surface in context
- [Agent System](/bound/concepts/agent-system/) — the full native tool set and the scheduler
