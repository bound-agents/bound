# Human Test Plan: VFS Full Persistence

**Feature:** VFS Full Persistence (vfs-full-persist)
**Generated:** 2026-03-29
**Plan:** docs/implementation-plans/2026-03-29-vfs-full-persist/

## Prerequisites

- Bun runtime installed (the project's package manager/runtime)
- Working checkout of the `vfs-full-persist` branch
- All automated tests passing:
  ```
  bun test --recursive
  ```
- Familiarity with the project's CLI: `bun packages/cli/src/bound.ts start`

## Phase 1: Virtual Filesystem Enumeration

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Start the application with `bun packages/cli/src/bound.ts start` in a fresh data directory | Application starts without errors, database is initialized |
| 1.2 | Send a message asking the agent to create a file: "Write the text 'hello world' to /tmp/test-output.txt" | Agent executes a bash command writing to `/tmp/test-output.txt`, responds confirming the write |
| 1.3 | After the loop completes, open the web UI (default `http://localhost:3000`) and navigate to the Files tab | `/tmp/test-output.txt` appears in the file tree under a `tmp` root node with content "hello world" |
| 1.4 | Send another message: "Create a Python file at /workspace/myproject/main.py with a hello-world script" | Agent writes the file; after loop completes, `/workspace/myproject/main.py` appears in the Files tab under a `workspace` root node |
| 1.5 | Send a message: "Write some notes to /home/user/notes.txt" | Agent writes the file; after loop completes, `/home/user/notes.txt` appears under the `home` root node — confirms no regression on existing path handling |

## Phase 2: Restart Persistence

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | With files from Phase 1 present in the Files tab, stop the application (Ctrl+C) | Application exits cleanly |
| 2.2 | Restart the application with the same data directory: `bun packages/cli/src/bound.ts start` | Application starts, logs indicate workspace hydration |
| 2.3 | Open the web UI Files tab | All three files from Phase 1 (`/tmp/test-output.txt`, `/workspace/myproject/main.py`, `/home/user/notes.txt`) are present with their original content |
| 2.4 | Send a message referencing one of the previously created files: "Read the contents of /tmp/test-output.txt" | Agent reads the file successfully via bash `cat`, content matches what was written in step 1.2 |

## Phase 3: Size Limit Enforcement

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Send a message: "Create a file at /tmp/small-test.txt containing 100 lines of 'test data repeated'" | File is created and appears in Files tab (well under 1MB limit) |
| 3.2 | Send a message: "Generate a 2MB file at /tmp/large-test.txt by repeating a pattern" | Agent creates the file in the sandbox, but after persist the file does NOT appear in the Files tab; the agent may note the file was skipped due to size limits |
| 3.3 | Verify the turn's `files_changed` count is 0 for the oversized file turn | Query `SELECT files_changed FROM turns ORDER BY created_at DESC LIMIT 1` — shows 0 for the oversized file attempt |

## Phase 4: Overlay Mount Isolation

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Configure an overlay mount in `overlay.json` (e.g., mount the project's own `docs/` directory at `/mnt/docs`) and restart | Application starts with overlay configured |
| 4.2 | Send a message: "List what files exist under /mnt/docs/" | Agent can read files via bash (the overlay is functional for execution) |
| 4.3 | Check the Files tab in the web UI | No files with `/mnt/` prefix appear in the file tree — overlay files are excluded from persistence and enumeration |

## End-to-End: Full Agent Loop Lifecycle

**Purpose:** Validate that the complete snapshot-write-persist-hydrate cycle works end-to-end through the actual agent loop, not just through isolated function calls.

1. Start the application fresh with an empty data directory.
2. Send a multi-tool message: "Create three files: /tmp/config.json with `{"key":"value"}`, /workspace/app/index.ts with `console.log('hello')`, and /home/user/readme.md with `# My Project`".
3. Verify agent executes multiple bash commands (three writes).
4. After loop completes, open Files tab. Confirm all three files appear under their respective root nodes (`tmp`, `workspace`, `home`).
5. Stop and restart the application.
6. Open Files tab. Confirm all three files survived the restart with correct content.
7. Send a message: "Update /tmp/config.json to add a new key: `{"key":"value","new_key":"added"}`".
8. After loop completes, verify the file content in the Files tab reflects the update (modified, not duplicated).
9. Send a message that produces no file changes: "What is 2 + 2?"
10. Verify the turn's `files_changed` count is 0 (no spurious persistence).

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC3.1-AC3.3 (Files tab rendering) | Automated tests verify database state but not the visual rendering of the Svelte file tree component | Open the web UI at `http://localhost:3000`, navigate to the Files tab, verify that `/tmp`, `/workspace`, and `/home` appear as expandable root nodes in the tree with their respective files nested underneath |
| Overlay mount real-world behavior | Unit tests use synthetic mounts; real overlay mounts involve actual filesystem permissions and path resolution | Configure a real overlay mount in `overlay.json`, restart, verify that overlay files are accessible to the agent via bash but do NOT appear in the Files tab |
| Restart persistence (process-level) | Integration tests simulate restart by creating a new `ClusterFsResult` with the same DB, but do not test actual process termination and re-initialization | Stop the running application process, restart it, and confirm the Files tab shows all previously persisted files |
| Size limit user experience | Tests verify the technical skip/reject behavior, but not how the agent communicates the limitation to the user | Create an oversized file and observe whether the agent produces a useful message or the UI indicates the file was not persisted |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 `/tmp` in getInMemoryPaths | cluster-fs.test.ts "AC1.1" | Phase 1, Step 1.2-1.3 |
| AC1.2 arbitrary path in getInMemoryPaths | cluster-fs.test.ts "AC1.2" | Phase 1, Step 1.4 |
| AC1.3 `/home/user/` regression | cluster-fs.test.ts "AC1.3" | Phase 1, Step 1.5 |
| AC1.4 `/mnt/` excluded | cluster-fs.test.ts "AC1.4 + AC1.5" | Phase 4, Step 4.3 |
| AC1.5 OverlayFs isolation | cluster-fs.test.ts "AC1.4 + AC1.5" | Phase 4, Step 4.3 |
| AC2.1 `/tmp` hydration | cluster-fs.test.ts "AC2.1" | Phase 2, Step 2.3-2.4 |
| AC2.2 `/workspace` hydration | cluster-fs.test.ts "AC2.2" | Phase 2, Step 2.3 |
| AC2.3 `/home/user/` hydration | cluster-fs.test.ts "AC2.3" | Phase 2, Step 2.3 |
| AC2.4 `/mnt/` not hydrated | cluster-fs.test.ts "AC2.4" | Phase 4, Step 4.3 |
| AC2.5 soft-deleted not hydrated | cluster-fs.test.ts "AC2.5" | — (internal DB state only) |
| AC3.1 `/tmp` in GET /api/files | loop-sandbox.test.ts "AC3.1" | Phase 1, Step 1.3 |
| AC3.2 `/tmp` root node | loop-sandbox.test.ts "AC3.2" | Phase 1, Step 1.3 |
| AC3.3 `/workspace` root node | loop-sandbox.test.ts "AC3.3" | Phase 1, Step 1.4 |
| AC3.4 survive restart | loop-sandbox.test.ts "AC3.4" | Phase 2, Steps 2.1-2.3 |
| AC4.1 under 1MB persists | loop-sandbox.test.ts "AC4.1" | Phase 3, Step 3.1 |
| AC4.2 over 1MB skipped | loop-sandbox.test.ts "AC4.2" | Phase 3, Step 3.2 |
| AC4.3 50MB total limit | fs-persist.test.ts "rejects when total size exceeds aggregate limit" | — (stress test, not practical manually) |
| AC5.1 capturePreSnapshot once | agent-loop.test.ts "AC5.1" | — (internal hook, not observable externally) |
| AC5.2 persistFs called | agent-loop.test.ts "should call persistFs when sandbox supports it" | E2E, Step 8 (update reflects persistence) |
| AC5.3 files in DB after loop | loop-sandbox.test.ts "AC5.3" | Phase 1, Steps 1.2-1.5 |
| AC5.4 no-change returns 0 | loop-sandbox.test.ts "AC5.4" | E2E, Steps 9-10 |
| AC5.5 loop without hooks | agent-loop.test.ts "AC5.5" | — (backward compat, no external manifestation) |
