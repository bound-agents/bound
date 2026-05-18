# Web Skills Tab — Test Requirements

Maps each acceptance criterion to automated tests or human verification.

---

## AC1: Shared service validates and persists skills correctly

All AC1 criteria are fully automatable as unit tests against the `importSkillFromFiles()` function with an in-memory SQLite database.

| AC | Text | Verification | Test Type | Test File | What to Verify |
|----|------|-------------|-----------|-----------|----------------|
| AC1.1 | Valid SKILL.md with correct frontmatter (name + description) creates a skill with status "active" | Automated | Unit | `packages/agent/src/tools/__tests__/skill-utils.test.ts` | Call `importSkillFromFiles` with valid SKILL.md containing name+description frontmatter. Assert result is `{ ok: true }` and `skills` row has `status: "active"`, correct `content_hash`, and `activation_count: 1`. |
| AC1.2 | Multi-file skill (SKILL.md + reference files) persists all files to the files table | Automated | Unit | `packages/agent/src/tools/__tests__/skill-utils.test.ts` | Provide SKILL.md + `references/format.md`, call function. Assert both files exist in `files` table with paths `skills/<name>/SKILL.md` and `skills/<name>/references/format.md`. |
| AC1.3 | Missing SKILL.md in file list returns error | Automated | Unit | `packages/agent/src/tools/__tests__/skill-utils.test.ts` | Call with empty file list or files that don't include SKILL.md. Assert result is `{ ok: false }` with error mentioning missing SKILL.md. |
| AC1.4 | Invalid name format (uppercase, spaces, special chars) returns validation error | Automated | Unit | `packages/agent/src/tools/__tests__/skill-utils.test.ts` | Call with names like "MySkill", "my skill", "my_skill!", "UPPER". Assert each returns `{ ok: false }` with a name-validation error message. |
| AC1.5 | Exceeding 20 active skill cap returns cap-exceeded error | Automated | Unit | `packages/agent/src/tools/__tests__/skill-utils.test.ts` | Insert 20 active skills into DB via `insertRow`. Attempt to create a 21st with a new name. Assert result is `{ ok: false }` with cap-exceeded error. |
| AC1.6 | Re-importing a retired skill re-activates it with updated content and incremented activation_count | Automated | Unit | `packages/agent/src/tools/__tests__/skill-utils.test.ts` | Insert a skill with `status: "retired"` and `activation_count: 1`. Call `importSkillFromFiles` with the same name but different body. Assert status becomes "active", `activation_count` becomes 2, and `content_hash` updates. |

---

## AC2: REST API handles all operations

All AC2 criteria are automatable as integration tests using Hono's `.request()` method with a fresh in-memory database.

| AC | Text | Verification | Test Type | Test File | What to Verify |
|----|------|-------------|-----------|-----------|----------------|
| AC2.1 | GET /api/skills returns all non-deleted skills | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Insert 2 skills (1 active, 1 retired, optionally 1 soft-deleted). GET `/api/skills`. Assert response contains exactly the non-deleted skills. |
| AC2.2 | GET /api/skills?status=active returns only active skills | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Insert 1 active + 1 retired skill. GET `/api/skills?status=active`. Assert response contains only the active skill. |
| AC2.3 | GET /api/skills/:id returns skill metadata, SKILL.md content, and file list | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Insert a skill + associated files. GET `/api/skills/:id`. Assert response has `skill` (metadata), `content` (SKILL.md string), and `files` array with relative paths and sizes. |
| AC2.4 | POST /api/skills with JSON body creates skill from form fields | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | POST `/api/skills` with `Content-Type: application/json` body `{ name, description, body }`. Assert 201 response with created skill, and DB contains the skill row + assembled SKILL.md in files. |
| AC2.5 | POST /api/skills with multipart .md file creates skill | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Construct FormData with a `.md` file containing valid frontmatter. POST as multipart. Assert 201 and skill created in DB. |
| AC2.6 | POST /api/skills with multipart .zip creates skill from archive | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Use `fflate.zipSync` to create a zip with SKILL.md. POST as multipart. Assert 201 and skill created in DB with correct file entries. |
| AC2.7 | POST /api/skills/:id/retire sets status to retired | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Create an active skill. POST `/api/skills/:id/retire` with optional reason body. Assert skill status changes to "retired" in both response and DB. |
| AC2.8 | POST /api/skills/:id/activate re-activates a retired skill | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Create a retired skill with files in the DB. POST `/api/skills/:id/activate`. Assert status becomes "active" and `activation_count` increments. |
| AC2.9 | POST /api/skills/:id/retire on non-existent skill returns 404 | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | POST `/api/skills/<random-uuid>/retire`. Assert 404 response with error message. |
| AC2.10 | POST /api/skills/:id/activate on non-existent skill returns 404 | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | POST `/api/skills/<random-uuid>/activate`. Assert 404 response with error message. |

---

## AC3: UI provides full skill management

AC3 criteria split between component-behavior tests (automatable via integration/unit) and visual rendering verification (human). Svelte components cannot be unit-tested in this project without a browser environment, so most AC3 items require human verification of the running application. However, the underlying behavior (API calls, state transitions) is covered by AC1/AC2 automated tests.

| AC | Text | Verification | Test Type | Test File | What to Verify |
|----|------|-------------|-----------|-----------|----------------|
| AC3.1 | "06 Skills" tab appears in navigation and routes to SkillsView | Human verification | E2E (manual) | N/A | Navigate to `#/skills` in the browser. Confirm the nav bar shows "06 Skills" and the SkillsView component renders. |
| AC3.2 | Skills list displays name, status chip, description, and last activated time | Human verification | E2E (manual) | N/A | With skills in the DB, confirm the DataTable renders columns for name, status (with accent color), description, and last_activated_at. |
| AC3.3 | Status filter toggles between all/active/retired views | Human verification | E2E (manual) | N/A | Click each filter button. Confirm the list filters correctly (matches API behavior verified by AC2.1/AC2.2). |
| AC3.4 | Expanding a row shows full detail (allowed_tools, compatibility, activation_count, content_hash) | Human verification | E2E (manual) | N/A | Click a row to expand. Confirm metadata fields (allowed_tools, compatibility, activation_count, content_hash) are visible. |
| AC3.5 | "View Content" in expanded row renders SKILL.md as formatted markdown | Human verification | E2E (manual) | N/A | Expand a skill row. Confirm SKILL.md content renders as HTML (headings, code blocks, lists) rather than raw markdown text. |
| AC3.6 | Retire action on active skill sets it to retired (with optional reason) | Human verification | E2E (manual) | N/A | Click "Retire" on an active skill, optionally enter a reason, confirm. Verify status changes to "retired" in the list. Backend behavior automated by AC2.7. |
| AC3.7 | Re-activate action on retired skill sets it back to active | Human verification | E2E (manual) | N/A | Click "Re-activate" on a retired skill. Verify status returns to "active" in the list. Backend behavior automated by AC2.8. |
| AC3.8 | "Create Skill" button opens SkillCreateModal | Human verification | E2E (manual) | N/A | Click "Create Skill" button. Confirm modal appears with backdrop, panel, and mode toggle. |
| AC3.9 | Form mode creates skill with name, description, body, and optional advanced fields | Human verification | E2E (manual) | N/A | Fill out the form with valid data (including advanced fields), submit. Confirm skill appears in list. Backend behavior automated by AC2.4. |
| AC3.10 | Upload mode (single file) creates skill from .md file | Human verification | E2E (manual) | N/A | Select a valid .md file in upload mode, submit. Confirm skill appears in list. Backend behavior automated by AC2.5. |
| AC3.11 | Upload mode (zip) creates skill from .zip archive | Human verification | E2E (manual) | N/A | Select a valid .zip file in upload mode, submit. Confirm skill appears in list. Backend behavior automated by AC2.6. |
| AC3.12 | Invalid form input shows inline validation error before submission | Human verification | E2E (manual) | N/A | Type an invalid name (e.g., "My Skill"). Confirm inline error appears immediately (before clicking submit). Confirm submit button stays disabled. |

---

## AC4: Zip extraction is secure

All AC4 criteria are fully automatable as integration tests exercising the POST endpoint with malicious zip payloads.

| AC | Text | Verification | Test Type | Test File | What to Verify |
|----|------|-------------|-----------|-----------|----------------|
| AC4.1 | Zip entry with `../` in path is rejected with 400 | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Construct zip via `fflate.zipSync` with a `"../etc/passwd"` key. POST as multipart. Assert 400 with path-traversal error message. |
| AC4.2 | Zip entry with absolute path is rejected with 400 | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Construct zip with `"/absolute/path.md"` key. POST as multipart. Assert 400 with path-traversal error message. |
| AC4.3 | Zip without SKILL.md at root is rejected with 400 | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Construct zip with files but no `SKILL.md` entry. POST as multipart. Assert 400 with "must contain SKILL.md" error. |
| AC4.4 | Zip exceeding 64KB total extracted size is rejected with 400 | Automated | Integration | `packages/web/src/__tests__/skills-route.test.ts` | Construct zip where total content exceeds 64KB (e.g., a single 65KB file). POST as multipart. Assert 400 with size-limit error. |

---

## AC5: Content rendering works correctly

AC5 criteria involve both automated verification of rendering pipeline behavior and human visual verification of the rendered output appearance.

| AC | Text | Verification | Test Type | Test File | What to Verify |
|----|------|-------------|-----------|-----------|----------------|
| AC5.1 | SKILL.md with code blocks renders with syntax highlighting | Human verification (rendering appearance) | E2E (manual) | N/A | Create a skill with code blocks (e.g., ` ```typescript ... ``` `). Expand the row and view content. Confirm code blocks have syntax-highlighted spans (colored tokens), not plain monospace text. Note: The `renderMarkdown()` function is already tested by existing usage in the Files tab; what requires verification here is that the same pipeline applies correctly to skill content. |
| AC5.2 | SKILL.md with headers, lists, and tables renders formatted HTML | Human verification (rendering appearance) | E2E (manual) | N/A | Create a skill with H1-H3, bullet lists, and a markdown table. Expand and view content. Confirm headers are sized correctly, lists are bulleted/numbered, and tables render with borders/cells. |
| AC5.3 | Supplementary files (references/) displayed as path + size list | Automated + Human | Integration + E2E (manual) | `packages/web/src/__tests__/skills-route.test.ts` (data) / manual (rendering) | **Automated**: AC2.3 already verifies the API returns file list with `path` and `size` fields for supplementary files. **Human**: Verify the expanded row renders the file list as readable path + size entries (not raw JSON). |

---

## AC6: CLI and agent refactored to shared service

All AC6 criteria are automatable by running existing tests that verify end-to-end behavior. The tests should pass without modification, confirming the refactoring preserves identical behavior.

| AC | Text | Verification | Test Type | Test File | What to Verify |
|----|------|-------------|-----------|-----------|----------------|
| AC6.1 | `boundctl skill import` produces identical results after refactoring | Automated | Integration | `packages/cli/src/__tests__/skill-cli.test.ts` | Run existing CLI skill tests. Assert all pass without modification. Tests cover: skill import writes files and creates skill row, rejects invalid SKILL.md. |
| AC6.2 | Agent `skill activate` produces identical results after refactoring | Automated | Unit | `packages/agent/src/tools/__tests__/skill.test.ts` | Run existing agent skill tests. Assert all pass without modification. Tests cover: valid activation, missing name input, no filesystem, invalid name format, missing frontmatter, missing description. |

---

## Summary

| Category | Total ACs | Automated | Human Verification | Both |
|----------|-----------|-----------|-------------------|------|
| AC1 (Shared service) | 6 | 6 | 0 | 0 |
| AC2 (REST API) | 10 | 10 | 0 | 0 |
| AC3 (UI management) | 12 | 0 | 12 | 0 |
| AC4 (Zip security) | 4 | 4 | 0 | 0 |
| AC5 (Content rendering) | 3 | 0 | 2 | 1 |
| AC6 (CLI/agent refactor) | 2 | 2 | 0 | 0 |
| **Total** | **37** | **22** | **14** | **1** |

### Notes on UI verification (AC3, AC5)

While AC3 and AC5 are listed as human verification, the underlying data and behavior they depend on are fully covered by automated AC1, AC2, and AC4 tests. The human verification confirms:

1. **Component wiring** -- that the Svelte component correctly calls the BoundClient methods (already tested at the API layer)
2. **Visual rendering** -- that CSS/HTML produces the expected visual appearance
3. **Interaction flow** -- that click handlers, state transitions, and conditional rendering work in the browser

If Playwright e2e tests are added in the future, AC3.1-AC3.12 and AC5.1-AC5.3 could be automated by testing DOM structure and class presence (though visual appearance would still benefit from human review).
