# Agent Skills Implementation Plan — Phase 2: CommandContext Extension and File Infrastructure

**Goal:** Give skill commands filesystem access for early file persistence; add bundled skill-authoring content.

**Architecture:** Extend `CommandContext` with an optional `IFileSystem` field imported from `just-bash` (already a dep of `@bound/sandbox`), pass the resolved `MountableFs` in `start.ts`, and create `bundled-skills.ts` in `@bound/agent` with the skill-authoring SKILL.md and format reference as string constants.

**Tech Stack:** TypeScript, just-bash@2.14.0 (IFileSystem)

**Scope:** Phase 2 of 6

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

This phase is infrastructure. Verified by TypeScript compilation only.

**Verifies: None** — done when `bun run typecheck` succeeds and `bundled-skills.ts` exports the two constants.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add `fs?: IFileSystem` to `CommandContext` in `packages/sandbox/src/commands.ts`

**Verifies:** None (infrastructure — TypeScript compiler verifies)

**Files:**
- Modify: `packages/sandbox/src/commands.ts:6` (extend existing just-bash import)
- Modify: `packages/sandbox/src/commands.ts:15-24` (CommandContext interface)

**Implementation:**

**Step 1: Extend the existing just-bash import on line 6**

Change:
```typescript
import type { CustomCommand } from "just-bash";
```

To:
```typescript
import type { CustomCommand, IFileSystem } from "just-bash";
```

**Step 2: Add `fs?: IFileSystem` to `CommandContext` (lines 15-24)**

Change:
```typescript
export interface CommandContext {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger: Logger;
	threadId?: string;
	taskId?: string;
	mcpClients?: Map<string, unknown>;
	modelRouter?: unknown; // ModelRouter from @bound/llm, optional for backward compatibility
}
```

To:
```typescript
export interface CommandContext {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger: Logger;
	threadId?: string;
	taskId?: string;
	mcpClients?: Map<string, unknown>;
	modelRouter?: unknown; // ModelRouter from @bound/llm, optional for backward compatibility
	fs?: IFileSystem;
}
```

**Verification:**

Run: `tsc -p packages/sandbox --noEmit`
Expected: No errors.

Run: `bun test packages/sandbox`
Expected: All existing tests pass.

**Commit:** `feat(sandbox): add fs field to CommandContext`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Pass `clusterFs` as `fs` in `commandContext` in `packages/cli/src/commands/start.ts`

**Verifies:** None (infrastructure — TypeScript compiler verifies)

**Files:**
- Modify: `packages/cli/src/commands/start.ts:379-385`

**Implementation:**

**Step 1: Modify the `commandContext` object at lines 379-385**

Change:
```typescript
const commandContext = {
	db: appContext.db,
	siteId: appContext.siteId,
	eventBus: appContext.eventBus,
	logger: appContext.logger,
	mcpClients: mcpClientsMap,
};
```

To:
```typescript
const commandContext = {
	db: appContext.db,
	siteId: appContext.siteId,
	eventBus: appContext.eventBus,
	logger: appContext.logger,
	mcpClients: mcpClientsMap,
	// biome-ignore lint/suspicious/noExplicitAny: MountableFs satisfies IFileSystem; cross-package type not importable here
	fs: clusterFs as any,
};
```

Note: `clusterFs` (declared on line 377) is the MountableFs extracted from `clusterFsRaw` via `("fs" in clusterFsRaw ? clusterFsRaw.fs : clusterFsRaw) as any`. It satisfies `IFileSystem` at runtime. The `as any` cast is consistent with the existing `clusterFs` cast on line 377, which also uses `as any` because the MountableFs type lives in `just-bash`, not re-exported from `@bound/sandbox`.

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No errors.

**Commit:** `feat(cli): pass clusterFs as fs in commandContext`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Create `packages/agent/src/bundled-skills.ts` with skill-authoring content

**Verifies:** None (infrastructure — file exports verified by TypeScript)

**Files:**
- Create: `packages/agent/src/bundled-skills.ts`

**Implementation:**

Create the file with the following content:

```typescript
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
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors. Both exports are accessible.

Run: `bun run typecheck`
Expected: All packages typecheck without errors.

**Commit:** `feat(agent): add bundled-skills.ts with skill-authoring content`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
