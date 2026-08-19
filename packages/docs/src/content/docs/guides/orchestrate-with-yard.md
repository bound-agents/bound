---
title: Understand Yard-backed work
description: Learn what it means when your Bound agent uses Yard for a substantial task.
---

Yard is Bound's internal workflow runner for substantial work that benefits from several coordinated steps. Your agent may use it to investigate a broad question, compare independent findings, or complete an implementation that needs review before delivery.

You do not need to configure Yard or write a workflow. This page explains what its use means for the work you requested.

## When your agent uses Yard

An agent may use Yard when a request needs more than one direct tool call or one isolated auxiliary-agent errand. Typical cases include:

- investigating several independent parts of a codebase or system;
- collecting evidence from multiple sources before making a recommendation;
- dividing file-disjoint work into separate bounded errands;
- carrying findings through investigation, planning, implementation, and review without copying large intermediate reports into the conversation.

For a small, direct request, the agent can use ordinary tools instead. Yard is not a separate service to install or a mode you need to select.

## What you may see

During a Yard-backed request, Bound reports the work as one coordinated operation rather than as an unstructured stream of every intermediate result.

In the `boundless` terminal client, a live Yard operation appears as an execution card below the transcript. It shows the current work graph, including tool work, auxiliary-agent work, and inference. Completed, running, and failed work are distinguished, and concurrent work appears as related siblings. Large fan-outs can be summarized in one row with failed members identified separately.

The final result is returned when the root operation finishes. It can include a compact conclusion, per-scope outcomes, and any gaps the agent found. Intermediate reports remain available to the workflow while it runs, so the final response can focus on the decision, delivered change, evidence, and unresolved work.

In the `boundless` terminal client, live execution events are thread-scoped and ephemeral. A session attached after a run finishes retains ordinary Yard tool-call/result rendering instead of the live execution card.

## Boundaries and limits

Yard work is bounded. A single operation has an overall deadline and a cap on simultaneously running tool, inference, and auxiliary-agent work. Those limits apply to the full coordinated operation, including nested internal stages.

Yard does not expand your agent's authority. Tool calls keep their existing schemas, sandboxing, permissions, and side-effect policy. The workflow runtime itself has no ambient filesystem, network, process, module-loading, clock, timer, or random access; external work must still go through Bound's ordinary tool boundaries.

These limits mean that a large request can finish with some work unexamined. A deadline, unavailable tool or model, failed subtask, or incomplete delegated report can leave a scope without sufficient evidence. A completed subtask is not, by itself, proof that it fully covered its assignment.

## How incomplete work is handled

Yard can keep successful findings from independent work while also carrying rejected or failed work forward. It does not silently retry failed work until it succeeds; retries occur only when the workflow explicitly provides a recovery path.

When an agent uses Yard for a broad request, ask for the remaining gaps if the result does not make them clear. Useful status reporting distinguishes:

- what was completed and the evidence for it;
- what was skipped, failed, or could not be verified;
- what follow-up would be needed to close a remaining gap.

A completed subtask is not, by itself, proof that it fully covered its assignment.

## Review and safety expectations

For changes that need several stages, an agent can use separate investigation, implementation, and review stages. A sound workflow has review inspect the resulting work against the original acceptance criteria and sends identified defects back for repair before delivery.

If a request includes releasing a change, review and validation should happen before the release step. Yard does not bypass validation, sandboxing, permissions, or other tool safeguards.

Yard coordinates work; it does not make an unreviewed result reliable or grant permission for an otherwise restricted action.

## Related information

- [Use the boundless terminal client](/bound/guides/boundless/#follow-yard-execution) for the terminal execution display.
- [Auxiliary agents](/bound/concepts/auxiliary-agents/) for the bounded errands that can take part in coordinated work.
- [Security and execution boundaries](/bound/concepts/security-boundaries/) for Bound's broader permission and sandbox model.
