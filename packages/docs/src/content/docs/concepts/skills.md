---
title: Skills
description: How reusable instruction sets are imported, activated per thread, and removed.
---

Skills are reusable instruction sets stored with their supporting files. Activation adds a
skill's body to one thread's stable prompt prefix; importing a skill does not activate it.

## Skill format

A skill is a Markdown file with YAML frontmatter:

```markdown
---
name: commit-style
description: Conventional commit message conventions for this repo
---

Use conventional commits: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`, etc.
Present tense, imperative mood. Keep the subject line under 72 characters.
```

### Validation rules

- **Name**: kebab-case, 1–64 chars, matching `^[a-z0-9]+(-[a-z0-9]+)*$`
- **Description**: up to 1024 chars
- **Body**: up to 500 lines, 64 KB max file size
- One `SKILL.md` entry point per skill directory

## Importing skills

Importing copies the skill into Bound's replicated files and creates or reactivates its
skill record:

| Surface | How |
| --- | --- |
| Web UI | **Connections > Skills > Import** |
| CLI | `boundctl skill import <path>` |
| API | `POST /api/skills` |

## Activating skills

The agent controls activation through its `skill` tool. Ask it to use an imported skill:

> Use our commit conventions for this.

Activation is per-thread. There is no global active-skill cap; deactivate skills that a
thread no longer needs to reduce context cost.

Ask the agent to stop using a skill to deactivate it for the current thread.

## Managing skills

| Action | Web UI | CLI | API |
| --- | --- | --- | --- |
| List | **Connections > Skills** | `boundctl skill list` | `GET /api/skills` |
| View | Click a skill | `boundctl skill view <name>` | `GET /api/skills/:id` |
| Delete | Delete button | `boundctl skill delete <name>` | `DELETE /api/skills/:id` |

Deletion is the only removal operation. It soft-deletes the skill and its files, then files
an advisory for tasks that reference it. Re-importing the same name restores the skill.
