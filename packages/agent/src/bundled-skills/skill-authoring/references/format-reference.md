# SKILL.md Format Reference

## Required frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Matches the skill directory name exactly. Unique identifier. |
| `description` | string | One sentence describing the skill. Shown in `skill-list`. |

## Optional frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| `allowed_tools` | string | Space-delimited tool names this skill uses. Informational only. |
| `compatibility` | string | Version compatibility string (e.g., `agent/1.0`). |

## Validation rules

- `name` must match the directory name (case-sensitive, lowercase alphanumeric + hyphens)
- `description` is required and must be non-empty
- SKILL.md body ≤ 500 lines; file size ≤ 64 KB per file
- Maximum 20 active skills simultaneously

## Example SKILL.md

```yaml
---
name: pr-review
description: Review GitHub pull requests with a structured checklist.
allowed_tools: github bash
compatibility: agent/1.0
---

# PR Review Skill

Use this skill when asked to review a pull request...
```

## Directory structure

```
/home/user/skills/my-skill/
  SKILL.md                    # Required entry point
  references/                 # Optional reference docs
    format-reference.md
  scripts/                    # Optional helper scripts
```
