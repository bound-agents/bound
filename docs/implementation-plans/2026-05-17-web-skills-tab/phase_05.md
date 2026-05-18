# Web Skills Tab — Phase 5: CLI/Agent Refactor

**Goal:** Refactor existing CLI and agent skill handlers to delegate validation and persistence to the shared `importSkillFromFiles()` service function

**Architecture:** Each caller (CLI, agent) retains its IO layer (filesystem reading, VFS reading) but replaces all validation, file persistence, and skills table upsert logic with a single call to `importSkillFromFiles()`. This ensures identical behavior regardless of the entry point.

**Tech Stack:** TypeScript, `importSkillFromFiles()` from `@bound/agent`, node:fs (CLI), VFS (agent)

**Scope:** 5 phases from original design (phase 5 of 5)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### web-skills-tab.AC6: CLI and agent refactored to shared service
- **web-skills-tab.AC6.1 Success:** `boundctl skill import` produces identical results after refactoring
- **web-skills-tab.AC6.2 Success:** Agent `skill activate` produces identical results after refactoring

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Refactor CLI skillImport to use importSkillFromFiles

**Verifies:** web-skills-tab.AC6.1

**Files:**
- Modify: `packages/cli/src/commands/skill.ts` (lines 249-397, the `skillImport` function)

**Implementation:**

The existing `skillImport` function performs:
1. Directory existence check (lines 256-264) — **KEEP** (IO-specific)
2. Read SKILL.md (line 270) — **KEEP** (IO-specific)
3. Parse frontmatter + validate name/description (lines 275-288) — **REMOVE** (moved to shared service)
4. Collect all files recursively via `collectFiles()` (existing helper, lines 223-243) — **KEEP** (IO-specific)
5. File persistence loop (lines 296-338) — **REMOVE** (moved to shared service)
6. Skills row upsert (lines 340-394) — **REMOVE** (moved to shared service)

**Refactored function should:**

1. Check directory exists (keep existing `statSync` logic)
2. Read SKILL.md from `join(localPath, "SKILL.md")` (keep existing `readFileSync`)
3. Collect all files via existing `collectFiles(localPath)` helper
4. Convert to `SkillFileEntry[]` format:
   ```typescript
   const files: SkillFileEntry[] = [
     { path: "SKILL.md", content: skillMdContent },
     ...collectedFiles
       .filter(f => f.relPath !== "SKILL.md")  // avoid duplicate
       .map(f => ({ path: f.relPath, content: f.content })),
   ];
   ```
5. Call `importSkillFromFiles(db, siteId, files)`
6. Handle result:
   - If `result.ok`: log success message (same output as before)
   - If `!result.ok`: throw or log error (same behavior as before)

**Import changes:**
```typescript
import { importSkillFromFiles } from "@bound/agent";
import type { SkillFileEntry } from "@bound/shared";
```

**Remove:**
- Direct `insertRow`/`updateRow` calls for files and skills tables
- Validation logic (name regex, description check, frontmatter parsing)
- SHA-256 hash computation
- Deterministic UUID generation
- Active skill cap check

**Keep:**
- `collectFiles()` helper function (still needed for IO)
- Directory existence check
- SKILL.md readability check
- Console output for success/failure

**Testing:**

Run existing test: `bun test packages/cli/src/__tests__/skill-cli.test.ts`
Expected: All existing tests pass without modification (behavior preserved)

The existing tests at `packages/cli/src/__tests__/skill-cli.test.ts` (lines 265-332) test:
- `skillImport` writes files and creates skill row (AC4.5)
- `skillImport` rejects invalid SKILL.md (AC4.6)

These tests verify end-to-end behavior (filesystem → DB), which should be unchanged.

**Verification:**

Run: `bun test packages/cli/src/__tests__/skill-cli.test.ts`
Expected: All tests pass (behavior identical to before)

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `refactor(cli): use importSkillFromFiles for skill import`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Refactor agent handleActivate to use importSkillFromFiles

**Verifies:** web-skills-tab.AC6.2

**Files:**
- Modify: `packages/agent/src/tools/skill.ts` (lines 77-261, the `handleActivate` function)

**Implementation:**

The existing `handleActivate` function performs:
1. VFS availability check (lines 81-83) — **KEEP** (IO-specific)
2. Name format validation (lines 93-98) — **REMOVE** (moved to shared service)
3. SKILL.md reading from VFS (lines 101-106) — **KEEP** (IO-specific)
4. File size check (lines 109-112) — **REMOVE** (moved to shared service)
5. Frontmatter parsing + validation (lines 115-139) — **REMOVE** (moved to shared service)
6. Active skill cap check (lines 141-150) — **REMOVE** (moved to shared service)
7. File persistence loop from VFS (lines 154-202) — **REMOVE** (moved to shared service)
8. Skills row upsert (lines 204-258) — **REMOVE** (moved to shared service)
9. Return success message (line 260) — **KEEP** (caller-specific)

**Refactored function should:**

1. Check `ctx.fs` exists (keep existing check)
2. Validate skill name is provided in input (basic input check, keep)
3. Construct `skillRoot` path: `${ctx.fs.getBasePath?.() ?? "/home/user"}/skills/${input.name}` (derive from existing logic)
4. Collect all files from VFS under skillRoot:
   ```typescript
   const allPaths = ctx.fs.getAllPaths().filter(p => p.startsWith(skillRoot + "/"));
   const files: SkillFileEntry[] = [];
   for (const filePath of allPaths) {
     const content = await ctx.fs.readFile(filePath);
     const relativePath = filePath.slice(skillRoot.length + 1); // strip "skills/name/" prefix
     files.push({ path: relativePath, content });
   }
   ```
5. Call `importSkillFromFiles(ctx.db, ctx.siteId, files, { threadId: ctx.threadId })`
6. Handle result:
   - If `result.ok`: return success message (same format as before: `"Skill '${result.name}' activated successfully."`)
   - If `!result.ok`: return error message (same format)

**Import changes:**
```typescript
import { importSkillFromFiles } from "./skill-utils.js";
import type { SkillFileEntry } from "@bound/shared";
```

**Remove:**
- All validation constants (already exported from skill-utils.ts in Phase 1)
- Validation logic duplicated from shared service
- Direct `insertRow`/`updateRow` calls for files and skills tables
- SHA-256 hash computation
- Deterministic UUID generation
- Active skill cap check

**Keep:**
- VFS availability check (`if (!ctx.fs)`)
- Input name presence check (tool-specific: LLM might omit it)
- VFS file reading logic (async, IO-specific)
- Tool result formatting (return string)

**Testing:**

Run existing test: `bun test packages/agent/src/tools/__tests__/skill.test.ts`
Expected: All existing tests pass without modification (behavior preserved)

The existing tests at `packages/agent/src/tools/__tests__/skill.test.ts` (lines 48-169) test:
- Valid activation (creates skill, persists files)
- Missing name input
- No filesystem
- Invalid name format
- Missing frontmatter
- Missing description

These test end-to-end behavior through the tool interface, which should be unchanged.

**Verification:**

Run: `bun test packages/agent/src/tools/__tests__/skill.test.ts`
Expected: All tests pass (behavior identical to before)

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `refactor(agent): use importSkillFromFiles for skill activate`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Remove duplicated validation constants from skill.ts

**Files:**
- Modify: `packages/agent/src/tools/skill.ts` (remove constants that are now exported from skill-utils.ts)

**Implementation:**

After refactoring, `skill.ts` no longer needs its own copies of:
```typescript
const MAX_ACTIVE_SKILLS = 20;
const MAX_SKILL_BODY_LINES = 500;
const MAX_FILE_SIZE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
```

These are now exported from `./skill-utils.js` (Phase 1). If `skill.ts` still references any of them (e.g., for the early name-format check before VFS reading), import from skill-utils instead:

```typescript
import { SKILL_NAME_REGEX, MAX_SKILL_NAME_LENGTH } from "./skill-utils.js";
```

However, after refactoring, even the early name check can be removed — the shared service validates the name. The only check that should remain in `skill.ts` is whether `input.name` is provided at all (since LLM tool input might be empty).

**Verification:**

Run: `bun test packages/agent/src/tools/__tests__/skill.test.ts`
Expected: All tests pass

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `refactor(agent): remove duplicated skill validation constants`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Run full test suite to verify no regressions

**Files:**
- Test: all packages

**Implementation:**

Run the full test suite to verify that both refactored paths (CLI + agent) produce identical behavior to before, and that no other tests are broken by the changes.

**Verification:**

Run: `bun test --recursive`
Expected: All tests pass (same pass count as baseline: 3392+)

Run: `bun run typecheck`
Expected: All packages typecheck clean

**Commit:** No commit needed — this is a verification step only.
<!-- END_TASK_4 -->
