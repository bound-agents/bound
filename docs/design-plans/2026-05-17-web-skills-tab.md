# Web Skills Tab Design

## Summary

This design introduces a browser-based Skills management interface for the Bound web UI. Skills are reusable agent capabilities defined in SKILL.md files (with optional supplementary reference files) that extend the agent's behavior. Currently, skills can only be managed via CLI (`boundctl skill`) or agent commands (`skill activate`). This design adds a "06 Skills" navigation tab where operators can list, view, create, retire, and re-activate skills through a graphical interface.

The implementation centers on a shared service function that encapsulates all skill validation and persistence logic. Three callers (web API, CLI, agent) each resolve files from their respective IO layers — HTTP multipart form data, filesystem, or virtual filesystem — then delegate to this common function. The web surface adds REST endpoints for CRUD operations, corresponding BoundClient methods for the TypeScript client library, and Svelte 5 components (SkillsView list + SkillCreateModal form). Skill creation supports two modes: a structured form (name, description, body editor with optional advanced fields) and file upload (single .md file or .zip archive). Content is rendered as formatted markdown using the existing rendering pipeline from the Files tab. The design follows all existing patterns in the web UI: hash-based routing, DataTable with expandable rows, 5-second polling, StatusChip for status display, and the change-log outbox pattern for database writes.

## Definition of Done

A new "Skills" tab in the web UI (metro-themed navigation entry "06 Skills") that enables operators to list, view, create, retire, and re-activate skills through the browser. Creation is supported via two methods: a structured form (name + description + body editor, with expandable Advanced section for allowed_tools and compatibility) and file upload (single SKILL.md or zip archive toggle). Skill content is displayed as rendered markdown, reusing the rendering logic from the Files tab (extracting it into a shared component if needed). The feature is backed by new REST API endpoints and corresponding BoundClient methods, following existing UI patterns (DataTable, StatusChip, polling).

## Acceptance Criteria

### web-skills-tab.AC1: Shared service validates and persists skills correctly
- **web-skills-tab.AC1.1 Success:** Valid SKILL.md with correct frontmatter (name + description) creates a skill with status "active"
- **web-skills-tab.AC1.2 Success:** Multi-file skill (SKILL.md + reference files) persists all files to the files table
- **web-skills-tab.AC1.3 Failure:** Missing SKILL.md in file list returns error
- **web-skills-tab.AC1.4 Failure:** Invalid name format (uppercase, spaces, special chars) returns validation error
- **web-skills-tab.AC1.5 Failure:** Exceeding 20 active skill cap returns cap-exceeded error
- **web-skills-tab.AC1.6 Success:** Re-importing a retired skill re-activates it with updated content and incremented activation_count

### web-skills-tab.AC2: REST API handles all operations
- **web-skills-tab.AC2.1 Success:** GET /api/skills returns all non-deleted skills
- **web-skills-tab.AC2.2 Success:** GET /api/skills?status=active returns only active skills
- **web-skills-tab.AC2.3 Success:** GET /api/skills/:id returns skill metadata, SKILL.md content, and file list
- **web-skills-tab.AC2.4 Success:** POST /api/skills with JSON body creates skill from form fields
- **web-skills-tab.AC2.5 Success:** POST /api/skills with multipart .md file creates skill
- **web-skills-tab.AC2.6 Success:** POST /api/skills with multipart .zip creates skill from archive
- **web-skills-tab.AC2.7 Success:** POST /api/skills/:id/retire sets status to retired
- **web-skills-tab.AC2.8 Success:** POST /api/skills/:id/activate re-activates a retired skill
- **web-skills-tab.AC2.9 Failure:** POST /api/skills/:id/retire on non-existent skill returns 404
- **web-skills-tab.AC2.10 Failure:** POST /api/skills/:id/activate on non-existent skill returns 404

### web-skills-tab.AC3: UI provides full skill management
- **web-skills-tab.AC3.1 Success:** "06 Skills" tab appears in navigation and routes to SkillsView
- **web-skills-tab.AC3.2 Success:** Skills list displays name, status chip, description, and last activated time
- **web-skills-tab.AC3.3 Success:** Status filter toggles between all/active/retired views
- **web-skills-tab.AC3.4 Success:** Expanding a row shows full detail (allowed_tools, compatibility, activation_count, content_hash)
- **web-skills-tab.AC3.5 Success:** "View Content" in expanded row renders SKILL.md as formatted markdown
- **web-skills-tab.AC3.6 Success:** Retire action on active skill sets it to retired (with optional reason)
- **web-skills-tab.AC3.7 Success:** Re-activate action on retired skill sets it back to active
- **web-skills-tab.AC3.8 Success:** "Create Skill" button opens SkillCreateModal
- **web-skills-tab.AC3.9 Success:** Form mode creates skill with name, description, body, and optional advanced fields
- **web-skills-tab.AC3.10 Success:** Upload mode (single file) creates skill from .md file
- **web-skills-tab.AC3.11 Success:** Upload mode (zip) creates skill from .zip archive
- **web-skills-tab.AC3.12 Failure:** Invalid form input shows inline validation error before submission

### web-skills-tab.AC4: Zip extraction is secure
- **web-skills-tab.AC4.1 Failure:** Zip entry with `../` in path is rejected with 400
- **web-skills-tab.AC4.2 Failure:** Zip entry with absolute path is rejected with 400
- **web-skills-tab.AC4.3 Failure:** Zip without SKILL.md at root is rejected with 400
- **web-skills-tab.AC4.4 Failure:** Zip exceeding 64KB total extracted size is rejected with 400

### web-skills-tab.AC5: Content rendering works correctly
- **web-skills-tab.AC5.1 Success:** SKILL.md with code blocks renders with syntax highlighting
- **web-skills-tab.AC5.2 Success:** SKILL.md with headers, lists, and tables renders formatted HTML
- **web-skills-tab.AC5.3 Success:** Supplementary files (references/) displayed as path + size list

### web-skills-tab.AC6: CLI and agent refactored to shared service
- **web-skills-tab.AC6.1 Success:** `boundctl skill import` produces identical results after refactoring
- **web-skills-tab.AC6.2 Success:** Agent `skill activate` produces identical results after refactoring

## Glossary

- **Skill**: A reusable agent capability defined by a SKILL.md file with YAML frontmatter (name, description, optional allowed_tools, compatibility) and markdown body text. Stored in the synced `skills` table.
- **SKILL.md**: The required entry file for a skill. Contains YAML frontmatter between `---` delimiters followed by markdown content. The agent reads this during context assembly.
- **Frontmatter**: YAML metadata at the top of a markdown file, delimited by `---` lines. Used to declare skill name, description, allowed_tools, and compatibility constraints.
- **fflate**: A zero-dependency JavaScript compression library. Used to extract `.zip` archives uploaded via the web UI.
- **Hono**: A lightweight web framework for building HTTP APIs. Used for all REST endpoints in Bound's web server.
- **Svelte 5**: A reactive UI framework using runes (`$state()`, `$derived()`) for state management. All Bound web UI components are written in Svelte 5.
- **DataTable**: A reusable Svelte component in the web UI that displays tabular data with sorting, filtering, and expandable row details.
- **StatusChip**: A reusable Svelte component that displays status strings as color-coded badges (active=green, retired=gray, etc.).
- **BoundClient**: A TypeScript HTTP/WebSocket client library in `packages/client` that wraps all REST API calls. Used by the web UI and external consumers.
- **Change-log outbox pattern**: The mandatory pattern for writing to synced tables. All writes use `insertRow()`, `updateRow()`, or `softDelete()` from `@bound/core` to generate changelog entries for cross-host replication.
- **Synced table**: A SQLite table whose changes replicate across hosts via the change-log outbox. The `skills` table is synced (LWW reducer).
- **LWW (Last-Write-Wins)**: A conflict resolution strategy for synced tables. Updates with later `modified_at` timestamps overwrite earlier ones.
- **Deterministic UUID**: A UUIDv5 generated from a namespace and a canonical key (e.g., skill name). Ensures the same skill name produces the same UUID across all hosts.
- **Content hash**: A SHA-256 digest of SKILL.md content. Used to detect whether a skill's definition has changed when re-importing.
- **VFS (Virtual Filesystem)**: The in-memory filesystem abstraction used by the agent during command execution. Skill files are read from VFS when the agent activates a skill.
- **Multipart form data**: An HTTP content-type (`multipart/form-data`) used for file uploads. The web API's create endpoint accepts this for .md and .zip uploads.
- **marked**: A markdown parser library. Used to convert markdown to HTML for display in the web UI.
- **shiki**: A syntax highlighting library. Provides code block highlighting in rendered markdown.
- **dompurify**: A DOM sanitization library. Prevents XSS attacks by cleaning HTML before inserting it into the page via `{@html}`.

## Architecture

A shared service function `importSkillFromFiles()` in `@bound/agent` encapsulates all skill creation/import logic. It accepts an in-memory file map and handles validation, hashing, and persistence. Three callers (web route, CLI, agent) each resolve files from their respective IO layers (multipart form data, filesystem, VFS) then delegate to this function.

The web surface adds:
- REST API endpoints in `packages/web/src/server/routes/skills.ts` (Hono factory function)
- BoundClient methods in `packages/client/src/client.ts`
- SkillsView + SkillCreateModal Svelte 5 components

### Shared Service Contract

```typescript
interface SkillFileEntry {
  path: string;   // relative path within skill (e.g., "SKILL.md", "references/format.md")
  content: string; // UTF-8 file content
}

interface ImportSkillOptions {
  threadId?: string;
}

type ImportSkillResult =
  | { ok: true; skillId: string; name: string }
  | { ok: false; error: string };

function importSkillFromFiles(
  db: Database,
  siteId: string,
  files: SkillFileEntry[],
  options?: ImportSkillOptions,
): ImportSkillResult;
```

Responsibilities:
1. Locate SKILL.md at file list root
2. Parse frontmatter via `parseFrontmatter()`
3. Validate name format, description length, body line count, total size
4. Check 20 active skill cap
5. Compute deterministic UUID from name
6. Compute content_hash (SHA-256 of SKILL.md)
7. Persist files to `files` table via `insertRow`/`updateRow`
8. Upsert `skills` row via `insertRow`/`updateRow`

### REST API Contract

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| GET | `/api/skills` | List skills | `?status=active\|retired` | `Skill[]` |
| GET | `/api/skills/:id` | View skill + content | — | `{ skill, content, files: {path, size}[] }` |
| POST | `/api/skills` | Create/import | multipart or JSON | `{ skill }` |
| POST | `/api/skills/:id/retire` | Retire skill | `{ reason?: string }` | `{ skill }` |
| POST | `/api/skills/:id/activate` | Re-activate skill | — | `{ skill }` |

Create endpoint accepts two content types:
- `multipart/form-data` — file upload. Field `skillfile` contains a `.md` or `.zip` file.
- `application/json` — form submission: `{ name, description, body, allowed_tools?, compatibility? }`. Route assembles SKILL.md with generated frontmatter.

Re-activate reads existing files from the `files` table and passes them back through `importSkillFromFiles()`.

### BoundClient Methods

```typescript
listSkills(options?: { status?: SkillStatus }): Promise<Skill[]>
getSkill(id: string): Promise<{ skill: Skill; content: string; files: { path: string; size: number }[] }>
createSkill(data: FormData | SkillFormData): Promise<Skill>
retireSkill(id: string, reason?: string): Promise<Skill>
activateSkill(id: string): Promise<Skill>
```

### Component Structure

- `packages/web/src/client/views/SkillsView.svelte` — list view with DataTable, expandable rows, actions, content rendering
- `packages/web/src/client/components/SkillCreateModal.svelte` — modal with "Form" / "Upload" mode toggle

### Data Flow

```
SkillCreateModal (form/upload)
  → BoundClient.createSkill()
    → POST /api/skills (multipart or JSON)
      → [if zip] fflate.unzipSync() + path validation
      → [if JSON] assemble SKILL.md from fields
      → importSkillFromFiles(db, siteId, files)
        → parseFrontmatter() → validate → insertRow/updateRow
          → returns ImportSkillResult

SkillsView (list/view/actions)
  → BoundClient.listSkills() → GET /api/skills → SELECT from skills table
  → BoundClient.getSkill()  → GET /api/skills/:id → JOIN files table for content
  → BoundClient.retireSkill() → POST /api/skills/:id/retire → updateRow()
  → BoundClient.activateSkill() → POST /api/skills/:id/activate → importSkillFromFiles()
```

## Existing Patterns

Investigation found these patterns in the existing web UI that this design follows:

**Routing:** Hash-based routing in `App.svelte` with if/else chain. `TopBar.svelte` NAV array defines navigation entries with `{ hash, route, label }` structure.

**Route registration:** Factory functions in `packages/web/src/server/routes/` returning Hono apps, registered in `routes/index.ts`. Example: `createAdvisoriesRoutes(db, siteId)`.

**Data fetching:** Shared `BoundClient` instance with 5s polling intervals (`onMount` + `setInterval`, cleanup in `onDestroy`).

**List views:** `DataTable` component with column definitions, sorting, expandable rows via `expandedContent` snippet. `StatusChip` maps status strings to semantic colors.

**State:** Svelte 5 runes — `$state()` for mutable state, `$derived()` for computed values.

**Markdown rendering:** `renderMarkdown()` from `packages/web/src/client/lib/markdown.ts` (marked + shiki + dompurify). Used inline via dynamic import + `{@html}`, with `:global(.md-content)` CSS rules per consuming component. No extraction needed.

**Error responses:** All API errors return `{ error: string; details?: unknown }` with appropriate HTTP status codes.

**DB writes:** All synced table writes use `insertRow`/`updateRow`/`softDelete` from `@bound/core` (outbox pattern).

**No new patterns introduced.** This design follows all existing conventions.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Shared Service Extraction

**Goal:** Extract source-agnostic skill import logic into a reusable function

**Components:**
- `importSkillFromFiles()` in `packages/agent/src/tools/skill-utils.ts` — the shared service function
- `SkillFileEntry` and `ImportSkillResult` types in `packages/shared/src/types.ts`
- Unit tests in `packages/agent/src/tools/__tests__/skill-utils.test.ts`

**Dependencies:** None (first phase)

**Done when:** `importSkillFromFiles()` validates input, persists to DB, and returns correct results for success, validation failure, and cap-exceeded cases. Tests pass covering `web-skills-tab.AC1.1`, `web-skills-tab.AC1.2`, `web-skills-tab.AC1.3`, `web-skills-tab.AC1.4`, `web-skills-tab.AC1.5`, `web-skills-tab.AC1.6`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: REST API + BoundClient

**Goal:** HTTP endpoints for skill CRUD and corresponding client methods

**Components:**
- `packages/web/src/server/routes/skills.ts` — Hono route factory (`createSkillsRoutes`)
- Route registration in `packages/web/src/server/routes/index.ts`
- BoundClient methods in `packages/client/src/client.ts`
- `fflate` dependency for zip extraction in the create endpoint
- Integration tests for API endpoints

**Dependencies:** Phase 1 (shared service for create endpoint)

**Done when:** All five endpoints respond correctly, zip upload extracts and validates paths, JSON body assembles valid SKILL.md, BoundClient methods call endpoints correctly. Tests pass covering `web-skills-tab.AC2.1` through `web-skills-tab.AC2.8`, `web-skills-tab.AC4.1` through `web-skills-tab.AC4.4`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: UI Routing + SkillsView

**Goal:** Skills tab visible in navigation, list view with filtering, expanded detail, content rendering, and retire/re-activate actions

**Components:**
- `packages/web/src/client/views/SkillsView.svelte` — main view component
- Route addition in `packages/web/src/client/App.svelte`
- Nav entry in `packages/web/src/client/components/TopBar.svelte`
- Scoped CSS for `.skill-content` markdown rendering

**Dependencies:** Phase 2 (API + client methods)

**Done when:** Skills tab navigable, list displays with filtering and sorting, expanded row shows detail + rendered markdown content, retire and re-activate actions work with confirmation UX. Covers `web-skills-tab.AC3.1` through `web-skills-tab.AC3.7`, `web-skills-tab.AC5.1` through `web-skills-tab.AC5.3`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: SkillCreateModal

**Goal:** Modal for creating skills via form or file upload

**Components:**
- `packages/web/src/client/components/SkillCreateModal.svelte` — modal with dual modes
- Client-side validation logic (name regex, description counter, file type enforcement)

**Dependencies:** Phase 2 (API create endpoint), Phase 3 (modal trigger from SkillsView)

**Done when:** Form mode creates skills with all fields, upload mode handles single .md and .zip files, client-side validation provides immediate feedback, server errors display in modal. Covers `web-skills-tab.AC3.8` through `web-skills-tab.AC3.12`.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: CLI/Agent Refactor

**Goal:** Refactor existing CLI and agent skill handlers to use the shared service

**Components:**
- `packages/cli/src/commands/skill.ts` — refactor `skillImport` to read files then call `importSkillFromFiles()`
- `packages/agent/src/tools/skill.ts` — refactor `handleActivate` to read from VFS then call `importSkillFromFiles()`
- Existing tests updated to verify behavior unchanged

**Dependencies:** Phase 1 (shared service)

**Done when:** CLI import and agent activate produce identical results as before refactoring. Existing skill tests pass without modification (behavior preserved). Covers `web-skills-tab.AC6.1`, `web-skills-tab.AC6.2`.
<!-- END_PHASE_5 -->

## Additional Considerations

**Zip security:** fflate's `unzipSync()` returns a flat map of path→content. All paths are validated before processing: reject entries containing `../`, starting with `/`, containing null bytes, or containing backslashes. Total extracted size must not exceed 64KB.

**Re-activation with missing files:** If a skill's files were lost from the `files` table (data corruption, partial sync), re-activate returns 500 with a message directing the user to re-import. This is an exceptional case — files are synced and should not disappear under normal operation.

**Polling vs WebSocket:** The 5s polling interval matches existing views. WebSocket push could reduce latency but would introduce a new pattern. Polling is sufficient for skill management frequency.
