/**
 * Bundled skill-authoring skill content.
 * These strings are seeded to the files table on startup.
 * Content is embedded here so the agent always has a copy even if files are deleted.
 */

export const SKILL_AUTHORING_SKILL_MD = `---
name: skill-authoring
description: Author, activate, and manage reusable instruction sets called skills.
allowed_tools: skill-activate skill-list skill-read skill-retire bash
---

# Skill Authoring

This skill teaches you how to author, activate, and manage skills.

## What is a skill?

A skill is a directory containing a \`SKILL.md\` file (and optional supporting files)
that describes a specialized workflow. Skills live under \`/home/user/skills/{name}/\`.
Once activated, a skill's index entry appears in every turn's context, and its SKILL.md
body is injected as a system message when a task specifies \`"skill": "{name}"\`.

## SKILL.md frontmatter

Every skill must have a \`SKILL.md\` with valid YAML frontmatter:

\`\`\`yaml
---
name: skill-name          # Required. Must match the directory name exactly.
description: One sentence describing what this skill does.
allowed_tools: tool1 tool2  # Optional. Space-delimited tool names.
compatibility: agent/1.0    # Optional. Version compatibility string.
---
\`\`\`

See \`references/format-reference.md\` for the full schema.

## Commands

- \`skill-activate {name}\` — activate a skill from \`/home/user/skills/{name}/SKILL.md\`
- \`skill-list\` — list active skills (name, status, activations, last used, description)
- \`skill-list --status retired\` — show retired skills only
- \`skill-list --verbose\` — include allowed_tools, compatibility, content_hash
- \`skill-read {name}\` — view SKILL.md content with status and telemetry header
- \`skill-retire {name}\` — retire a skill; use \`--reason "..."\` to explain why

## Authoring workflow

1. Write \`/home/user/skills/{name}/SKILL.md\` with valid frontmatter
2. Add optional supporting files (\`references/\`, \`scripts/\`)
3. Run \`skill-activate {name}\` to make it active
4. Verify with \`skill-list\` and \`skill-read {name}\`

## Validation rules

- \`name\` in frontmatter must match the directory name exactly
- \`description\` is required
- SKILL.md body must be ≤ 500 lines
- File size limit: 64 KB per skill file
- Maximum 20 active skills at once

## Reactivating a retired skill

Call \`skill-activate {name}\` again. The skill transitions from \`retired\` → \`active\`.
`;

export const SKILL_AUTHORING_FORMAT_REFERENCE_MD = `# SKILL.md Format Reference

## Required frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| \`name\` | string | Matches the skill directory name exactly. Unique identifier. |
| \`description\` | string | One sentence describing the skill. Shown in \`skill-list\`. |

## Optional frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| \`allowed_tools\` | string | Space-delimited tool names this skill uses. Informational only. |
| \`compatibility\` | string | Version compatibility string (e.g., \`agent/1.0\`). |

## Validation rules

- \`name\` must match the directory name (case-sensitive, lowercase alphanumeric + hyphens)
- \`description\` is required and must be non-empty
- SKILL.md body ≤ 500 lines; file size ≤ 64 KB per file
- Maximum 20 active skills simultaneously

## Example SKILL.md

\`\`\`yaml
---
name: pr-review
description: Review GitHub pull requests with a structured checklist.
allowed_tools: github bash
compatibility: agent/1.0
---

# PR Review Skill

Use this skill when asked to review a pull request...
\`\`\`

## Directory structure

\`\`\`
/home/user/skills/my-skill/
  SKILL.md                    # Required entry point
  references/                 # Optional reference docs
    format-reference.md
  scripts/                    # Optional helper scripts
\`\`\`
`;
