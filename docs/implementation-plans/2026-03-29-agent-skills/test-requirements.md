# Agent Skills — Test Requirements

This document maps every acceptance criterion from the agent-skills design plan to either an automated test or a documented human verification step. Each entry specifies the criterion ID, a brief description, the test type, the expected test file path, and what the test must verify.

**Criteria prefix:** `agent-skills.AC`

**Total criteria:** 34 (AC1.1-AC1.5, AC2.1-AC2.16, AC3.1-AC3.7, AC4.1-AC4.6, AC5.1-AC5.5)

**Phase 2 note:** Phase 2 is infrastructure only ("Verifies: None"). It produces no acceptance criteria and requires no automated tests. Verification is via `bun run typecheck` succeeding across all packages.

---

## AC1: `skills` table is schema-compliant and synced

**Test file:** `packages/core/src/__tests__/schema.test.ts`
**Phase:** 1

| Criterion | Description | Test Type | What to Verify |
|-----------|-------------|-----------|----------------|
| AC1.1 | `applySchema()` creates the `skills` table in STRICT mode with all required columns | Unit | Call `applySchema(db)`. Run `PRAGMA table_info(skills)` and verify all 17 columns are present: `id`, `name`, `description`, `status`, `skill_root`, `content_hash`, `allowed_tools`, `compatibility`, `metadata_json`, `activated_at`, `created_by_thread`, `activation_count`, `last_activated_at`, `retired_by`, `retired_reason`, `modified_at`, `deleted`. Verify the table appears in `sqlite_master` with type `table`. |
| AC1.2 | `"skills"` is in `SyncedTableName`; `TABLE_REDUCER_MAP.skills === "lww"` | Compile-time | **Not a runtime test.** TypeScript compilation (`tsc -p packages/shared --noEmit`) verifies this: `TABLE_REDUCER_MAP` is typed as `Record<SyncedTableName, ReducerType>`, so a missing `"skills"` key or incorrect value would be a compile error. The existing shared package typecheck in CI is sufficient. |
| AC1.3 | `insertRow(db, "skills", ...)` and `updateRow(db, "skills", ...)` write a change-log entry | Unit | Call `insertRow(db, "skills", {...}, siteId)`. Query `change_log WHERE row_id = skillId` and verify one entry with `table_name = 'skills'`. Call `updateRow(db, "skills", skillId, {...}, siteId)`. Verify two entries total in `change_log` for that `row_id`. |
| AC1.4 | Inserting a second active skill with the same name violates the unique index | Unit | Insert a skills row with `name = 'pr-review'`, `deleted = 0`. Attempt a second INSERT with a different `id` but the same `name` and `deleted = 0`. Expect the second insert to throw (unique index `idx_skills_name` violation). |
| AC1.5 | `applySchema()` is idempotent; running it twice does not error | Unit | Call `applySchema(db)` twice on the same database. Verify no error is thrown and the table count remains 17 (existing test updated to include `skills`). |

---

## AC2: Four agent commands behave correctly

**Test file:** `packages/agent/src/__tests__/skill-commands.test.ts`
**Phase:** 3

Test setup: follows `commands.test.ts` pattern with shared db and `CommandContext`. `ctx.fs` is set to an `InMemoryFs` from `just-bash`. InMemoryFs is reset between tests that need clean state.

| Criterion | Description | Test Type | What to Verify |
|-----------|-------------|-----------|----------------|
| AC2.1 | `skill-activate pr-review` with valid SKILL.md inserts a `skills` row with `status = 'active'` and writes skill files to the `files` table | Unit | Write valid SKILL.md to InMemoryFs at `/home/user/skills/pr-review/SKILL.md`. Call `skillActivate.handler({name: "pr-review"}, ctx)`. Verify `exitCode === 0`. Query `skills` table: row with `name = 'pr-review'`, `status = 'active'`. Query `files` table: row at path `/home/user/skills/pr-review/SKILL.md`. |
| AC2.2 | Skill files appear in `files` table before the `skills` row is upserted (early persistence ordering) | Unit | Same setup as AC2.1. After the call, verify both a `files` row and a `skills` row exist. The ordering invariant is architectural (the handler writes files first, then upserts skills). The test confirms both rows exist after the call succeeds — if either is missing, the handler is broken. |
| AC2.3 | `skill-activate` with missing SKILL.md exits non-zero and makes no DB writes | Unit | Do NOT write SKILL.md to InMemoryFs. Call `skillActivate.handler({name: "missing-skill"}, ctx)`. Verify `exitCode !== 0`. Verify no row in `skills` for `name = 'missing-skill'` and no row in `files` for that path. |
| AC2.4 | `skill-activate` with a `name` frontmatter field that does not match the directory name exits non-zero | Unit | Write SKILL.md with frontmatter `name: wrong-name` to `/home/user/skills/pr-review/SKILL.md`. Call handler with `name: "pr-review"`. Verify `exitCode !== 0`. |
| AC2.5 | `skill-activate` with no `description` in frontmatter exits non-zero | Unit | Write SKILL.md with frontmatter that has `name` but no `description`. Call handler. Verify `exitCode !== 0`. |
| AC2.6 | `skill-activate` when 20 skills are already active exits non-zero with a cap-exceeded message | Unit | Pre-insert 20 active skills directly into the `skills` table via raw INSERT. Write a valid SKILL.md for a 21st skill. Call handler. Verify `exitCode !== 0` and `stderr` contains a cap-exceeded message. |
| AC2.7 | `skill-activate` on a previously retired skill transitions it back to `active` (upsert, no duplicate row) | Unit | Activate a skill, then retire it via `updateRow`. Re-activate with `skillActivate.handler`. Verify `exitCode === 0`, `status = 'active'`. Verify only one row in `skills` for that name. |
| AC2.8 | Skill ID is `deterministicUUID(BOUND_NAMESPACE, name)`; same name always produces the same UUID | Unit | Activate the same skill name twice. Verify the `id` in `skills` equals `deterministicUUID(BOUND_NAMESPACE, 'pr-review')`. Verify there is exactly one row. |
| AC2.9 | `skill-list` outputs NAME / STATUS / ACTIVATIONS / LAST USED / DESCRIPTION columns | Unit | Insert a skills row. Call `skillList.handler({}, ctx)`. Verify `exitCode === 0` and `stdout` contains column headers `NAME`, `STATUS`, `ACTIVATIONS`, `LAST USED`, `DESCRIPTION`. |
| AC2.10 | `skill-list --status retired` shows only retired skills | Unit | Insert one active and one retired skill. Call `skillList.handler({status: "retired"}, ctx)`. Verify only the retired skill's name appears in stdout; the active skill's name does not. |
| AC2.11 | `skill-list --verbose` additionally shows `allowed_tools`, `compatibility`, `content_hash`, `retired_reason` | Unit | Insert a skill with `allowed_tools` and `content_hash` set. Call `skillList.handler({verbose: "true"}, ctx)`. Verify stdout contains `ALLOWED_TOOLS`, `CONTENT_HASH`, `RETIRED_REASON`. |
| AC2.12 | `skill-read pr-review` outputs SKILL.md content with a status/telemetry header | Unit | Activate a skill (creates files and skills rows). Call `skillRead.handler({name: "pr-review"}, ctx)`. Verify `exitCode === 0` and stdout contains the telemetry header fields (`Status:`, `Activations:`, `Hash:`) and the SKILL.md body content. |
| AC2.13 | `skill-read unknown-skill` exits non-zero | Unit | Call `skillRead.handler({name: "unknown-skill"}, ctx)`. Verify `exitCode !== 0`. |
| AC2.14 | `skill-retire pr-review` sets `status = 'retired'`, `retired_by = 'agent'` | Unit | Activate a skill. Call `skillRetire.handler({name: "pr-review"}, ctx)`. Verify `exitCode === 0`. Query `skills`: `status = 'retired'`, `retired_by = 'agent'`. |
| AC2.15 | `skill-retire pr-review --reason "..."` persists `retired_reason` | Unit | Activate a skill. Call `skillRetire.handler({name: "pr-review", reason: "Too noisy"}, ctx)`. Query `skills`: `retired_reason = 'Too noisy'`. |
| AC2.16 | `skill-retire` scans tasks for payloads containing `"skill": "pr-review"` and creates one advisory per matching task | Unit | Insert a task with `payload = '{"skill":"pr-review"}'`. Activate then retire `pr-review`. Query `advisories` table: verify one row exists with `title` containing `pr-review`. |

---

## AC3: Context assembly injects skills correctly

**Test file:** `packages/agent/src/__tests__/context-assembly.test.ts`
**Phase:** 4

Tests are added as a new `describe("skill context injection", ...)` block in the existing context assembly test file, using the same `beforeAll`/`afterAll` database setup pattern.

| Criterion | Description | Test Type | What to Verify |
|-----------|-------------|-----------|----------------|
| AC3.1 | When active skills exist, volatile context includes a `SKILLS (N active):` block | Unit | Insert an active skill row into `skills`. Call `assembleContext(...)`. Find the system message content containing `SKILLS (1 active):`. Verify it includes `{name} — {description}`. |
| AC3.2 | When no active skills exist, no SKILLS block appears in volatile context | Unit | Ensure no skills exist in DB. Call `assembleContext(...)`. Verify no system message content contains `SKILLS (`. |
| AC3.3 | Task payload with `"skill": "pr-review"` for an active skill injects SKILL.md body as system message before history | Unit | Insert an active skill + SKILL.md file + a task with `payload = '{"skill":"pr-review"}'`. Call `assembleContext({..., taskId})`. Verify one system message contains the SKILL.md content. Verify this message appears before the message history in the assembled array. |
| AC3.4 | Referenced skill not active produces volatile context note, no skill body injection | Unit | Insert a retired `pr-review` skill + a task with `payload = '{"skill":"pr-review"}'`. Call `assembleContext({..., taskId})`. Verify NO system message contains SKILL.md content. Verify the volatile context message contains `Referenced skill 'pr-review' is not active.`. |
| AC3.5 | Task skill body injection works when `noHistory = true` | Unit | Same setup as AC3.3. Call `assembleContext({..., taskId, noHistory: true})`. Verify the skill body system message IS present despite `noHistory = true`. |
| AC3.6 | Operator retirement within last 24 hours injects notification into volatile context | Unit | Insert a skill with `status = 'retired'`, `retired_by = 'operator'`, `retired_reason = 'Too aggressive'`, `modified_at` set to 1 hour ago. Call `assembleContext(...)`. Verify volatile context contains `[Skill notification] Skill '{name}' was retired by operator: "Too aggressive".`. |
| AC3.7 | Operator retirement older than 24 hours does not inject notification | Unit | Same as AC3.6 but set `modified_at` to 25 hours ago. Call `assembleContext(...)`. Verify volatile context does NOT contain `[Skill notification]`. |

---

## AC4: `boundctl skill` operator commands work

**Test file:** `packages/cli/src/__tests__/skill-cli.test.ts`
**Phase:** 6

Tests are integration tests with a temp database. Handler functions (`skillList`, `skillView`, `skillRetire`, `skillImport`) are imported and called directly. Console output is captured via `spyOn(console, 'log')`. `process.exit` is mocked for failure cases.

| Criterion | Description | Test Type | What to Verify |
|-----------|-------------|-----------|----------------|
| AC4.1 | `boundctl skill list` outputs tabular skill data with correct columns | Integration | Insert an active skill row. Spy on `console.log`. Call `skillList(db)`. Verify captured output contains column headers (`NAME`, `STATUS`) and the skill's name. |
| AC4.2 | `boundctl skill view {name}` outputs full SKILL.md content and file listing | Integration | Insert a skill row and a SKILL.md file in `files`. Spy on `console.log`. Call `skillView(db, name)`. Verify captured output includes the SKILL.md body content and the file listing. |
| AC4.3 | `boundctl skill retire {name}` sets `status = 'retired'`, `retired_by = 'operator'` with change-log entry | Integration | Insert an active skill row. Call `skillRetire(db, siteId, name)`. Query `skills`: verify `status = 'retired'`, `retired_by = 'operator'`. Query `change_log`: verify an entry exists for the skill ID. |
| AC4.4 | `boundctl skill retire {name} --reason "..."` persists the reason | Integration | Insert an active skill row. Call `skillRetire(db, siteId, name, "Too noisy")`. Query `skills`: verify `retired_reason = 'Too noisy'`. |
| AC4.5 | `boundctl skill import {path}` writes files to `files` table and inserts a `skills` row | Integration | Create a temp directory on disk with a valid `SKILL.md` (using `writeFileSync`). Call `skillImport(db, siteId, tempDir)`. Query `files` table: verify a row exists for the SKILL.md path. Query `skills` table: verify a row exists with `name` matching the frontmatter. |
| AC4.6 | `boundctl skill import` rejects invalid/missing SKILL.md frontmatter | Integration | Create a temp directory with a `SKILL.md` that has no frontmatter (plain text only). Mock `process.exit` via `spyOn(process, 'exit').mockImplementation(...)`. Call `skillImport(db, siteId, tempDir)`. Verify `process.exit` was called with code `1`. |

---

## AC5: Bundled `skill-authoring` skill is always seeded

**Test file:** `packages/agent/src/__tests__/seed-skills.test.ts`
**Phase:** 5

Tests call `seedSkillAuthoring(db, siteId)` directly against a temp database with schema applied. Follows the `schema.test.ts` setup pattern (`beforeEach` creates fresh db, `afterEach` closes and unlinks).

| Criterion | Description | Test Type | What to Verify |
|-----------|-------------|-----------|----------------|
| AC5.1 | After first startup, skill-authoring SKILL.md and format-reference.md exist in `files` table | Unit | Call `seedSkillAuthoring(db, siteId)`. Query `files` for path `/home/user/skills/skill-authoring/SKILL.md` — expect row to exist. Query for `/home/user/skills/skill-authoring/references/format-reference.md` — expect row to exist. |
| AC5.2 | `skills` table has an active `skill-authoring` row with the deterministic UUID | Unit | Call `seedSkillAuthoring(db, siteId)`. Query `skills` for `name = 'skill-authoring'`. Verify `status = 'active'`. Verify `id === deterministicUUID(BOUND_NAMESPACE, 'skill-authoring')`. |
| AC5.3 | Operator-retired `skill-authoring` stays retired after restart | Unit | Insert a `skills` row for `skill-authoring` with `status = 'retired'`, `retired_by = 'operator'` via `insertRow`. Call `seedSkillAuthoring(db, siteId)`. Re-query the row. Verify `status` is still `'retired'`. Verify no duplicate rows exist. |
| AC5.4 | Deleted skill-authoring files are restored on next startup | Unit | Call `seedSkillAuthoring(db, siteId)` once (creates files). Soft-delete the SKILL.md file: `UPDATE files SET deleted = 1 WHERE path = ?`. Call `seedSkillAuthoring(db, siteId)` again. Query `files` for the SKILL.md path with `deleted = 0` — expect a row to exist (restored). |
| AC5.5 | Content hash of seeded files matches bundled-skills.ts content | Unit | Call `seedSkillAuthoring(db, siteId)`. Query `files` for SKILL.md content. Compute `SHA-256` of `SKILL_AUTHORING_SKILL_MD` from `bundled-skills.ts`. Verify the stored content matches by hash comparison (or direct string equality). |

---

## Human Verification Requirements

No acceptance criteria in this design require human verification. All 34 criteria map to automated tests or compile-time checks:

- **AC1.2** is verified by the TypeScript compiler (`tsc -p packages/shared --noEmit`). The `TABLE_REDUCER_MAP` type is `Record<SyncedTableName, ReducerType>`, which enforces that every member of the union has a corresponding entry. This runs as part of the standard `bun run typecheck` CI step. No runtime test is needed or appropriate.

- **Phase 2** produces no acceptance criteria. It is infrastructure verified by `bun run typecheck` succeeding across all packages.

- All other criteria (AC1.1, AC1.3-AC1.5, AC2.1-AC2.16, AC3.1-AC3.7, AC4.1-AC4.6, AC5.1-AC5.5) have corresponding automated tests in the files listed above.

---

## Test File Summary

| Test File | Package | Criteria Covered | Test Count | Phase |
|-----------|---------|-----------------|------------|-------|
| `packages/core/src/__tests__/schema.test.ts` | @bound/core | AC1.1, AC1.3, AC1.4, AC1.5 | 4 new tests (+ updates to 3 existing) | 1 |
| `packages/agent/src/__tests__/skill-commands.test.ts` | @bound/agent | AC2.1-AC2.16 | 16 | 3 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | @bound/agent | AC3.1-AC3.7 | 7 | 4 |
| `packages/agent/src/__tests__/seed-skills.test.ts` | @bound/agent | AC5.1-AC5.5 | 5 | 5 |
| `packages/cli/src/__tests__/skill-cli.test.ts` | @bound/cli | AC4.1-AC4.6 | 6 | 6 |
| *(compile-time only)* | @bound/shared | AC1.2 | 0 (tsc) | 1 |

**Total automated tests:** 38 new tests across 5 files
**Compile-time checks:** 1 (AC1.2 via `tsc`)
**Human verification:** 0
