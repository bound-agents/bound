---
title: Skills
description: Operator-defined instruction sets that customize agent behavior.
---

Skills are operator-defined prompt modules. When activated on a thread, a skill's body is injected into the agent's context — giving it domain-specific instructions, conventions, or working habits without bloating the base system prompt.

## SKILL.md format

A skill is a Markdown file with YAML frontmatter:

```markdown
---
name: commit-style
description: Conventional commit message conventions for this repo
---

Use conventional commits: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`, etc.
Present tense, imperative mood. Keep the subject line under 72 characters.
```

### Rules

- **Name**: kebab-case, 1–64 chars, matching `^[a-z0-9]+(-[a-z0-9]+)*$`
- **Description**: up to 1024 chars
- **Body**: up to 500 lines, 64 KB max file size
- One skill per file

## Importing skills

Three surfaces, all sharing the same import logic:

| Surface | How |
| --- | --- |
| Web UI | Connections → Skills → import |
| CLI | `boundctl skill import <path>` |
| API | `POST /api/skills` |

## Activating skills

Once imported, a skill exists in the cluster but isn't active on any thread. The agent activates it — there's no button for this, and no CLI verb. Ask it to follow a convention you've imported a skill for, and it picks up the relevant one:

> Use our commit conventions for this.

Activation is per-thread, so a skill running in one conversation doesn't leak into another.

Dropping a skill works the same way — tell the agent to stop following a convention and it deactivates that skill for the current thread only.

## Managing skills

| Action | Web UI | CLI | API |
| --- | --- | --- | --- |
| List | Connections → Skills | `boundctl skill list` | `GET /api/skills` |
| View | Click a skill | `boundctl skill view <name>` | `GET /api/skills/:id` |
| Delete | Delete button | `boundctl skill delete <name>` | `DELETE /api/skills/:id` |

Deleting a skill soft-deletes it cluster-wide and files an advisory for any task referencing it. Deletion is reversible — re-importing a deleted skill re-activates it.
