# VFS Full Persistence Design

## Summary

This document describes changes to make the agent's virtual filesystem fully persistent. Currently, only files under `/home/user/` are saved to the database and restored on startup; files written by agents to other paths — such as `/tmp/` or arbitrary directories like `/workspace/` — are lost when the process restarts. The change extends snapshot and hydration to cover every in-memory filesystem path except overlay-managed mounts (`/mnt/`) and known system pseudo-paths, so that the full working state of an agent's filesystem survives restarts and is visible in the web UI's Files tab.

The implementation follows the existing snapshot/persist pipeline without modifying its core logic. A new `getInMemoryPaths()` method on `ClusterFsResult` enumerates only the in-memory filesystem instances the sandbox owns (by direct reference), bypassing overlay mounts entirely. `snapshotWorkspace` gains an optional `paths` parameter so it can operate over that explicit list instead of enumerating the full mounted filesystem. `hydrateWorkspace`'s SQL predicate is broadened to restore all non-overlay rows from the `files` table. A new `capturePreSnapshot` hook is threaded through the agent loop to record the pre-execution state, enabling the existing diff-and-persist logic to detect what changed. All three changes are wired together in the CLI's per-loop sandbox wrapper.

## Definition of Done

`snapshotWorkspace` captures all agent-written paths in the virtual filesystem except known just-bash system paths (`/dev/`, `/proc/`, `/bin/`, `/usr/`) and overlay-managed paths (`/mnt/`). `hydrateWorkspace` restores all those paths from the `files` table on startup. The web UI Files tab consequently shows `/tmp` and any agent-created directory at an arbitrary path (e.g. `/workspace/`). Existing 1 MB/file and 50 MB/workspace size limits apply unchanged. No cleanup/TTL policy is in scope.

## Acceptance Criteria

### vfs-full-persist.AC1: snapshotWorkspace captures all in-memory paths
- **vfs-full-persist.AC1.1 Success:** File written to `/tmp/foo.txt` is included in snapshot via `getInMemoryPaths()`
- **vfs-full-persist.AC1.2 Success:** File at an arbitrary agent-created path (e.g. `/workspace/project/main.py`) is included
- **vfs-full-persist.AC1.3 Success:** Existing `/home/user/` files continue to be included (no regression)
- **vfs-full-persist.AC1.4 Failure:** Paths under `/mnt/` are absent from snapshot output
- **vfs-full-persist.AC1.5 Failure:** OverlayFs real host files are never enumerated (`getInMemoryPaths` never touches OverlayFs)

### vfs-full-persist.AC2: hydrateWorkspace restores all persisted in-memory paths on startup
- **vfs-full-persist.AC2.1 Success:** Row at `/tmp/scratch.txt` in `files` table is written to in-memory FS on hydrate
- **vfs-full-persist.AC2.2 Success:** Row at `/workspace/foo.ts` in `files` table is written to in-memory FS on hydrate
- **vfs-full-persist.AC2.3 Success:** Existing `/home/user/` rows continue to be hydrated (no regression)
- **vfs-full-persist.AC2.4 Failure:** Rows with `path LIKE '/mnt/%'` are not hydrated
- **vfs-full-persist.AC2.5 Edge:** Soft-deleted rows (`deleted = 1`) are not hydrated

### vfs-full-persist.AC3: Files tab shows /tmp and agent-created paths
- **vfs-full-persist.AC3.1 Success:** After agent writes `/tmp/output.txt` and loop completes, file appears in `GET /api/files`
- **vfs-full-persist.AC3.2 Success:** `/tmp` files appear as a `/tmp` root node in the file tree
- **vfs-full-persist.AC3.3 Success:** Files under agent-created root dirs (e.g. `/workspace/`) appear in file tree
- **vfs-full-persist.AC3.4 Edge:** `/tmp` files survive application restart and appear in Files tab after rehydration

### vfs-full-persist.AC4: Existing size limits unchanged
- **vfs-full-persist.AC4.1 Success:** File under 1 MB written to `/tmp` is persisted normally
- **vfs-full-persist.AC4.2 Failure:** File over 1 MB in `/tmp` triggers existing per-file size limit error
- **vfs-full-persist.AC4.3 Failure:** Total workspace over 50 MB triggers existing total size limit error

### vfs-full-persist.AC5: persistFs pipeline is wired and functional
- **vfs-full-persist.AC5.1 Success:** `capturePreSnapshot` is called once per `AgentLoop.run()` at `HYDRATE_FS`
- **vfs-full-persist.AC5.2 Success:** `persistFs` is called once per `AgentLoop.run()` at `FS_PERSIST`
- **vfs-full-persist.AC5.3 Success:** Files written by agent bash commands are present in `files` table after loop completes
- **vfs-full-persist.AC5.4 Edge:** Loop with no filesystem changes returns `changes: 0` from `persistFs`
- **vfs-full-persist.AC5.5 Edge:** Loop running without `capturePreSnapshot`/`persistFs` configured completes without error

## Glossary

- **VFS (Virtual Filesystem):** The in-memory filesystem abstraction used by the agent sandbox. Files exist only in process memory unless explicitly persisted to the database.
- **InMemoryFs:** A concrete filesystem implementation that stores all file contents in RAM. One of several filesystem types composable inside the sandbox.
- **OverlayFs:** A filesystem that layers an in-memory write layer over a real host directory. Used for overlay-cached paths under `/mnt/`. Its contents are never snapshotted by this pipeline.
- **MountableFs:** The composable filesystem type that accepts multiple mounts at different path prefixes. `ClusterFsResult` wraps one of these.
- **ClusterFsResult:** The object returned by `createClusterFs`. Holds references to the constructed filesystem tree plus optional computed methods (staleness checking, and after this change, `getInMemoryPaths()`).
- **snapshotWorkspace:** A sandbox function that reads the current state of the in-memory filesystem and returns a map of path → content hash, used as input to the persist pipeline.
- **hydrateWorkspace:** A sandbox function that reads the `files` table from SQLite on startup and writes all matching rows back into the in-memory filesystem.
- **persistFs / persistWorkspaceChanges:** The pipeline step that diffs a pre-snapshot against a post-snapshot and upserts changed files into the `files` table, using OCC to detect conflicts.
- **OCC (Optimistic Concurrency Control):** A conflict-detection strategy where a snapshot is taken before a write, and the write is rejected if the stored state has changed since the snapshot was taken.
- **capturePreSnapshot:** A new optional method on the `BashLike` interface, called at the `HYDRATE_FS` stage of the agent loop to record the filesystem state before any tool execution.
- **BashLike:** The interface the agent loop uses to interact with the sandbox. All methods are optional, allowing different configurations to omit capabilities they don't support.
- **loopSandbox:** A per-invocation wrapper object created inside `agentLoopFactory` that implements `BashLike` with `capturePreSnapshot` and `persistFs` closures bound to an isolated `preSnapshot` variable.
- **soft delete:** The project-wide convention of setting `deleted = 1` on a row rather than removing it. Soft-deleted file rows are excluded from hydration.
- **`files` table:** The SQLite table that persists virtual filesystem contents. A synced table subject to the change-log outbox pattern.
- **overlay-cached paths:** Files under `/mnt/` that represent content fetched from real host directories via `OverlayFs`. These already have their own hydration path (`hydrateRemoteCache`) and must not be re-written by `hydrateWorkspace`.
- **change-log outbox pattern:** The project convention that all writes to synced tables (including `files`) go through `insertRow`/`updateRow`/`softDelete` from `@bound/core`, which wraps the write and a changelog entry in a single transaction.

## Architecture

The change touches three packages in dependency order: `sandbox` → `agent` → `cli`.

**`ClusterFsResult.getInMemoryPaths()`** (`packages/sandbox/src/cluster-fs.ts`)

`createClusterFs` already holds direct references to the InMemoryFs instances it creates — `baseFs` (the root) and `homeUserFs` (mounted at `/home/user`). A new `getInMemoryPaths()` method is added to `ClusterFsResult` that queries only those two instances, concatenating their `getAllPaths()` output with the appropriate mount-point prefix. OverlayFs instances are never referenced. This is a positive allowlist by direct reference, not a type-check or denylist — if a filesystem isn't explicitly tracked in this list, it is not snapshotted.

**`snapshotWorkspace` signature extension** (`packages/sandbox/src/cluster-fs.ts`)

The function gains an optional `options?: { paths?: string[] }` parameter. When `paths` is supplied the function iterates that list rather than calling `fs.getAllPaths()` and filtering by `/home/user/`. Existing callers with no options argument are unaffected (backward-compatible). The per-path `try/catch` on `readFile` already handles directories gracefully.

**`hydrateWorkspace` SQL** (`packages/sandbox/src/cluster-fs.ts`)

The `WHERE path LIKE '/home/user/%'` predicate becomes `WHERE deleted = 0 AND path NOT LIKE '/mnt/%'`. System paths (`/dev/`, `/proc/`, `/bin/`, `/usr/`) are never written to the `files` table because `getInMemoryPaths()` never emits them, so no SQL exclusion is needed for those. Overlay-cached paths (`/mnt/`) are the only rows that exist in the `files` table but must not be re-hydrated into the in-memory FS (they are already handled by `hydrateRemoteCache`).

**`BashLike.capturePreSnapshot` + `AgentLoop.run()` hook** (`packages/agent/src/agent-loop.ts`)

A new optional `capturePreSnapshot?: () => Promise<void>` is added to the `BashLike` interface alongside the existing `persistFs?`. `AgentLoop.run()` calls `this.sandbox.capturePreSnapshot?.()` at the `HYDRATE_FS` stage — before any tool execution begins — to record the filesystem state that `persistFs` will diff against at `FS_PERSIST`.

**`loopSandbox` wrapper + `createClusterFs` update** (`packages/cli/src/commands/start.ts`)

`createClusterFs` is called with `db` and `siteId` so it returns `ClusterFsResult` (needed for `getInMemoryPaths()`). Inside `agentLoopFactory`, a per-invocation `loopSandbox` object is created with a `let preSnapshot` closure variable. `capturePreSnapshot` calls `snapshotWorkspace(clusterFs, { paths: clusterFsObj.getInMemoryPaths() })` and stores the result. `persistFs` calls `snapshotWorkspace` again for the post-snapshot, diffs via `persistWorkspaceChanges`, resets `preSnapshot` to `null`, and returns `{ changes }`. Because `loopSandbox` is created fresh per `agentLoopFactory` call, concurrent loops have isolated snapshot state. `loopSandbox` is passed to `AgentLoop` in place of the bare `sandbox.bash`.

## Existing Patterns

`ClusterFsResult` already has optional computed fields (`checkStaleness`). Adding `getInMemoryPaths()` follows the same shape.

`BashLike` is already an optional-method interface (`exec?`, `persistFs?`, `checkMemoryThreshold?`). Adding `capturePreSnapshot?` is consistent with this pattern.

`persistWorkspaceChanges` (`packages/sandbox/src/fs-persist.ts`) already accepts a `preSnapshot`/`postSnapshot` pair and handles OCC conflict detection, upserts, soft-deletes, and post-commit event emission. No changes to that function are required.

The `agentLoopFactory` closure pattern in `start.ts` is already used to close over `modelRouter`, `appContext`, and sandbox state. Closing over `preSnapshot` per invocation follows the same idiom.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Sandbox — `getInMemoryPaths`, `snapshotWorkspace` options, `hydrateWorkspace` SQL

**Goal:** Extend the sandbox package so that snapshot and hydration can operate over the full in-memory filesystem scope.

**Components:**
- `packages/sandbox/src/cluster-fs.ts` — add `getInMemoryPaths(): string[]` to `ClusterFsResult`; extend `snapshotWorkspace` with `options?: { paths?: string[] }`; update `hydrateWorkspace` SQL predicate
- `packages/sandbox/src/index.ts` — re-export `getInMemoryPaths` type if needed

**Dependencies:** None (first phase)

**Done when:** `bun test packages/sandbox` passes; `snapshotWorkspace` with explicit `paths` snapshots only those paths; `getInMemoryPaths()` on a `ClusterFsResult` that has an overlay mount returns no overlay paths; `hydrateWorkspace` restores rows at `/tmp/foo` and `/workspace/bar` and does not restore `/mnt/` rows; existing tests unaffected
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Agent — `capturePreSnapshot` hook

**Goal:** Give `AgentLoop` the ability to record a pre-execution filesystem snapshot without coupling to sandbox implementation details.

**Components:**
- `packages/agent/src/agent-loop.ts` — add `capturePreSnapshot?: () => Promise<void>` to `BashLike`; call `this.sandbox.capturePreSnapshot?.()` at the `HYDRATE_FS` stage of `run()`

**Dependencies:** Phase 1

**Done when:** `bun test packages/agent` passes; an `AgentLoop` constructed with a mock sandbox that implements `capturePreSnapshot` calls it exactly once per `run()` invocation; loops without `capturePreSnapshot` continue to run without error
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: CLI — `loopSandbox` wiring

**Goal:** Wire the full snapshot → persist pipeline in production by connecting `ClusterFsResult`, `snapshotWorkspace`, and `persistWorkspaceChanges` through a per-loop sandbox wrapper.

**Components:**
- `packages/cli/src/commands/start.ts` — pass `db` and `siteId` to `createClusterFs`; create `loopSandbox` wrapper per `agentLoopFactory` invocation with `capturePreSnapshot` and `persistFs` closures; pass `loopSandbox` to `AgentLoop`

**Dependencies:** Phase 1, Phase 2

**Done when:** `bun test packages/cli` passes; after an agent loop that writes a file to `/tmp/scratch.txt`, a subsequent `SELECT * FROM files WHERE path = '/tmp/scratch.txt'` returns a row; after restart (fresh `hydrateWorkspace`), that file is present in the in-memory FS; the Files tab in the web UI shows the file
<!-- END_PHASE_3 -->

## Additional Considerations

**Overlay mount performance:** Before this change `snapshotWorkspace` called `fs.getAllPaths()` which would enumerate all real host files if overlay mounts were configured (then discard them via the `/home/user/` filter). The new design never calls `getAllPaths()` on the `MountableFs` directly — only on the tracked InMemoryFs instances — so large overlay mounts have no snapshot overhead.

**`preSnapshot` reset on persist:** `persistFs` resets `preSnapshot` to `null` after writing. If the agent loop runs again before the next `capturePreSnapshot` call (which should not happen in normal flow), `persistFs` returns `{ changes: 0 }` safely.

**`syncEnabled: false` in CLI:** Passing `db` and `siteId` to `createClusterFs` does not enable overlay auto-caching. `syncEnabled` controls only that behaviour; providing `db`/`siteId` exclusively enables staleness checking and the new `getInMemoryPaths()` method.
