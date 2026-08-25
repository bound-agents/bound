---
title: Work orchestration with Yards
description: Understand how Bound agents coordinate bounded, multi-stage work and what to expect from the result.
---

Some requests need more than one bounded step: for example, auditing several areas, comparing
independent sources, or making a change that requires investigation, implementation, and review.
You ask for the outcome in ordinary language. The agent decides whether that shape fits the work;
you do not author or control its internal workflow.

When it does, the agent sets up a **Yard**—a trainyard-like, bounded coordination plan that routes
focused errands through the work and gathers their results.

## When a Yard fits

Yard-backed work is suited to requests such as:

- a broad audit across several areas;
- a change that spans multiple independent parts of a project;
- a comparison that needs evidence from separate sources;
- work that benefits from distinct investigation and review stages.

A simple question, one direct action, or a small self-contained edit usually does not need a Yard.
The agent can handle those requests with its ordinary tools.

## How the work proceeds

A Yard is the bounded coordination plan behind the work. Auxiliary agents are its specialist
workers: each receives a focused errand, works in its own child thread, and returns a result for
the main agent to use. The main agent remains responsible for the request, the plan, and the final
response.

A substantial request can therefore take a recognizable shape:

1. **Parallel investigation** — specialists examine separate, independent scopes at the same time.
2. **Synthesis** — the main agent compares their findings and turns them into a decision or concrete
   next steps.
3. **Implementation and review** — a worker may make a focused change while another checks the
   actual result against the request.
4. **Targeted repair** — a failed check or review finding goes back only to the relevant scope,
   rather than restarting all of the work.

These are possible shapes, not a fixed ceremony. A request may need only one specialist, or it may
stop after investigation when the evidence does not support a change.

### An illustrative internal plan

The agent, not you, writes and runs a Yard program. This simplified example shows the recognizable
shape of a request to compare two options: two auxiliary agents investigate in parallel, then the
main agent synthesizes their findings.

```js
function* main(input) {
  const findings = yield all([
    aux("researcher-a", "Investigate option A and report evidence."),
    aux("researcher-b", "Investigate option B and report evidence."),
  ]);

  return yield infer(input.model, {
    prompt: "Compare the evidence and recommend the better option.",
    input: findings,
  });
}
```

The details of this internal program—its JavaScript, tool calls, models, and worker identities—are
not part of the user interface. What matters is the work shape: focused investigation, a synthesis
step, and a final answer from the main agent.

Progress may be grouped by scope or stage rather than reported as a stream of every internal step.
This keeps the conversation focused on decisions, results, and exceptions. See
[Auxiliary agents](/bound/concepts/auxiliary-agents/) for their identity, isolation, and capability
boundaries.

## Safeguards

A Yard does not grant the agent additional permissions, tools, or authority. All work remains
subject to the same access controls, sandboxing, and side-effect rules as direct agent work.

Each run has bounded time and parallel work. When multiple scopes can change files, the agent should
assign non-overlapping change scopes. Work intended for release should be reviewed and validated
before release.

## Limits

A Yard can coordinate substantial work, but it cannot guarantee complete coverage or success. Time
limits, unavailable tools, failed work, missing evidence, or external blockers can leave part of a
request incomplete. Review can find problems and trigger targeted correction, but it cannot turn
insufficient evidence into a verified result.

## What the result should report

The final response should identify:

- completed work and its validation;
- incomplete or unexamined scopes;
- blockers and remaining risks;
- resulting artifacts, such as changed files, reports, or other deliverables.

This reporting boundary lets you evaluate the delivered outcome without needing access to, or control
over, the internal workflow.

## Reloading execution panels

Yard keeps execution lifecycle events in server memory only while a run is active. When a thread view reconnects, its subscription receives a replay of the active trace and continues rendering the interactive graph live. The replay buffer is evicted when the root run reaches a terminal state, and it is naturally unavailable after a server restart.

Completed executions reload from the existing persisted Yard tool-call and tool-result messages. The UI statically derives the graph shape from the persisted Yard program source without evaluating it: literal `tool`, `infer`, `aux`, `all`, `sequence`, and nested `yard` calls render with their statically knowable structure. Dynamic regions remain explicitly unknown rather than fabricated. Lifecycle replay decorates those source-derived nodes while the server has it; after a restart the complete topology remains visible with unavailable state. No separate execution-history table, sync surface, route, or client API is used.
