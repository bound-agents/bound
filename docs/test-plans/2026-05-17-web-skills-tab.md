# Web Skills Tab — Human Test Plan

## Prerequisites

- Local development environment running: `bun run packages/cli/src/bound.ts start` from project root (or compiled binary)
- Web UI accessible at `http://localhost:3001`
- At least one skill already activated (for list/detail tests) — can be seeded via `boundctl skill import <dir>` or via the Create Skill modal
- All automated tests passing: `bun test packages/agent/src/tools/__tests__/skill-utils.test.ts packages/web/src/__tests__/skills-route.test.ts packages/cli/src/__tests__/skill-cli.test.ts packages/agent/src/tools/__tests__/skill.test.ts`

## Phase 1: Navigation and Routing (AC3.1)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Open `http://localhost:3001` in a browser | Web UI loads with navigation sidebar |
| 1.2 | Look at the navigation sidebar/tabs | "06 Skills" is visible in the nav list, positioned after existing tabs |
| 1.3 | Click the "Skills" navigation item | URL changes to include `#/skills`, SkillsView component renders with a skill list (or empty state if no skills) |
| 1.4 | Manually navigate to `http://localhost:3001/#/skills` | Same SkillsView renders (direct URL navigation works) |

## Phase 2: Skill List Display (AC3.2, AC3.3)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Ensure at least 1 active and 1 retired skill exist in the database. Navigate to `#/skills` | DataTable renders with rows for each skill |
| 2.2 | Inspect the columns rendered | Table shows columns: Name, Status, Description, and a last-activated timestamp |
| 2.3 | Inspect the status column for an active skill | Status displayed with a colored chip/badge (accent color indicating active state) |
| 2.4 | Inspect the status column for a retired skill | Status displayed with a different color chip/badge (muted or gray, indicating retired) |
| 2.5 | Click the "All" filter button (or equivalent default state) | Both active and retired skills are shown |
| 2.6 | Click the "Active" filter button | Only skills with status "active" remain in the list; retired skills disappear |
| 2.7 | Click the "Retired" filter button | Only skills with status "retired" remain in the list; active skills disappear |
| 2.8 | Click "All" again | Full list returns |

## Phase 3: Skill Detail Expansion (AC3.4, AC3.5, AC5.1, AC5.2, AC5.3)

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Click on a skill row to expand it | Row expands to show additional detail fields |
| 3.2 | Inspect the expanded content | Fields visible: allowed_tools (or "none"), compatibility (or "any"), activation_count (integer), content_hash (hex string) |
| 3.3 | Look for a "View Content" button/link in the expanded row and click it | SKILL.md content renders as formatted HTML |
| 3.4 | Create or use a skill whose SKILL.md contains ` ```typescript ... ``` ` code blocks. View its content | Code blocks render with syntax highlighting (colored tokens — keywords, strings, etc. are distinct colors), not plain monospace |
| 3.5 | Create or use a skill whose SKILL.md contains H1-H3 headings, bullet lists, and a markdown table. View its content | H1 is largest, H3 smallest; bullet lists render as actual bullets; table renders with borders/cells |
| 3.6 | If the skill has supplementary files (references/ or other non-SKILL.md files), check the file list section | Files displayed as readable entries showing relative path (e.g., `references/format.md`) and size in human-readable format |

## Phase 4: Retire and Re-activate Actions (AC3.6, AC3.7)

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Find an active skill in the list. Click "Retire" (button or menu action) | A confirmation prompt or inline reason field appears |
| 4.2 | Enter an optional reason (e.g., "Testing retirement") and confirm | Skill status changes to "retired" in the list. Status chip updates color. No page reload required (reactive update) |
| 4.3 | Find the now-retired skill. Click "Re-activate" (button or menu action) | Skill status changes back to "active" in the list. Status chip updates color |
| 4.4 | Verify activation_count by expanding the re-activated skill | `activation_count` has incremented by 1 compared to before retirement |

## Phase 5: Skill Creation Modal (AC3.8, AC3.9, AC3.10, AC3.11, AC3.12)

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | Click the "Create Skill" button on the Skills view | Modal appears with backdrop overlay and panel. Contains a mode toggle (Form / Upload) |
| 5.2 | With Form mode selected, leave the name field empty or type an invalid name like "My Skill" | Inline validation error appears immediately (before clicking submit). Error mentions name format (lowercase, hyphens, numbers only) |
| 5.3 | With the invalid name still showing, check the submit button | Submit button is disabled (cannot click to submit) |
| 5.4 | Clear the name field and type a valid name: `test-form-skill`. Fill in description: "A skill from the form". Fill in body: `# Form Skill\n\nCreated via form.` | No validation errors. Submit button becomes enabled |
| 5.5 | Expand "Advanced" section (if present) and fill in allowed_tools: `tool1,tool2` | Field accepts the comma-separated value |
| 5.6 | Click Submit | Modal closes. New skill `test-form-skill` appears in the skills list with status "active" |
| 5.7 | Switch to Upload mode in the Create Skill modal | File input area appears (drag-and-drop zone or file picker) |
| 5.8 | Prepare a valid `.md` file on disk with content: `---\nname: upload-md-skill\ndescription: Uploaded MD\n---\n# Upload Test` and select it | File name displayed in the upload area |
| 5.9 | Click Submit | Modal closes. New skill `upload-md-skill` appears in the list |
| 5.10 | Open Create Skill modal again in Upload mode. Prepare a `.zip` file containing a valid `SKILL.md` (with frontmatter) and a `helper.ts` file. Select the zip | File name displayed in upload area |
| 5.11 | Click Submit | Modal closes. New skill (named per SKILL.md frontmatter) appears in the list |

## End-to-End: Full Skill Lifecycle

Validates the complete create-view-retire-reactivate cycle through the web UI, confirming data integrity across the stack (UI → API → shared service → SQLite).

| Step | Action | Expected |
|------|--------|----------|
| E2E.1 | Open Skills tab. Click "Create Skill". Use Form mode. Name: `lifecycle-test`, description: "Lifecycle test skill", body: `# Lifecycle\n\nFull lifecycle test.\n\n```typescript\nconst x = 1;\n``` ` | Skill created and appears in list |
| E2E.2 | Expand `lifecycle-test` row. Click "View Content" | Markdown renders with heading. Code block has syntax highlighting |
| E2E.3 | Click "Retire" on `lifecycle-test`. Enter reason: "testing lifecycle" | Status changes to "retired" |
| E2E.4 | Switch filter to "Retired" | `lifecycle-test` visible. Switch to "Active" — not visible |
| E2E.5 | Switch back to "All". Click "Re-activate" on `lifecycle-test` | Status changes to "active" |
| E2E.6 | Expand row. Verify `activation_count` is 2 | Count incremented from initial 1 to 2 |
| E2E.7 | In a separate terminal, run `boundctl skill list`. Verify `lifecycle-test` appears with status `active` | CLI shows same state as web UI (data integrity via shared service) |

## End-to-End: Security Boundary Validation (Manual)

Confirms that zip security rules enforced at the API layer also surface appropriate errors in the UI.

| Step | Action | Expected |
|------|--------|----------|
| S2E.1 | Create a zip file containing a file named `../etc/malicious.txt` alongside a valid SKILL.md. Attempt to upload via the Create Skill modal | Upload fails with an error message mentioning invalid/unsafe path (not a server error 500) |
| S2E.2 | Create a zip file exceeding 64KB total content. Attempt to upload | Upload fails with an error message mentioning size limit |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `skill-utils.test.ts` | — |
| AC1.2 | `skill-utils.test.ts` | — |
| AC1.3 | `skill-utils.test.ts` | — |
| AC1.4 | `skill-utils.test.ts` | — |
| AC1.5 | `skill-utils.test.ts` | — |
| AC1.6 | `skill-utils.test.ts` | — |
| AC2.1 | `skills-route.test.ts` | — |
| AC2.2 | `skills-route.test.ts` | — |
| AC2.3 | `skills-route.test.ts` | Phase 3 step 3.6 |
| AC2.4 | `skills-route.test.ts` | — |
| AC2.5 | `skills-route.test.ts` | — |
| AC2.6 | `skills-route.test.ts` | — |
| AC2.7 | `skills-route.test.ts` | — |
| AC2.8 | `skills-route.test.ts` | — |
| AC2.9 | `skills-route.test.ts` | — |
| AC2.10 | `skills-route.test.ts` | — |
| AC3.1 | — | Phase 1 steps 1.1-1.4 |
| AC3.2 | — | Phase 2 steps 2.1-2.4 |
| AC3.3 | — | Phase 2 steps 2.5-2.8 |
| AC3.4 | — | Phase 3 steps 3.1-3.2 |
| AC3.5 | — | Phase 3 steps 3.3-3.5 |
| AC3.6 | — | Phase 4 steps 4.1-4.2 |
| AC3.7 | — | Phase 4 steps 4.3-4.4 |
| AC3.8 | — | Phase 5 step 5.1 |
| AC3.9 | — | Phase 5 steps 5.4-5.6 |
| AC3.10 | — | Phase 5 steps 5.7-5.9 |
| AC3.11 | — | Phase 5 steps 5.10-5.11 |
| AC3.12 | — | Phase 5 steps 5.2-5.3 |
| AC4.1 | `skills-route.test.ts` | — |
| AC4.2 | `skills-route.test.ts` | — |
| AC4.3 | `skills-route.test.ts` | — |
| AC4.4 | `skills-route.test.ts` | — |
| AC5.1 | — | Phase 3 step 3.4 |
| AC5.2 | — | Phase 3 step 3.5 |
| AC5.3 | `skills-route.test.ts` (data shape) | Phase 3 step 3.6 (rendering) |
| AC6.1 | `skill-cli.test.ts` | — |
| AC6.2 | `skill.test.ts` | — |
