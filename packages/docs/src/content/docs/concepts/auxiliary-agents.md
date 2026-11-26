---
title: Auxiliary agents
description: How durable subordinate identities isolate bounded work and return focused results to the main agent.
---

Auxiliary agents let the main agent hand off a bounded piece of work and receive a focused
result. Use foreground work when the main agent needs that result before its next step; use
background work when the task is independent and the main agent can continue meanwhile.

Each auxiliary agent has a durable **identity**: a name, persona, and isolated memory used
across assignments. An **invocation** is one assignment to that identity. It runs in a child
thread and returns its result to the parent thread.

## Identity and invocation

The identity supplies a reusable working style, while each invocation supplies one-time
instructions for a particular errand. A broadly useful identity such as a terse,
evidence-focused scout can therefore handle unrelated investigations without creating a
new identity for each topic.

Only the main agent invokes auxiliary agents. The operator can ask it to define or use an identity,
and it decides whether delegation is useful. See [Agent
tools](/bound/reference/agent-tools/) for actions, parameters, and current limits.

## Foreground and background work

A foreground invocation pauses the main agent's next decision until the result arrives. A
background invocation lets the main agent continue and makes the result available when it
completes.

Both modes preserve the same parent-child authority relationship; they differ only in when
the parent waits. Interruption, dispatch, and recovery behavior follows the [work
lifecycle](/bound/concepts/work-lifecycle/).

## Memory isolation

Every auxiliary memory entry belongs to that identity's namespace. Key uniqueness is per
namespace, so different identities can use the same descriptive key without collision.

Visibility is intentionally asymmetric:

- An auxiliary identity reads only its own memory; the main agent's memory and a sibling identity's memory stay out of reach.
- The main agent can read and write an auxiliary identity's memory by naming that identity.

This boundary keeps the subordinate context narrow while allowing the main agent to retain
and revisit useful findings. Retiring an identity prevents new invocations, while its
existing memory remains readable to the main agent. [Memory and knowledge
graph](/bound/concepts/memory/) explains memory tiers, edges, and context selection.

## Capability boundaries

Auxiliary agents do not receive orchestration capabilities for delegation, scheduling, or
cross-thread messaging. Delegation is one level deep, and the main agent remains the
scheduler. A tool allowlist can narrow the remaining capabilities for an identity.

An invocation inherits the dispatching thread's surface context as well as its eligible
client tools. A `boundless` invocation therefore receives the same working directory, Git
context, and injected context files as its parent; connector and web invocations preserve
their corresponding platform context. The auxiliary persona replaces the main agent's
persona in the child thread's system prompt, so the identity speaks as itself with no
main-agent persona appended. Inheritance does not remove orchestration restrictions, and
host access still follows the [sandbox and filesystem model](/bound/concepts/sandbox/).
[Security boundaries](/bound/concepts/security-boundaries/) places these identity and
capability limits in the broader trust model.

Client tools reach an auxiliary agent even when its loop runs on a different host from the
parent's client session: each call relays to the session host. When the parent thread is
attached to a client session, the errand needs client tools, and no live session can serve
them, the invocation fails before the errand starts with `client session unavailable for aux
dispatch`. An errand needs client tools when its identity has no allowlist or its allowlist
names a tool that no server-side source provides. In a Yard program, that failure ends the whole
run: in-flight effects are cancelled, unstarted `all()` and `sequence()` children are never
dispatched (even with `errors: "settled"`), a `try`/`catch` in the program cannot catch it, and
the `yard` call fails with `client session unavailable for aux dispatch`. A nested Yard that hits
it ends its parent run too. Other aux failures, such as an errand that completes with an error,
stay visible to the program, which decides whether to retry or rework.

An auxiliary agent waits on each inherited client tool for the call's own `timeout` plus 30
seconds, and never less than 300 seconds. A relayed call gets the same wait on the session
host, which owns that call's expiry; the session host's five-minute sweep of stale client
calls skips calls from auxiliary threads whose parent session is still connected. If the wait
runs out or the invocation is aborted, the agent records one error result, sends `tool:cancel`
to the client, and discards any later result for that call. The error states the cause: an exceeded timeout while the session was
still connected, a dropped client session, or an aborted invocation.

## Child threads and focused results

Each invocation creates a child thread associated with the parent and the auxiliary
identity. Its instructions are marked as work dispatched by the main agent rather than as a
human message, and the web UI and boundless label them **agent** in the child transcript. Auxiliary child threads stay out of the web UI thread directory because they
are internal errands rather than operator conversations; the invoking chat turn carries the
result and the navigable link into the child transcript.

This structure keeps exploratory steps out of the main conversation's immediate context.
The parent receives the answer it needs rather than every intermediate search, tool result,
or dead end. Child threads, tool availability, and owning hosts fit into the broader [system
model](/bound/concepts/system-model/), while the [agent
system](/bound/concepts/agent-system/) explains the parent loop.

Use an auxiliary agent when work has a wide working set but a narrow deliverable, or when an
independent task can run in the background. Keep work in the main thread when the steps are
small, tightly coupled to the conversation, or require frequent direction from the user.
