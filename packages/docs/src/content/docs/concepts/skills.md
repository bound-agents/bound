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

Once imported, a skill exists in the cluster but isn't active on any thread. Activate it:

- **Agent tool**: the agent can activate skills itself via the `skill` tool (`action: activate`)
- **From the web UI**: the agent does this when needed — you typically just ask it to follow certain conventions and it activates the relevant skill

Deactivation is per-thread — dropping a skill from one thread doesn't affect others. The agent can deactivate skills via the `skill` tool (`action: deactivate`).

## Managing skills

| Action | Web UI | CLI | API |
| --- | --- | --- | --- |
| List | Connections → Skills | `boundctl skill list` | `GET /api/skills` |
| View | Click a skill | `boundctl skill view <name>` | `GET /api/skills/:id` |
| Delete | Delete button | `boundctl skill delete <name>` | `DELETE /api/skills/:id` |

Deleting a skill soft-deletes it cluster-wide and files an advisory for any task referencing it. Deletion is reversible — re-importing a deleted skill re-activates it.
