---
name: aux-agents
description: Doctrine for auxiliary-agent identities — persona vs errand, roster design by role, and the overprompting smell that means an identity is missing.
allowed_tools: skill-read
---

# Auxiliary Agent Doctrine

An auxiliary agent is a durable, persona-scoped identity with its own memory
namespace. Its persona **replaces** the main agent's persona in the child
thread — the identity speaks as itself. Definitions are cheap and durable;
invocations are ephemeral errands.

## The dividing line: persona vs errand

**The persona carries standing behavior.** Temperament, working style,
discipline, reflexes — everything that should be true of the identity on
every invocation. A persona says who the agent IS, never what today's task
is.

**The invocation carries only the errand.** Scope, goal, acceptance
criteria. Nothing else.

The test: if two different errands would need the same sentence in their
instructions, that sentence belongs in a persona.

## The overprompting smell

When invocation instructions grow to multiple kilobytes re-teaching
workflow — "use TDD", "verify the worktree first", "do not commit", "report
per-file outcomes" — the roster is missing an identity for that ROLE, and
the caller is compensating per-invocation for a persona that doesn't fit.

Observed live: a read-shaped investigator identity pressed into
implementation and release errands accumulated instructions up to 16 KB,
re-teaching build discipline every time; a well-matched scout identity ran
300 invocations averaging 600 chars. Instructions past ~1–2 KB are the
smell threshold. Fix the roster, not the prompt.

## Roster design: cover the roles

Corpus-scale orchestration (see the `yard-recipes` skill) needs at minimum:

- a **scout** — surveys a partition, lists candidates with reasons, makes
  no edits;
- an **implementer** — works test-first, verifies the ground before
  touching it, produces one coherent diff, never commits unless the errand
  explicitly hands over the release;
- a **reviewer** — reads the actual diff, measures against stated
  acceptance criteria, names specific gaps, passes work that meets the bar
  even when it would have built it differently.

Specialist identities (a pricing skeptic, a security auditor) earn a slot
when a judgment shape recurs. A roster of only read-shaped identities is a
structural gap: the first implementation errand will be forced onto an
investigator and overprompted to compensate.

## Writing a persona

- Second person is unnecessary; write it as a description of character.
  Two to four sentences is the working size.
- Encode the reflexes the role must have without being told: an
  implementer's failing-test-first habit, a reviewer's
  read-the-diff-before-judging habit, a scout's no-edits rule.
- Encode the STOP conditions: what the identity refuses to improvise
  through (an implementer stopping when the worktree doesn't match the
  errand, rather than "fixing" it).
- Encode the report shape when stopped short: ground state — what changed,
  what didn't, where the boundary sits, what would unblock — never a bare
  apology. An "I wasn't able to complete this" with nothing else spends the
  whole errand's budget and hands the orchestrator zero data.
- Do NOT encode any particular codebase, task, or output format — those
  are errand material.

## Defining and maintaining

- `aux` action `define` — name, persona, optional `model_hint` and `tools`
  allowlist. Pick the model for the role's demands (a reviewer wants a
  strong reader; a scout can run cheaper).
- `aux` action `update` — evolve a persona in place; the identity keeps its
  memory namespace.
- `aux` action `retire` — one-shot identities named after a single errand
  ("<project>-architecture-scout") are roster debt; retire them and use a
  role identity with the project in the instructions instead.
- `aux` action `list` — review the roster before orchestration work; check
  the persona column for role fit, not just the name.

## Invoking

- Instructions are the errand: scope ("ONLY packages/agent/src/tools"),
  goal, acceptance criteria ("bun test <path> green; report per-file
  outcomes and anything skipped, with why").
- Inside a Yard program, invocations are synchronous (`background: true`
  is rejected); concurrency comes from `all()`.
- Never interpolate a structured object into instructions — the Yard guest
  throws at the coercion site. `JSON.stringify()` it, or extract fields.
- The aux inherits the dispatching surface's context (working directory,
  git context, context files) automatically; don't re-describe the
  environment in the errand.
