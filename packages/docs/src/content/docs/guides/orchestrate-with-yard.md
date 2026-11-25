---
title: Work orchestration with Yards
description: Understand how Bound agents coordinate bounded, multi-stage work and what to expect from the result.
---

Some requests need more than one bounded step: for example, auditing several areas, comparing
independent sources, or making a change that requires investigation, implementation, and review.
Ask for the outcome in ordinary language. The agent decides whether that shape fits the work;
it authors and controls its own internal workflow.

When it does, the agent sets up a **Yard**—a trainyard-like, bounded coordination plan that routes
focused errands through the work and gathers their results.

## When a Yard fits

Yard-backed work is suited to requests such as:

- a broad audit across several areas;
- a change that spans multiple independent parts of a project;
- a comparison that needs evidence from separate sources;
- work that benefits from distinct investigation and review stages.

A straightforward question, one direct action, or a small self-contained edit usually does not need a Yard.
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

A request may need only one specialist, or stop after investigation when the evidence does not
support a change.

### An illustrative internal plan

The agent writes and runs a Yard program on its own. This simplified example shows the recognizable
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

All work inside a Yard runs under the same access controls, sandboxing, and side-effect rules as
direct agent work.

Each run has bounded time and parallel work. When multiple scopes can change files, the agent should
assign non-overlapping change scopes. Work intended for release should be reviewed and validated
before release.

## Limits

Time limits, unavailable tools, failed work, missing evidence, or external blockers can leave
part of a request incomplete. Review catches gaps and triggers targeted correction against the
available evidence.

A synthesis step that asks a model for structured output re-asks once by default when the reply
is not valid JSON or does not match the requested shape. The re-ask carries the error and an
excerpt of the bad reply. Each miss is recorded in the run's trace, and the extra tokens count
toward the run's usage. If the repaired reply still misses, that step fails with the error and
the excerpt.

## What the result should report

The final response should identify:

- completed work and its validation;
- incomplete or unexamined scopes;
- blockers and remaining risks;
- resulting artifacts, such as changed files, reports, or other deliverables.

This reporting boundary keeps the delivered outcome evaluable without needing access to, or control
over, the internal workflow.

## Inspecting Yard execution

In the web UI and the `boundless` terminal client, an active Yard run renders as an interactive
execution tree that updates live while the trace is running and rebuilds from the persisted
program and result after reload. See
[Web UI reference](/bound/concepts/web-ui/#yard-execution-graphs) and
[Follow Yard execution](/bound/guides/boundless/#follow-yard-execution) for status states and
inspector controls.
