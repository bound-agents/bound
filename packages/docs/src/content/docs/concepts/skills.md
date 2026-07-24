---
title: Skills
description: Operator-defined SKILL.md prompts injected into agent context, with activation lifecycle and authoring tooling.
---

Skills are operator-defined prompt modules stored in the `skills` table (synced, LWW). When activated on a thread, a skill's body is injected as a system message into the context assembly pipeline — giving the agent domain-specific instructions, conventions, or working habits without bloating the base system prompt.

## Skill lifecycle

A skill flows through four states:

1. **Imported** — `SKILL.md` files imported via `boundctl skill import`, the REST API (`/api/skills`), or `importSkillFromFiles()`. Parsed and stored with frontmatter.
2. **Activated** — the agent's `skill` tool (`action: activate`) or the web UI activates a skill on a thread. The skill body enters the thread's pinned context block.
3. **Deactivated** — `skill` tool (`action: deactivate`) drops a skill's body from a specific thread's context on the next cold rebuild. Per-thread, not global.
4. **Deleted** — `boundctl skill delete <name>` or `DELETE /api/skills/:id` soft-deletes the skill row and its files. Reversible by re-import (a tombstoned row is treated as a re-activation).

There is no active-skill cap. Per-thread context cost is governed by `deactivate`, not a global ceiling.

## SKILL.md format

```markdown
---
name: commit-style
description: Conventional commit message conventions for this repo
---

# Commit Style

Use conventional commits: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`, etc.
Present tense, imperative mood. Keep the subject line under 72 characters.
```

### Validation constants

| Constant | Value | Purpose |
| --- | --- | --- |
| `MAX_SKILL_BODY_LINES` | 500 | Max lines in the skill body |
| `MAX_FILE_SIZE_BYTES` | 64 KB | Max total file size |
| `MAX_DESCRIPTION_LENGTH` | 1024 | Max characters in frontmatter description |
| `SKILL_NAME_REGEX` | `/^[a-z0-9]+(-[a-z0-9]+)*$/` | Kebab-case names only |
| `MAX_SKILL_NAME_LENGTH` | 64 | Max name length |

## Management surfaces

| Surface | Operations |
| --- | --- |
| Agent `skill` tool | `activate`, `list`, `read`, `deactivate` (no removal) |
| `boundctl skill` | `list`, `view`, `delete`, `import` |
| REST API (`/api/skills`) | list, get, create, delete |

All three surfaces share `importSkillFromFiles()` and `deleteSkill()` from `@bound/agent`. Delete is the single unified removal — it soft-deletes the skill row and files an advisory for any task referencing it.

## Context resolution

Context assembly resolves SKILL.md via the `skill_root` column in the `skills` table (defaulting to `skills/<name>/SKILL.md`). An activated skill's body is injected as a system message during Stage 5 of context assembly, riding the system-level cache breakpoint alongside the stable prefix.

## Built-in skill authoring

A bundled skill-authoring skill is seeded idempotently on startup via `seedSkillAuthoring()`. This gives the agent a self-describing reference for the skill format, so it can help create new skills on request.
