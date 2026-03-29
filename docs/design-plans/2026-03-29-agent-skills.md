# Agent Skills Design

## Summary

The skills system gives the agent a way to load and apply reusable, operator-curated instruction sets called skills. A skill is a directory containing a `SKILL.md` file (and optional supporting files) that describes a specialized workflow — for example, reviewing pull requests or monitoring a production deploy. Skills are stored in two layers: metadata (name, status, description, telemetry) in a new `skills` table that participates in the existing LWW-synced change-log outbox, and file content in the existing `files` table under a predictable path prefix. Both layers replicate across cluster nodes using the same mechanisms already in place for tasks, messages, and other synced data.

The agent manages its own skills through four new commands (`skill-activate`, `skill-list`, `skill-read`, `skill-retire`) that follow the same `CommandDefinition` framework used by every other built-in command. Operators can manage skills from outside the agent via `boundctl skill` subcommands. The context assembly pipeline is extended in Stage 6 to inject three pieces of skill-aware context on every turn: an index of currently active skills, the full body of a skill referenced in the current task's payload, and a short-lived notification when a skill was retired by an operator in the last 24 hours. A bundled `skill-authoring` skill is seeded on every startup to give the agent the knowledge it needs to author and activate new skills on its own.

## Definition of Done

The skills system is fully designed and ready for implementation when:

1. A `skills` table is defined (schema + sync wiring) with LWW replication, integrated into the existing `SyncedTableName` union and `TABLE_REDUCER_MAP`.
2. Four agent commands (`skill-activate`, `skill-list`, `skill-read`, `skill-retire`) are designed with full behavior contracts, validation rules, and DB interactions.
3. Context assembly is designed to inject the skill index into volatile context (Stage 6) and inject skill SKILL.md body into task contexts when a task payload contains a `"skill"` field.
4. Operator `boundctl skill` subcommands (`list`, `view`, `retire`, `import`) are designed with full behavior, output format, and DB interactions.
5. The bundled `skill-authoring` skill startup seeding is designed: `INSERT OR IGNORE` on boot, file restoration if missing, always-active status.
6. Key architectural decisions are resolved and documented: how `skill-activate` achieves early file persistence (R-SK13), and how operator retirement notifications reach the agent LLM context.

**Out of scope:** §S3.5 approval-gated mode (`proposed`/`rejected`/`deferred` states, `config/skills.json`, `boundctl skill approve/reject`). Reserved as a future extension point only.

## Acceptance Criteria

### agent-skills.AC1: `skills` table is schema-compliant and synced
- **agent-skills.AC1.1 Success:** `applySchema()` creates the `skills` table in STRICT mode with all required columns
- **agent-skills.AC1.2 Success:** `"skills"` is in `SyncedTableName`; `TABLE_REDUCER_MAP.skills === "lww"`
- **agent-skills.AC1.3 Success:** `insertRow(db, "skills", ...)` and `updateRow(db, "skills", ...)` write a change-log entry
- **agent-skills.AC1.4 Failure:** Inserting a second active skill with the same name violates the unique index
- **agent-skills.AC1.5 Edge:** `applySchema()` is idempotent; running it twice does not error

### agent-skills.AC2: Four agent commands behave correctly
- **agent-skills.AC2.1 Success:** `skill-activate pr-review` with valid SKILL.md in InMemoryFs inserts a `skills` row with `status = 'active'` and writes skill files to the `files` table
- **agent-skills.AC2.2 Success:** Skill files appear in the `files` table before the `skills` row is upserted (early persistence ordering)
- **agent-skills.AC2.3 Failure:** `skill-activate` with missing `SKILL.md` exits non-zero and makes no DB writes
- **agent-skills.AC2.4 Failure:** `skill-activate` with a `name` frontmatter field that doesn't match the directory name exits non-zero
- **agent-skills.AC2.5 Failure:** `skill-activate` with no `description` in frontmatter exits non-zero
- **agent-skills.AC2.6 Failure:** `skill-activate` when 20 skills are already active exits non-zero with a cap-exceeded message on stderr
- **agent-skills.AC2.7 Edge:** `skill-activate` on a previously retired skill transitions it back to `active` (upsert, no duplicate row)
- **agent-skills.AC2.8 Edge:** Skill ID is `deterministicUUID(BOUND_NAMESPACE, name)`; same name always produces the same UUID
- **agent-skills.AC2.9 Success:** `skill-list` outputs NAME / STATUS / ACTIVATIONS / LAST USED / DESCRIPTION columns
- **agent-skills.AC2.10 Success:** `skill-list --status retired` shows only retired skills
- **agent-skills.AC2.11 Success:** `skill-list --verbose` additionally shows `allowed_tools`, `compatibility`, `content_hash`, `retired_reason`
- **agent-skills.AC2.12 Success:** `skill-read pr-review` outputs the SKILL.md content with a status/telemetry header
- **agent-skills.AC2.13 Failure:** `skill-read unknown-skill` exits non-zero
- **agent-skills.AC2.14 Success:** `skill-retire pr-review` sets `status = 'retired'`, `retired_by = 'agent'`
- **agent-skills.AC2.15 Success:** `skill-retire pr-review --reason "..."` persists `retired_reason`
- **agent-skills.AC2.16 Success:** `skill-retire` scans `tasks` for payloads containing `"skill": "pr-review"` and creates one advisory per matching task

### agent-skills.AC3: Context assembly injects skills correctly
- **agent-skills.AC3.1 Success:** When active skills exist, volatile context includes a `SKILLS (N active):` block with one `name — description` line per skill
- **agent-skills.AC3.2 Edge:** When no active skills exist, no SKILLS block appears in volatile context
- **agent-skills.AC3.3 Success:** When `ContextParams.taskId` is set and task payload has `"skill": "pr-review"` for an active skill, the assembled messages include a system message with the SKILL.md body before the history
- **agent-skills.AC3.4 Failure:** When the referenced skill is not active, a note `"Referenced skill 'pr-review' is not active."` appears in volatile context (no skill body injection)
- **agent-skills.AC3.5 Edge:** Task skill body injection works when `noHistory = true`
- **agent-skills.AC3.6 Success:** An operator retirement within the last 24 hours injects `[Skill notification] Skill '{name}' was retired by operator: "{reason}".` into volatile context
- **agent-skills.AC3.7 Edge:** An operator retirement older than 24 hours does not inject a notification

### agent-skills.AC4: `boundctl skill` operator commands work
- **agent-skills.AC4.1 Success:** `boundctl skill list` outputs tabular skill data with correct columns
- **agent-skills.AC4.2 Success:** `boundctl skill view {name}` outputs full SKILL.md content and file listing for a known skill
- **agent-skills.AC4.3 Success:** `boundctl skill retire {name}` sets `status = 'retired'`, `retired_by = 'operator'` via `updateRow` (change-log entry created)
- **agent-skills.AC4.4 Success:** `boundctl skill retire {name} --reason "..."` persists the reason
- **agent-skills.AC4.5 Success:** `boundctl skill import {path}` writes skill files to `files` table and inserts a `skills` row for a valid local directory
- **agent-skills.AC4.6 Failure:** `boundctl skill import` rejects a directory with invalid or missing SKILL.md frontmatter

### agent-skills.AC5: Bundled `skill-authoring` skill is always seeded
- **agent-skills.AC5.1 Success:** After first startup, `/home/user/skills/skill-authoring/SKILL.md` and `references/format-reference.md` exist in the `files` table
- **agent-skills.AC5.2 Success:** The `skills` table has an active `skill-authoring` row with the deterministic UUID after first startup
- **agent-skills.AC5.3 Edge:** If the operator retired `skill-authoring`, restarting leaves it retired (`INSERT OR IGNORE` does not override)
- **agent-skills.AC5.4 Edge:** If `skill-authoring` files are deleted from the `files` table, they are restored on next startup
- **agent-skills.AC5.5 Edge:** The content hash of seeded files matches the content in `bundled-skills.ts`

## Glossary

- **LWW (Last-Write-Wins)**: A conflict-resolution strategy for distributed data where, when two nodes have diverging values for the same row, the write with the more recent `modified_at` timestamp wins. Used by all synced tables in this codebase, including `skills`.
- **Change-log outbox**: A pattern where every write to a synced table also inserts a change-log entry in the same database transaction. The sync system drains these entries to propagate changes to other cluster nodes. All writes must go through `insertRow`/`updateRow`/`softDelete` — never direct SQL — to satisfy this invariant.
- **CommandDefinition**: The interface that all built-in agent commands implement. Each definition has a name, argument schema, and a `handler(args, ctx)` function returning a `CommandResult`. The framework converts these into tools the LLM can call.
- **CommandContext (`ctx`)**: The object passed to every command handler at runtime. Contains the database handle, site ID, event bus, and (after this design) an optional `fs` field for direct filesystem access.
- **InMemoryFs**: The in-process virtual filesystem used by the agent sandbox. Files written here are visible to the agent's tool calls but are not durable until explicitly persisted to the `files` table.
- **OCC (Optimistic Concurrency Control)**: A strategy for filesystem persistence where a pre-execution snapshot (SHA-256 hash per file) is compared against the current state before committing. If nothing changed, the write is skipped as a no-op.
- **Volatile context**: A dynamically assembled system message injected on every agent turn. Contains current date/time, task state, active skill index, and other runtime information that changes turn-to-turn.
- **Stage 6 (ASSEMBLY)**: The sixth stage of the eight-stage context assembly pipeline, where the final list of messages is composed from all prior stages. Volatile context injection, skill index, task skill body, and operator retirement notifications are all added here.
- **`ContextParams`**: The parameter object passed to the context assembler. Fields like `taskId` and `platformContext` control which optional context injections are activated.
- **`deterministicUUID`**: A function that produces a UUID v5 from a namespace and a string key. Used so that activating the same skill by name always produces the same row ID, making re-activation an idempotent upsert rather than a duplicate insert.
- **`INSERT OR IGNORE`**: A SQLite statement form that inserts a row only if no conflicting row already exists. Used during startup seeding so that an operator-retired `skill-authoring` skill is not silently re-activated on restart.
- **`boundctl`**: The operator-facing CLI binary for managing a running bound instance. Distinct from the agent's own commands; `boundctl` reads and writes the database directly without going through the agent loop.
- **Advisory**: A structured notice written to the `advisories` table to inform the operator or agent of a condition requiring attention. `skill-retire` creates one advisory per task whose payload references the retired skill.
- **`noHistory`**: A `ContextParams` flag that skips Stage 1 message retrieval, used for tasks that should not include prior conversation history. Task skill body injection must work correctly even when this flag is set.
- **SKILL.md**: The required entry-point file for any skill directory. Contains YAML frontmatter (name, description, optional fields) followed by the instruction body the agent reads when the skill is active.
- **Frontmatter**: YAML metadata at the top of a Markdown file, delimited by `---`. Used in SKILL.md to declare the skill's `name`, `description`, `allowed_tools`, and `compatibility` fields.
- **`skill_root`**: The path prefix in the `files` table under which all files for a given skill are stored (e.g., `/home/user/skills/pr-review/`). The `skills` row records this path but does not embed file content.

---

## Architecture

The skills system layers on three existing subsystems without introducing new infrastructure: the `files` table (skill file storage), the context assembly pipeline (skill injection), and the `CommandDefinition` framework (agent-side management).

### Skill storage (two-layer)

Skill metadata lives in the new `skills` table, a LWW-synced table added to the existing change-log outbox infrastructure. Skill files live in the existing `files` table under the path prefix `/home/user/skills/{name}/`. The `skills` row references files via `skill_root` but does not embed content — file content is always read from the `files` table at use time.

```
skills table                        files table
──────────────────────────          ──────────────────────────────────────────────────
id (UUID5 of name)                  path: /home/user/skills/pr-review/SKILL.md
name: pr-review                     path: /home/user/skills/pr-review/scripts/diff.sh
status: active                      path: /home/user/skills/pr-review/references/checklist.md
skill_root: /home/user/skills/pr-review
description: Review GitHub PRs...
content_hash: sha256(SKILL.md)
```

### `skills` table schema

```sql
CREATE TABLE skills (
  id                TEXT PRIMARY KEY,   -- UUID5(BOUND_NAMESPACE, name)
  name              TEXT NOT NULL,      -- matches directory name
  description       TEXT NOT NULL,      -- from frontmatter
  status            TEXT NOT NULL,      -- 'active' | 'retired'
  skill_root        TEXT NOT NULL,      -- /home/user/skills/{name}
  content_hash      TEXT,               -- SHA-256 of SKILL.md
  allowed_tools     TEXT,               -- space-delimited from frontmatter
  compatibility     TEXT,               -- from frontmatter
  metadata_json     TEXT,               -- full frontmatter metadata as JSON
  activated_at      TEXT,
  created_by_thread TEXT,
  activation_count  INTEGER DEFAULT 0,
  last_activated_at TEXT,
  retired_by        TEXT,               -- NULL | 'agent' | 'operator'
  retired_reason    TEXT,
  modified_at       TEXT NOT NULL,
  deleted           INTEGER DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX idx_skills_name ON skills(name)
  WHERE deleted = 0;
```

### Early file persistence (R-SK13)

`skill-activate` must flush InMemoryFs skill files to the `files` table before upserting the `skills` row. If a sync cycle fires between these two writes, a remote host would see the `skills` row without its files. To prevent this race, `CommandContext` gains an optional `fs?: IFileSystem` field (from `just-bash`, already a direct dep of `@bound/sandbox`). In `start.ts`, `commandContext` receives the MountableFs extracted from `createClusterFs`. The `skill-activate` handler calls `fs.getAllPaths()` filtered to `/home/user/skills/{name}/`, reads each with `fs.readFile()`, and writes to the `files` table via `insertRow`/`updateRow` before upserting the `skills` row. The subsequent FS_PERSIST detects content-hash matches and skips these files as a clean no-op (OCC).

### Context assembly (three injections in Stage 6)

**Skill index** — appended to the volatile context system message on every turn:
```
SKILLS (3 active):
  pr-review — Review GitHub PRs with a structured checklist.
  daily-standup — Summarize recent thread activity for standup.
  deploy-monitor — Monitor production deploys and alert on failures.
```
Query: `SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC`. Bounded by the active skill cap (default 20, ~100 tokens per skill).

**Task skill body** — when `ContextParams.taskId` is set and the task payload contains `"skill": "{name}"`, the assembler reads `/home/user/skills/{name}/SKILL.md` from the `files` table and injects it as a system message between persona (if any) and the message history. Works with `noHistory = true` tasks (Stage 6 system messages are assembled regardless of Stage 1 history retrieval).

**Operator retirement notifications** — appended to volatile context for skills retired by an operator within the last 24 hours:
```
[Skill notification] Skill 'deploy-monitor' was retired by operator: "Too aggressive during off-hours."
```
Query: `SELECT name, retired_reason FROM skills WHERE status = 'retired' AND retired_by = 'operator' AND modified_at > datetime('now', '-24h') AND deleted = 0`. Auto-expires without any side-effecting writes during context assembly.

### Operator CLI

`boundctl skill {list|view|retire|import}` operates directly on the `skills` and `files` tables in the bound database. All writes use `updateRow`/`insertRow` for change-log outbox compliance. `boundctl skill retire` sets `retired_by = 'operator'` which triggers the 24-hour notification window.

### Bundled `skill-authoring` skill

File content for SKILL.md and `references/format-reference.md` is stored as string literals in `packages/agent/src/bundled-skills.ts`. During `runStart()`, after DB initialization, a seeding step writes these files to the `files` table if missing or stale, then does `INSERT OR IGNORE` for the `skills` row. An operator-retired `skill-authoring` stays retired across restarts (the `INSERT OR IGNORE` leaves the existing row untouched). Missing files are always restored.

---

## Existing Patterns

**Command structure:** The four new skill commands follow the `memorize`/`forget` pattern exactly — `CommandDefinition` with a `handler(args, ctx)` returning `CommandResult`. The `memorize` command demonstrates the pattern for DB-writing commands with deterministic UUIDs: `deterministicUUID(BOUND_NAMESPACE, key)` for idempotent IDs, `insertRow`/`updateRow` for synced writes, `commandSuccess`/`commandError`/`handleCommandError` from `commands/helpers.ts`.

**Synced table writes:** All writes to the `skills` table use `insertRow`/`updateRow`/`softDelete` from `packages/core/src/change-log.ts`. This is the mandatory pattern for all synced tables (invariant from CLAUDE.md).

**File persistence from InMemoryFs:** `autoCacheFile()` in `packages/sandbox/src/cluster-fs.ts` shows the exact pattern for writing InMemoryFs content to the `files` table: check for existing row, compare SHA-256 hashes, call `updateRow` or `insertRow`. The `skill-activate` early persistence uses this same logic.

**Filesystem enumeration:** `snapshotWorkspace()` in `packages/sandbox/src/cluster-fs.ts` demonstrates `fs.getAllPaths()` + `fs.readFile()` for iterating over all InMemoryFs paths. Skill-activate filters this to `/home/user/skills/{name}/`.

**Volatile context notifications:** The cross-thread file notification pattern in `context-assembly.ts` (lines 598-616) shows how to inject dynamic system notifications into the volatile context by querying semantic memory at assembly time. Operator retirement notifications follow the same in-assembly query pattern without the semantic memory indirection.

**Operator CLI commands:** `packages/cli/src/commands/set-hub.ts` and `packages/cli/src/commands/sync-status.ts` show the pattern for `boundctl` subcommands: exported async functions taking `AppContext` or a db path, registered in `boundctl.ts`.

**Deterministic UUIDs:** `deterministicUUID(BOUND_NAMESPACE, name)` from `packages/shared/src/uuid.ts` is used by `memorize` for semantic memory IDs and by `seedCronTasks` for cron task IDs. Skill IDs follow this same pattern so re-activation is always an upsert.

---

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Database Foundation

**Goal:** Add `skills` to the synced-table infrastructure so the change-log outbox works.

**Components:**
- `packages/shared/src/types.ts` — add `"skills"` to `SyncedTableName` union; add `skills: "lww"` to `TABLE_REDUCER_MAP`
- `packages/core/src/schema.ts` — add `CREATE TABLE IF NOT EXISTS skills (...)` and `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name` per the schema above

**Dependencies:** None (first phase)

**Done when:** `bun test packages/shared` and `bun test packages/core` pass; schema test verifies `skills` table creation; `insertRow(db, "skills", ...)` compiles without TypeScript errors
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: CommandContext Extension and File Infrastructure

**Goal:** Give skill commands filesystem access for early file persistence; add bundled skill content.

**Components:**
- `packages/sandbox/src/commands.ts` — add `fs?: IFileSystem` to `CommandContext` interface (import type from `just-bash`)
- `packages/cli/src/commands/start.ts` — pass `clusterFsObj` (the MountableFs) as `fs` in the `commandContext` object constructed before `createDefineCommands`
- `packages/agent/src/bundled-skills.ts` — new file containing `SKILL_AUTHORING_SKILL_MD: string` and `SKILL_AUTHORING_FORMAT_REFERENCE_MD: string` constants with the verbatim content from spec §S9.1

**Dependencies:** Phase 1

**Done when:** `bun run typecheck` succeeds across all packages; `CommandContext.fs` is accessible in command handlers; `bundled-skills.ts` exports the two string constants
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Agent Commands

**Goal:** Implement all four skill management commands the agent uses.

**Components:**
- `packages/agent/src/commands/skill-activate.ts` — validates SKILL.md, early-persists files via `ctx.fs`, upserts `skills` row; covers all validation rules from §S6.1 (name format, description length, body line count, size limit, cap check)
- `packages/agent/src/commands/skill-list.ts` — queries `skills` table, renders tabular output; `--status` filter; `--verbose` flag
- `packages/agent/src/commands/skill-read.ts` — reads SKILL.md from `files` table, prepends status/telemetry header from `skills` row
- `packages/agent/src/commands/skill-retire.ts` — updates `status`, `retired_by`, `retired_reason`; scans `tasks` for payload matches and writes advisories (R-SK14)
- `packages/agent/src/commands/index.ts` — add all four to `getAllCommands()` return array
- `packages/agent/src/context-assembly.ts` — add four entries to `AVAILABLE_COMMANDS` constant

**Dependencies:** Phase 2

**Done when:** Unit tests cover agent-skills.AC2.1–AC2.16; `bun test packages/agent` passes
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Context Assembly Integration

**Goal:** Inject skill index, task skill body, and operator retirement notifications into assembled context.

**Components:**
- `packages/agent/src/context-assembly.ts` — three additions to Stage 6 ASSEMBLY:
  1. Skill index query and injection into volatile context lines
  2. Task payload `"skill"` field check; SKILL.md body injection as system message when task context is present
  3. Operator retirement notification query (24h window) and injection into volatile context lines

**Dependencies:** Phase 3

**Done when:** Context assembly tests cover agent-skills.AC3.1–AC3.7; `bun test packages/agent` passes; no regression in existing context assembly tests
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Startup Seeding

**Goal:** Ensure `skill-authoring` is always present and active when the orchestrator starts.

**Components:**
- `packages/cli/src/commands/start.ts` — new seeding step in `runStart()`, placed after DB init and before scheduler start:
  1. Write `SKILL_AUTHORING_SKILL_MD` to `/home/user/skills/skill-authoring/SKILL.md` and `SKILL_AUTHORING_FORMAT_REFERENCE_MD` to `/home/user/skills/skill-authoring/references/format-reference.md` in the `files` table if missing or content-hash differs (restoration guard)
  2. `INSERT OR IGNORE INTO skills (...)` with `status = 'active'`, deterministic UUID, and `skill-authoring` metadata

**Dependencies:** Phase 3 (for `deterministicUUID` and `insertRow` patterns with `skills` table)

**Done when:** Startup wiring test confirms `skill-authoring` is active after first boot; confirms it stays retired if operator had retired it; confirms files are restored if deleted; agent-skills.AC5.1–AC5.5 pass
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Operator CLI

**Goal:** Expose skill management to the operator via `boundctl skill`.

**Components:**
- `packages/cli/src/commands/skill.ts` — new file with four subcommand handlers:
  - `skillList(db, opts)` — queries `skills` + file sizes from `files`, renders table
  - `skillView(db, name)` — reads SKILL.md from `files`, prints with file listing and telemetry
  - `skillRetire(db, siteId, name, reason?)` — updates `skills` row via `updateRow`; prints per-task warnings if tasks reference the skill
  - `skillImport(db, siteId, localPath, opts?)` — validates SKILL.md, writes files and skills row; for `--git`, clones to temp dir then imports
- `packages/cli/src/boundctl.ts` — register `boundctl skill <subcommand>` routing to the handlers above

**Dependencies:** Phase 1, Phase 2

**Done when:** Integration tests with a temp database cover agent-skills.AC4.1–AC4.6; `bun test packages/cli` passes
<!-- END_PHASE_6 -->

---

## Additional Considerations

**Approval-gated mode (§S3.5):** Explicitly out of scope. The two-state lifecycle (`active`/`retired`) in this design is the complete implementation. If approval-gated mode is added in a future iteration, the `skills` table schema would gain a `proposed`/`rejected`/`deferred` status branch, and `skill-activate` would check `config/skills.json` before upserting. The current schema's `status TEXT NOT NULL` field is intentionally open-ended to accommodate this extension without a migration.

**Spec alignment:** The companion spec `docs/design/specs/2026-03-29-skills.md` references `boundctl skill review` (renamed to `boundctl skill view` in this design) and describes §S3.5 approval-gated mode as opt-in. The spec should be updated to: (a) rename `review` → `view` throughout, and (b) explicitly mark §S3.5 as a future extension not included in the initial implementation.

**`commandContext.fs` typing:** `IFileSystem` from `just-bash` is used as a structural interface. The field is typed `fs?: IFileSystem` in `CommandContext`. In `start.ts`, the MountableFs (which extends `IFileSystem`) is assigned directly. Only `skill-activate` uses `ctx.fs`; all other commands ignore it. If `ctx.fs` is undefined (e.g., in tests that don't provide it), `skill-activate` returns an error indicating the filesystem is unavailable.

**Skill index and token budget:** With the default cap of 20 active skills at ~100 tokens each, the steady-state skill index overhead is ~2000 tokens. This is additive to the existing ~500-token volatile context. On the current 8000-token context budget (Stage 7 BUDGET_VALIDATION), this is manageable. If the budget is tightened in a future iteration, the skill index is the first candidate for truncation (most-recently-used skills first).
