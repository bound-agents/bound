# Web Skills Tab — Phase 1: Shared Service Extraction

**Goal:** Extract source-agnostic skill import logic into a reusable `importSkillFromFiles()` function

**Architecture:** A single function in `packages/agent/src/tools/skill-utils.ts` that accepts an in-memory file map, validates, hashes, and persists to the `skills` and `files` tables. Callers (web API, CLI, agent) each resolve files from their IO layer then delegate here.

**Tech Stack:** TypeScript, bun:sqlite, SHA-256 (node:crypto), existing `parseFrontmatter()`, `insertRow`/`updateRow` from `@bound/core`

**Scope:** 5 phases from original design (phase 1 of 5)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### web-skills-tab.AC1: Shared service validates and persists skills correctly
- **web-skills-tab.AC1.1 Success:** Valid SKILL.md with correct frontmatter (name + description) creates a skill with status "active"
- **web-skills-tab.AC1.2 Success:** Multi-file skill (SKILL.md + reference files) persists all files to the files table
- **web-skills-tab.AC1.3 Failure:** Missing SKILL.md in file list returns error
- **web-skills-tab.AC1.4 Failure:** Invalid name format (uppercase, spaces, special chars) returns validation error
- **web-skills-tab.AC1.5 Failure:** Exceeding 20 active skill cap returns cap-exceeded error
- **web-skills-tab.AC1.6 Success:** Re-importing a retired skill re-activates it with updated content and incremented activation_count

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add SkillFileEntry and ImportSkillResult types to shared package

**Files:**
- Modify: `packages/shared/src/types.ts` (append after existing Skill interface, around line 256)

**Implementation:**

Add these types after the existing `Skill` interface in `packages/shared/src/types.ts`:

```typescript
export interface SkillFileEntry {
	path: string; // relative path within skill (e.g., "SKILL.md", "references/format.md")
	content: string; // UTF-8 file content
}

export interface ImportSkillOptions {
	threadId?: string;
}

export type ImportSkillResult =
	| { ok: true; skillId: string; name: string }
	| { ok: false; error: string };
```

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No errors

**Commit:** `feat(shared): add SkillFileEntry and ImportSkillResult types`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement importSkillFromFiles() in skill-utils.ts

**Verifies:** web-skills-tab.AC1.1, web-skills-tab.AC1.2, web-skills-tab.AC1.3, web-skills-tab.AC1.4, web-skills-tab.AC1.5, web-skills-tab.AC1.6

**Files:**
- Modify: `packages/agent/src/tools/skill-utils.ts` (expand from current 18-line file containing only `parseFrontmatter()`)

**Implementation:**

The function must perform these steps in order:

1. **Locate SKILL.md** — find an entry with `path === "SKILL.md"` (case-sensitive) in the file list. Return `{ ok: false, error: "SKILL.md not found in file list" }` if missing.

2. **Parse frontmatter** — call existing `parseFrontmatter(skillMdContent)`. Return error if null.

3. **Validate name** — extract `data.name`. Validate against `SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/` and `MAX_SKILL_NAME_LENGTH = 64`. Return error with specific message if invalid.

4. **Validate description** — extract `data.description`. Must exist, must be ≤ `MAX_DESCRIPTION_LENGTH = 1024` chars.

5. **Validate body** — the `body` from parseFrontmatter. Must be ≤ `MAX_SKILL_BODY_LINES = 500` lines.

6. **Validate total size** — sum of all file contents must be ≤ `MAX_FILE_SIZE_BYTES = 64 * 1024`.

7. **Check active skill cap** — query `SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0`. If count ≥ `MAX_ACTIVE_SKILLS = 20`, check if this is a re-import (existing skill with same name). If not a re-import, return error: `"Active skill cap (20) reached. Retire a skill before creating a new one."`.

8. **Compute deterministic UUID** — `deterministicUUID(BOUND_NAMESPACE, name)`.

9. **Compute content_hash** — SHA-256 hex digest of the SKILL.md `content` string.

10. **Check existing skill** — query `SELECT * FROM skills WHERE id = ? AND deleted = 0`. If found:
    - If status is `"retired"`: this is a re-activation. Use `updateRow()` to set `status: "active"`, updated `content_hash`, `activation_count: existingSkill.activation_count + 1`, `last_activated_at: now`, `activated_at: now`, `modified_at: now`, and optionally update `description`, `allowed_tools`, `compatibility` from new frontmatter.
    - If status is `"active"`: this is a content update. Use `updateRow()` with updated fields.
    - If not found: use `insertRow()` with full skill row.

11. **Persist files** — for each file in the input list:
    - Compute file path as `skills/${name}/${entry.path}` (the `skill_root` is `skills/${name}`)
    - File `id` = the full file path
    - Check if file exists (`SELECT id FROM files WHERE id = ? AND deleted = 0`)
    - If exists: `updateRow("files", id, { content, size_bytes, modified_at: now }, siteId)`
    - If not: `insertRow("files", { id, path: id, content, is_binary: 0, size_bytes, created_at: now, modified_at: now, deleted: 0, created_by: options?.threadId ?? null, host_origin: null }, siteId)`

12. **Return success** — `{ ok: true, skillId, name }`

Key imports needed:
```typescript
import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import { deterministicUUID, BOUND_NAMESPACE } from "@bound/shared";
import type { Database } from "bun:sqlite";
import type { SkillFileEntry, ImportSkillOptions, ImportSkillResult } from "@bound/shared";
```

Export the validation constants so tests can reference them:
```typescript
export const MAX_ACTIVE_SKILLS = 20;
export const MAX_SKILL_BODY_LINES = 500;
export const MAX_FILE_SIZE_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
```

**Testing:**

Tests must verify each AC listed above:
- web-skills-tab.AC1.1: Create a valid SKILL.md with name+description frontmatter, call importSkillFromFiles, verify result is `{ ok: true }` and skills row has `status: "active"`
- web-skills-tab.AC1.2: Provide SKILL.md + a `references/format.md` file, verify both files appear in the files table with correct paths
- web-skills-tab.AC1.3: Call with empty file list (no SKILL.md), verify result is `{ ok: false, error: "..." }`
- web-skills-tab.AC1.4: Call with name containing uppercase/spaces/special chars, verify validation error returned
- web-skills-tab.AC1.5: Insert 20 active skills into DB first, then try to create a 21st with a new name, verify cap error
- web-skills-tab.AC1.6: Insert a skill with `status: "retired"`, call importSkillFromFiles with same name but different content, verify status becomes "active", activation_count increments, content_hash updates

Test file: `packages/agent/src/tools/__tests__/skill-utils.test.ts`

Follow the existing tool test patterns:
- Use `Database(":memory:")` with `applySchema(db)` from `@bound/core`
- Set up a test `siteId` (e.g., `"test-site-001"`)
- Verify both the return value AND the database state
- Verify changelog entries exist for all writes

**Verification:**

Run: `bun test packages/agent/src/tools/__tests__/skill-utils.test.ts`
Expected: All tests pass

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): implement importSkillFromFiles shared service`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Export importSkillFromFiles from @bound/agent package

**Files:**
- Modify: `packages/agent/src/index.ts` (add export for `importSkillFromFiles` and the validation constants)

**Implementation:**

Add to the existing exports in `packages/agent/src/index.ts`:

```typescript
export {
	parseFrontmatter,
	importSkillFromFiles,
	MAX_ACTIVE_SKILLS,
	MAX_SKILL_BODY_LINES,
	MAX_FILE_SIZE_BYTES,
	MAX_DESCRIPTION_LENGTH,
	SKILL_NAME_REGEX,
	MAX_SKILL_NAME_LENGTH,
} from "./tools/skill-utils.js";
```

Note: `parseFrontmatter` is already exported from this file (line 112). Update the existing export to include the new symbols from `skill-utils.ts`.

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): export importSkillFromFiles from package`
<!-- END_TASK_3 -->
