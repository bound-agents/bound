# Web Skills Tab — Phase 2: REST API + BoundClient

**Goal:** HTTP endpoints for skill CRUD and corresponding BoundClient methods

**Architecture:** A Hono route factory (`createSkillsRoutes`) registered at `/api/skills`, accepting multipart uploads (`.md` or `.zip`) and JSON form data. Zip extraction uses `fflate`. BoundClient wraps all endpoints with typed methods.

**Tech Stack:** Hono, fflate (0.8.x), TypeScript, `importSkillFromFiles()` from Phase 1

**Scope:** 5 phases from original design (phase 2 of 5)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

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

### web-skills-tab.AC4: Zip extraction is secure
- **web-skills-tab.AC4.1 Failure:** Zip entry with `../` in path is rejected with 400
- **web-skills-tab.AC4.2 Failure:** Zip entry with absolute path is rejected with 400
- **web-skills-tab.AC4.3 Failure:** Zip without SKILL.md at root is rejected with 400
- **web-skills-tab.AC4.4 Failure:** Zip exceeding 64KB total extracted size is rejected with 400

---

<!-- START_TASK_1 -->
### Task 1: Install fflate dependency

**Files:**
- Modify: `packages/web/package.json` (add fflate to dependencies)

**Implementation:**

Run `bun add fflate` from within `packages/web/`. This adds `fflate` (latest 0.8.x) as a production dependency.

**Verification:**

Run: `bun install`
Expected: Installs without errors

Run: `bun -e "import { unzipSync } from 'fflate'; console.log(typeof unzipSync)"`
Expected: Prints `function`

**Commit:** `chore(web): add fflate dependency for zip extraction`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->
<!-- START_TASK_2 -->
### Task 2: Create skills route factory with GET endpoints

**Verifies:** web-skills-tab.AC2.1, web-skills-tab.AC2.2, web-skills-tab.AC2.3

**Files:**
- Create: `packages/web/src/server/routes/skills.ts`
- Modify: `packages/web/src/server/routes/index.ts` (add skills to registerRoutes and mount)
- Modify: `packages/web/src/server/index.ts` (add `app.route("/api/skills", routes.skills)`)

**Implementation:**

Create `packages/web/src/server/routes/skills.ts` with factory function `createSkillsRoutes(db: Database): Hono`.

**GET /** — List skills:
- Read optional `?status=active|retired` query param
- Query: `SELECT * FROM skills WHERE deleted = 0` (with optional `AND status = ?`)
- Return JSON array

**GET /:id** — Get skill detail + content + file list:
- Query skill row: `SELECT * FROM skills WHERE id = ? AND deleted = 0`
- If not found: return `{ error: "Skill not found" }` with 404
- Query files: `SELECT id, path, size_bytes FROM files WHERE path LIKE ? AND deleted = 0` with pattern `skills/${skill.name}/%`
- Find the SKILL.md file content: `SELECT content FROM files WHERE path = ? AND deleted = 0` where path is `skills/${skill.name}/SKILL.md`
- Return `{ skill, content: skillMdContent, files: [{ path: relativePath, size: size_bytes }] }`
  - Relative path strips the `skills/${name}/` prefix

Register in `routes/index.ts`:
- Add `skills: createSkillsRoutes(db)` to the `registerRoutes` return object
- Import the factory

Mount in `index.ts`:
- Add `app.route("/api/skills", routes.skills)` alongside existing routes

**Testing:**

Tests in `packages/web/src/__tests__/skills-route.test.ts`:
- web-skills-tab.AC2.1: Insert 2 skills (1 active, 1 retired), GET `/`, verify both returned
- web-skills-tab.AC2.2: GET `/?status=active`, verify only active skill returned
- web-skills-tab.AC2.3: Insert skill + files, GET `/:id`, verify response contains skill metadata, SKILL.md content string, and file list with relative paths

Follow existing test patterns:
- `createDatabase(tmpPath)` + `applySchema(db)` for fresh schema
- Seed `host_meta` with `site_id`
- Use Hono `.request()` method for HTTP calls
- Clean up in afterEach

**Verification:**

Run: `bun test packages/web/src/__tests__/skills-route.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add skills route factory with GET endpoints`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add POST /api/skills create endpoint (JSON + multipart + zip)

**Verifies:** web-skills-tab.AC2.4, web-skills-tab.AC2.5, web-skills-tab.AC2.6, web-skills-tab.AC4.1, web-skills-tab.AC4.2, web-skills-tab.AC4.3, web-skills-tab.AC4.4

**Files:**
- Modify: `packages/web/src/server/routes/skills.ts` (add POST / handler)

**Implementation:**

**POST /** — Create skill. Detects content type and dispatches:

1. **JSON body** (`Content-Type: application/json`):
   - Parse body: `{ name, description, body, allowed_tools?, compatibility? }`
   - Assemble SKILL.md content (YAML frontmatter + body):
     ```
     ---
     name: {name}
     description: {description}
     allowed_tools: {allowed_tools}
     compatibility: {compatibility}
     ---
     {body}
     ```
     Only include `allowed_tools` and `compatibility` lines if the values are non-empty strings. The values are stored as-is (comma-separated for allowed_tools, e.g., `allowed_tools: tool1, tool2`).
   - Call `importSkillFromFiles(db, siteId, [{ path: "SKILL.md", content: assembled }])`

2. **Multipart** (`multipart/form-data`):
   - Get file from `formData.get("skillfile")`
   - Validate file exists and is a File instance
   - Determine type by filename extension:

   **If `.md` file:**
   - Read content as text: `await file.text()`
   - Call `importSkillFromFiles(db, siteId, [{ path: "SKILL.md", content }])`

   **If `.zip` file:**
   - Read as Uint8Array: `new Uint8Array(await file.arrayBuffer())`
   - Call `unzipSync(data)` from fflate (wrap in try/catch for invalid zip errors)
   - **Security validation on extracted paths** (before processing):
     - Reject if any path contains `../`
     - Reject if any path starts with `/`
     - Reject if any path contains null bytes (`\0`)
     - Reject if any path contains backslashes (`\`)
     - Return 400 with `{ error: "Invalid zip: path traversal detected", details: offendingPath }`
   - **Size validation**: Sum all extracted file sizes. If > 64KB, return 400 with `{ error: "Zip contents exceed 64KB limit" }`
   - **SKILL.md presence**: Check if `"SKILL.md"` key exists in the extracted map. If not, return 400 with `{ error: "Zip must contain SKILL.md at root" }`
   - Convert entries to `SkillFileEntry[]`: `Object.entries(extracted).map(([path, data]) => ({ path, content: new TextDecoder().decode(data) }))`
   - Call `importSkillFromFiles(db, siteId, files)`

3. **Response handling:**
   - If `importSkillFromFiles` returns `{ ok: true }`: query the skill row and return `c.json({ skill }, 201)`
   - If `{ ok: false }`: return `c.json({ error: result.error }, 400)`

Helper to get siteId: `db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get()` (same pattern as advisories route).

**Testing:**

Add tests to `packages/web/src/__tests__/skills-route.test.ts`:
- web-skills-tab.AC2.4: POST with JSON body `{ name: "test-skill", description: "A test", body: "Hello" }`, verify 201 + skill in DB
- web-skills-tab.AC2.5: POST with multipart `.md` file containing valid frontmatter, verify 201
- web-skills-tab.AC2.6: POST with multipart `.zip` containing SKILL.md, verify 201

For zip tests, construct zip data programmatically using fflate's `zipSync`:
```typescript
import { zipSync } from "fflate";
const zipData = zipSync({
  "SKILL.md": new TextEncoder().encode("---\nname: zip-skill\ndescription: From zip\n---\nBody"),
});
```

Security tests (AC4):
- web-skills-tab.AC4.1: Zip with `../etc/passwd` path → 400
- web-skills-tab.AC4.2: Zip with `/absolute/path.md` → 400
- web-skills-tab.AC4.3: Zip without SKILL.md → 400
- web-skills-tab.AC4.4: Zip with >64KB total content → 400

**Verification:**

Run: `bun test packages/web/src/__tests__/skills-route.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add POST /api/skills with JSON, multipart, and zip support`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add POST retire and activate endpoints

**Verifies:** web-skills-tab.AC2.7, web-skills-tab.AC2.8, web-skills-tab.AC2.9, web-skills-tab.AC2.10

**Files:**
- Modify: `packages/web/src/server/routes/skills.ts` (add POST /:id/retire and /:id/activate)

**Implementation:**

**POST /:id/retire** — Retire a skill:
- Query: `SELECT * FROM skills WHERE id = ? AND deleted = 0`
- If not found: return `c.json({ error: "Skill not found" }, 404)`
- Parse optional body: `{ reason?: string }`
- Call `updateRow(db, "skills", id, { status: "retired", retired_reason: reason ?? null, retired_by: "web", modified_at: new Date().toISOString() }, siteId)`
- Return updated skill row

**POST /:id/activate** — Re-activate a retired skill:
- Query: `SELECT * FROM skills WHERE id = ? AND deleted = 0`
- If not found: return `c.json({ error: "Skill not found" }, 404)`
- Query skill files: `SELECT path, content FROM files WHERE path LIKE ? AND deleted = 0` with pattern `skills/${skill.name}/%`
- If no files found: return `c.json({ error: "Skill files not found. Re-import the skill." }, 500)`
- Convert to `SkillFileEntry[]` (strip `skills/${name}/` prefix from paths)
- Call `importSkillFromFiles(db, siteId, files)`
- If result.ok: return updated skill row
- If !result.ok: return `c.json({ error: result.error }, 400)`

**Testing:**

Add tests to `packages/web/src/__tests__/skills-route.test.ts`:
- web-skills-tab.AC2.7: Create active skill, POST `/:id/retire`, verify status changes to "retired"
- web-skills-tab.AC2.8: Create retired skill with files, POST `/:id/activate`, verify status changes to "active" and activation_count increments
- web-skills-tab.AC2.9: POST `/:id/retire` with non-existent UUID → 404
- web-skills-tab.AC2.10: POST `/:id/activate` with non-existent UUID → 404

**Verification:**

Run: `bun test packages/web/src/__tests__/skills-route.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add skill retire and activate endpoints`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Add BoundClient skill methods

**Files:**
- Modify: `packages/client/src/client.ts` (add 5 methods to BoundClient class)

**Implementation:**

Add the following methods to the `BoundClient` class, following the existing `fetchJson<T>()` pattern:

```typescript
async listSkills(options?: { status?: string }): Promise<Skill[]> {
	const params = new URLSearchParams();
	if (options?.status) params.set("status", options.status);
	const qs = params.toString();
	return this.fetchJson(`/api/skills${qs ? `?${qs}` : ""}`);
}

async getSkill(id: string): Promise<{ skill: Skill; content: string; files: { path: string; size: number }[] }> {
	return this.fetchJson(`/api/skills/${id}`);
}

async createSkill(data: FormData | { name: string; description: string; body: string; allowed_tools?: string; compatibility?: string }): Promise<{ skill: Skill }> {
	if (data instanceof FormData) {
		return this.fetchJson("/api/skills", {
			method: "POST",
			body: data,
		});
	}
	return this.fetchJson("/api/skills", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
}

async retireSkill(id: string, reason?: string): Promise<{ skill: Skill }> {
	return this.fetchJson(`/api/skills/${id}/retire`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason }),
	});
}

async activateSkill(id: string): Promise<{ skill: Skill }> {
	return this.fetchJson(`/api/skills/${id}/activate`, {
		method: "POST",
	});
}
```

Import `Skill` type from `@bound/shared` (it should already be imported — verify and add if missing).

Note: `createSkill` handles both FormData (for file upload from browser) and plain object (for JSON form submission). When FormData is passed, do NOT set Content-Type header — the browser sets it automatically with the boundary.

**Verification:**

Run: `tsc -p packages/client --noEmit`
Expected: No type errors

**Commit:** `feat(client): add BoundClient skill management methods`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Verify full API integration

**Files:**
- Test: `packages/web/src/__tests__/skills-route.test.ts` (run full suite)

**Implementation:**

Run the complete test suite to verify all endpoints work together:
- List → Create → Get → Retire → Activate → List flow
- Verify state transitions are correct end-to-end

**Verification:**

Run: `bun test packages/web/src/__tests__/skills-route.test.ts`
Expected: All tests pass (AC2.1-AC2.10, AC4.1-AC4.4)

Run: `tsc -p packages/web --noEmit && tsc -p packages/client --noEmit`
Expected: No type errors across both packages

**Commit:** No commit needed — this is a verification step only.
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->
