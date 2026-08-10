---
title: Skills and activation
description: How reusable instruction sets are packaged, stored, and activated in a thread's context.
---

Skills are reusable instruction sets with optional supporting files. Importing stores a
skill for later use; activating it makes its instructions available to the agent in one
thread. These are separate lifecycle stages.

## Skill layout

Each skill directory has one `SKILL.md` entry point. The file contains YAML frontmatter and
a Markdown instruction body:

```markdown
---
name: commit-style
description: Conventional commit message conventions for this repository
---

Use conventional commits: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`, and so on.
Use present tense and imperative mood. Keep the subject line under 72 characters.
```

The name identifies the skill, the description tells the agent when it may be useful, and
the body supplies the instructions used after activation. Supporting files can provide
additional material without adding all of it to the thread's instructions.

Authoring requirements are compact but strict: names must be 1–64 character kebab-case
values matching `^[a-z0-9]+(-[a-z0-9]+)*$`; descriptions are limited to 1,024 characters;
and the `SKILL.md` body is limited to 500 lines and 64 KB.

## Import and storage

Importing validates and copies the skill into Bound's replicated files and associates it
with a skill record. The imported skill becomes available to the agent, but its instructions
are not added to existing threads.

Imported skills follow the [state and consistency model](/bound/concepts/sync/). Files in a
connected project are not imported merely because a terminal client can read them.

## Thread activation

The agent can activate a skill because its description matches the work or because the user
asks to use it. Activation is per-thread: one thread can use a skill while another continues
without it. After activation, the agent receives the skill's instructions on subsequent
turns in that thread.

There is currently no global cap on the number of active skills. Each active body consumes
context, however, so activation should remain relevant to the thread's work. Deactivation
stops providing the instructions to that thread without removing the imported skill for
other or later threads.

See [Agent tools](/bound/reference/agent-tools/) for activation actions and parameters.

## Skill lifecycle

In summary, packaging creates an importable skill, importing makes it available, activation
uses it in one thread, and deactivation stops using it there without deleting it:

1. **Packaged:** `SKILL.md` and any supporting files form a skill directory.
2. **Imported:** Bound validates and stores the skill so the agent can discover it.
3. **Activated:** The agent receives the skill body in one thread.
4. **Deactivated:** That thread stops receiving the body, while the imported skill remains
   available.
5. **Removed:** The stored skill is no longer available for future activation.
6. **Re-imported:** A newly validated copy becomes available for activation again.

Removing a stored skill and deactivating it in a thread are different operations.

Follow [Manage skills](/bound/guides/manage-skills/) for import, inspection, and removal
procedures. In the web UI, these controls are in the **Skills** section of
[Connections](/bound/concepts/web-ui/#connections).
