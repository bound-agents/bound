---
title: Yard-backed work
description: Understand how Bound agents may coordinate substantial work and what to expect from the result.
---

A Bound agent may use Yard internally when your request benefits from bounded, multi-stage
work. You request the outcome in ordinary language; you don't author or control the internal
workflow.

## When Yard-backed work fits

Yard-backed work is suited to requests such as:

- a broad audit across several areas;
- a change that spans multiple independent parts of a project;
- a comparison that needs evidence from separate sources;
- work that benefits from distinct investigation and review stages.

A simple question, one direct action, or a small self-contained edit usually doesn't need
Yard. The agent can handle those requests with its ordinary tools.

## How the work proceeds

Yard is the bounded coordination plan behind the work. Auxiliary agents are its specialist
workers: each receives a focused errand, works in its own child thread, and returns a result
for the main agent to use. The main agent remains responsible for the request, the plan, and
the final response.

A substantial request can therefore take a recognizable shape:

1. **Parallel investigation** — specialists examine separate, independent scopes at the same
   time.
2. **Synthesis** — the main agent compares their findings and turns them into a decision or
   concrete next steps.
3. **Implementation and review** — a worker may make a focused change while another checks the
   actual result against the request.
4. **Targeted repair** — a failed check or review finding goes back only to the relevant scope,
   rather than restarting all of the work.

These are possible shapes, not a fixed ceremony. A request may need only one specialist, or it
may stop after investigation when the evidence does not support a change. The agent may retain
intermediate findings during the run, so large reports do not need to be copied into the
conversation before they can inform later stages.

Progress may be grouped by scope or stage rather than reported as a stream of every internal
step. This keeps the conversation focused on decisions, results, and exceptions. See
[Auxiliary agents](/bound/concepts/auxiliary-agents/) for their identity, isolation, and
capability boundaries.

## Safeguards

Yard doesn't grant the agent additional permissions, tools, or authority. All work remains
subject to the same access controls, sandboxing, and side-effect rules as direct agent work.

Each run has bounded time and parallel work. When multiple scopes can change files, the agent
should assign non-overlapping change scopes. Work intended for release should be reviewed and
validated before release.

## Limits

Yard can coordinate substantial work, but it can't guarantee complete coverage or success.
Time limits, unavailable tools, failed work, missing evidence, or external blockers can leave
part of a request incomplete. Review can find problems and trigger targeted correction, but it
can't turn insufficient evidence into a verified result.

## What the result should report

The final response should identify:

- completed work and its validation;
- incomplete or unexamined scopes;
- blockers and remaining risks;
- resulting artifacts, such as changed files, reports, or other deliverables.

This reporting boundary lets you evaluate the delivered outcome without needing access to, or
control over, the internal workflow.
