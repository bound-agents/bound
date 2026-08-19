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

The agent may split independent scopes and work on them concurrently. It can retain
intermediate findings during the run, so large reports don't need to be copied into the
conversation before the agent can use them.

Depending on the request, the work may move through investigation, planning, implementation,
review, and targeted correction. These stages aren't fixed, and not every request needs all
of them.

Progress may be grouped by scope or stage rather than reported as a stream of every internal
step. This keeps the conversation focused on decisions, results, and exceptions.

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
