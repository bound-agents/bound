---
title: Yard-backed work
description: Understand the boundaries, results, and safeguards of coordinated work run by your Bound agent.
---

Yard is an internal Bound workflow runner. When an agent uses it, the agent coordinates bounded tool work, model inference, and auxiliary-agent errands as one operation. You do not invoke or program Yard directly.

For what this means during a request, see [Understand Yard-backed work](/bound/guides/orchestrate-with-yard/).

## Observable contract

A Yard-backed operation produces either a final result or a reported failure. A successful result can include a compact decision, delivered work, per-scope outcomes, and usage information such as elapsed time and the number of tool and inference calls.

The operation has one overall deadline and one cap on concurrent work. These limits cover its internal stages, including nested stages. A run that reaches its deadline or encounters an uncaught failure does not produce a successful result.

Yard can retain large intermediate findings during the operation. The final response should report the useful conclusion and identify any work that was incomplete, failed, skipped, or could not be verified.

## Safety boundaries

Yard does not give an agent additional tools, permissions, or access. Work performed through Yard remains subject to the same tool schemas, sandboxing, permission checks, and side-effect policy as direct work.

The internal workflow runtime cannot independently access the filesystem, network, processes, modules, clocks, timers, or random values. It must request external work through Bound's normal tool boundaries.

## Related information

- [Understand Yard-backed work](/bound/guides/orchestrate-with-yard/) explains when agents use Yard, what progress can look like, incomplete-work reporting, and review expectations.
- [Use the boundless terminal client](/bound/guides/boundless/#follow-yard-execution) describes the terminal display for live Yard execution.
- [Agent tools](/bound/reference/agent-tools/) lists the native capabilities available to Bound agents.
