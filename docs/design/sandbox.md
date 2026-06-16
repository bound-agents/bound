# Sandbox

This document covers two distinct sandboxing layers in Bound: the `@bound/sandbox` package — the agent's server-side virtual filesystem, OCC persistence, and command framework — and the OS-level filesystem sandbox that `boundless` (the terminal coding-agent client) uses to confine shell commands on the operator's real machine.

The two solve different problems. `@bound/sandbox` is an in-memory VFS whose contents never reach durable storage until they are persisted to the `files` table, so a stray write can never escape onto a real disk. boundless's sandbox, by contrast, guards a *real* working directory on the operator's host against writes outside it. The first half of this document covers `@bound/sandbox`; the [Sandboxing in boundless](#sandboxing-in-boundless) section at the end covers the latter.

---

## @bound/sandbox

The sandbox package provides a controlled Bash execution environment built on top of the `just-bash` library. It manages a virtual filesystem, persists workspace changes to a SQLite database, defines custom commands that agents can invoke, and maintains an indexed view of overlay-mounted host directories.

### ClusterFs

**Source:** `packages/sandbox/src/cluster-fs.ts`

`createClusterFs` constructs a `MountableFs` instance that routes filesystem paths to different underlying storage backends.

The layout is fixed:

| Mount path | Backend | Notes |
|---|---|---|
| `/` (base) | `InMemoryFs` | Catch-all for everything not otherwise mounted |
| `/home/user` | `InMemoryFs` | The agent's primary working directory |
| `/mnt/<name>` (optional) | `OverlayFs` | Read-write overlay onto a real host directory |

```typescript
import { createClusterFs } from "@bound/sandbox";

const fs = createClusterFs({
  hostName: "worker-1",
  syncEnabled: true,
  overlayMounts: {
    // realPath on the host -> virtual mount point inside the sandbox
    "/projects/myapp": "/mnt/myapp",
  },
});
```

`overlayMounts` is a `Record<string, string>` mapping real host paths to their virtual mount points. Each entry becomes a read-write `OverlayFs`. Omitting the field means no overlay mounts are created.

#### Snapshotting and diffing

The OCC (Optimistic Concurrency Control) persistence model relies on before/after snapshots of the in-memory workspace. Two functions handle this:

- **`snapshotWorkspace(fs, options?)`** — Returns a `Map<string, string>` of `path -> SHA-256 hash`. When `options.paths` is provided, only those specific paths are snapshotted — used by the agent loop to scope pre-execution snapshots to in-memory (agent-written) files only, avoiding unnecessary hashing of overlay content. Without `paths`, falls back to scanning all `/home/user/` paths via `fs.getAllPaths()`. Directories and unreadable entries are skipped.

  ```typescript
  snapshotWorkspace(fs: IFileSystem, options?: { paths?: string[] }): Promise<Map<string, string>>
  ```

- **`diffWorkspace(before, after)`** — Synchronously compares two snapshots and returns a `FileChange[]` listing which paths were `"created"`, `"modified"`, or `"deleted"`. No filesystem access is needed; it operates purely on the hash maps.
- **`diffWorkspaceAsync(before, after, fs?)`** — Same diff logic, but if an `IFileSystem` is provided it also reads each changed file and populates the `content` and `sizeBytes` fields on each `FileChange`. This is the variant used by the persistence layer.

```typescript
interface FileChange {
  path: string;
  operation: "created" | "modified" | "deleted";
  content?: string;    // populated by diffWorkspaceAsync when fs is supplied
  sizeBytes?: number;
}
```

#### Hydration

Two helpers restore previously persisted files into a fresh filesystem at startup:

- **`hydrateWorkspace(fs, db)`** — Loads all non-deleted rows from the `files` table whose `path` does NOT start with `/mnt/` and writes them into `fs`. This covers all agent-written paths (including any outside `/home/user/`), allowing the VFS to persist arbitrary paths across restarts.

  ```typescript
  hydrateWorkspace(fs: MountableFs, db: Database): Promise<void>
  ```

- **`hydrateRemoteCache(fs, db, hostName)`** — Loads rows whose path matches `/mnt/<hostName>/%`. Used to warm the in-memory cache for a remote worker's file tree.

#### Per-loop snapshot isolation

The bootstrap sequence creates a `loopSandbox` wrapper per `AgentLoop` invocation via `agentLoopFactory`. Each invocation receives its own closure over the `ClusterFsResult`, providing two lifecycle hooks:

- **`capturePreSnapshot()`** — Called at the HYDRATE_FS agent loop state. Calls `snapshotWorkspace` scoped to the set of in-memory paths returned by `ClusterFsResult.getInMemoryPaths()`, capturing a before-image of the VFS for that specific loop run.
- **`persistFs()`** — Called at the FS_PERSIST agent loop state. Takes a post-execution snapshot of the same paths, diffs it against the pre-snapshot captured above, and calls `persistWorkspaceChanges` to flush any changes to the `files` table.

Because each loop invocation gets its own snapshot state via a closure, concurrent agent loops running against the same `ClusterFs` do not interfere with each other's pre/post snapshots.

---

### Filesystem Persistence (OCC)

**Source:** `packages/sandbox/src/fs-persist.ts`

`persistWorkspaceChanges` is the single entry point for flushing an agent's in-memory workspace changes to the database. It implements an optimistic concurrency control protocol to detect conflicting concurrent writes, enforces per-file and total-workspace size limits, and emits `file:changed` events after a successful commit.

#### Function signature

```typescript
async function persistWorkspaceChanges(
  db: Database,
  siteId: string,
  preSnapshot: Map<string, string>,
  postSnapshot: Map<string, string>,
  eventBus: TypedEventEmitter,
  options?: PersistOptions,
  fs?: IFileSystem,
): Promise<Result<PersistResult, PersistError>>
```

#### Lifecycle

1. **Diff** — `diffWorkspaceAsync` is called with the pre- and post-snapshots, plus the live `IFileSystem` so file contents are available for insert/update.
2. **Size checks** — Each changed file is checked against `maxFileSizeBytes` (default 1 MB). If any file exceeds the limit, the function returns an `err` without touching the database. If no individual file is too large, the total size of all changes is checked against `maxTotalSizeBytes` (default 50 MB).
3. **OCC conflict detection** — Inside a `BEGIN IMMEDIATE` transaction, each changed path is read from the database. If the current database content hashes differently from the pre-snapshot hash for that path, a conflict is recorded. The resolution strategy is last-write-wins (LWW): if the database row's `modified_at` timestamp is newer than the current time, the incoming write is skipped; otherwise it proceeds.
4. **Apply** — Created and modified files call `insertRow` or `updateRow` from `@bound/core`. Deleted files call `softDelete`, which sets `deleted = 1` rather than removing the row.
5. **Commit and emit** — After a successful `COMMIT`, `file:changed` events are emitted for each affected path on the provided `eventBus`.

#### Return types

```typescript
interface PersistResult {
  changes: number;       // number of rows written
  conflicts: number;     // number of OCC conflicts detected
  conflictPaths: string[];
}

interface PersistError extends Error {
  failedPaths: string[]; // paths that triggered a size limit violation
}
```

#### Size limit options

```typescript
interface PersistOptions {
  maxFileSizeBytes?: number;  // default: 1_048_576  (1 MB)
  maxTotalSizeBytes?: number; // default: 52_428_800 (50 MB)
}
```

---

### Command Framework

> **Note:** The `CommandDefinition` framework is now used only for MCP bridge commands. Agent tools use the `RegisteredTool` pattern (see `docs/design/agent-system.md`). The following documentation applies to MCP bridge command dispatch only.

**Source:** `packages/sandbox/src/commands.ts`

Custom commands give agents access to system capabilities (database queries, event publishing, etc.) that are not available through standard shell utilities. The framework wraps the `just-bash` `defineCommand` primitive with typed argument parsing and a shared context object.

#### Types

```typescript
interface CommandDefinition {
  name: string;
  args: Array<{ name: string; required: boolean; description?: string }>;
  handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}

interface CommandContext {
  db: Database;
  siteId: string;
  eventBus: TypedEventEmitter;
  logger: Logger;
  threadId?: string;
  taskId?: string;
  mcpClients?: Map<string, unknown>;
  modelRouter?: unknown; // ModelRouter from @bound/llm
  fs?: IFileSystem;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

`CommandContext` is injected at registration time and shared across all commands in the set. It provides access to the database, the CRDT site identifier, the event bus, and optional thread/task scoping.

#### createDefineCommands

> **Note:** `createDefineCommands()` now only processes MCP bridge commands. Native agent tools bypass this entirely and dispatch through the unified tool registry.

`createDefineCommands(definitions, context)` takes an array of `CommandDefinition` objects and a single `CommandContext` and returns a list of `just-bash` `CustomCommand` objects ready to be passed to `createSandbox`.

Argument parsing supports three input styles, chosen per-invocation based on the shape of `argv`:

1. **Flag / key-value** — if any token starts with `--` or matches `<identifier>=`, the parser handles `--key value` pairs, `key=value` pairs, and leading positional tokens in a single pass. Unrecognised positional tokens fill the declared arg slots in declaration order.
2. **Positional** — with no flag/key-value tokens and at least one declared arg, `argv[0]` maps to the first declared arg, `argv[1]` to the second, and so on.
3. **JSON fallback** — with no flags and no declared args, the parser tries `JSON.parse(argv.join(" "))`; if it yields an object, its entries become string-coerced args, otherwise each token is assigned to `arg0`, `arg1`, etc.

If a required argument is absent (positional mode only), the handler returns `exitCode: 1` immediately with an appropriate message on `stderr`. Handler exceptions are caught and surfaced as `exitCode: 1` with the error message on `stderr`.

Per-invocation `threadId` and `taskId` are propagated through `loopContextStorage` (an `AsyncLocalStorage`) and merged into the `CommandContext` passed to the handler, so concurrent agent loops see their own scoping without sharing mutable context.

#### Example — registering a custom command

```typescript
import { createDefineCommands } from "@bound/sandbox";
import type { CommandDefinition, CommandContext } from "@bound/sandbox";

const definitions: CommandDefinition[] = [
  {
    name: "db-query",
    args: [
      { name: "sql", required: true, description: "SQL statement to run" },
    ],
    handler: async (args, ctx) => {
      try {
        const rows = ctx.db.query(args.sql).all();
        return {
          stdout: JSON.stringify(rows, null, 2),
          stderr: "",
          exitCode: 0,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
        };
      }
    },
  },
];

const context: CommandContext = {
  db,
  siteId: "site-abc",
  eventBus,
  logger,
};

const commands = createDefineCommands(definitions, context);
```

---

### Sandbox Factory

**Source:** `packages/sandbox/src/sandbox-factory.ts`

`createSandbox` assembles a `Sandbox` wrapping a `just-bash` `Bash` instance from a `ClusterFs`, a set of custom commands, and optional network, execution limit, memory threshold, and URL allowlist configuration. The returned `Sandbox` exposes `bash`, a `checkMemoryThreshold()` helper, the underlying `MemoryTracker`, and a `UrlFilter`.

```typescript
interface SandboxConfig {
  clusterFs: MountableFs;
  commands: CustomCommand[];
  networkConfig?: NetworkConfig;
  executionLimits?: ExecutionLimits;
  memoryThresholdBytes?: number;
  allowedUrlPrefixes?: string[];
}

interface ExecutionLimits {
  maxCallDepth?: number;
  maxCommandCount?: number;
  maxLoopIterations?: number;
}

interface Sandbox {
  bash: Bash;
  checkMemoryThreshold: () => MemoryThresholdResult;
  memoryTracker: MemoryTracker;
  urlFilter: UrlFilter;
}
```

When `executionLimits` is omitted, the following defaults are applied:

| Limit | Default |
|---|---|
| `maxCallDepth` | 50 |
| `maxCommandCount` | 10 000 |
| `maxLoopIterations` | 10 000 |

When `executionLimits` is provided, any omitted fields fall back to those same defaults.

`networkConfig` is passed through directly to `just-bash` and controls whether the sandbox can make outbound network requests.

#### End-to-end sandbox creation example

```typescript
import { createClusterFs, createDefineCommands, createSandbox } from "@bound/sandbox";

// 1. Build the filesystem
const clusterFs = createClusterFs({
  hostName: "worker-1",
  syncEnabled: true,
  overlayMounts: {
    "/projects/myapp": "/mnt/myapp",
  },
});

// 2. Hydrate from the database so prior state is available
await hydrateWorkspace(clusterFs, db);

// 3. Take a pre-snapshot before the agent runs (scope to in-memory paths only)
const preSnapshot = await snapshotWorkspace(clusterFs, { paths: clusterFs.getInMemoryPaths() });

// 4. Register commands
const commands = createDefineCommands(definitions, context);

// 5. Create the sandbox
const sandbox = await createSandbox({
  clusterFs,
  commands,
  executionLimits: {
    maxCommandCount: 5000,
  },
});

// 6. Run the agent's shell script inside the sandbox
await sandbox.bash.exec('echo "hello from the sandbox"');

// 7. Persist any changes the agent made
const postSnapshot = await snapshotWorkspace(clusterFs, { paths: clusterFs.getInMemoryPaths() });
const result = await persistWorkspaceChanges(
  db, siteId, preSnapshot, postSnapshot, eventBus, {}, clusterFs
);
```

---

### Overlay Index Scanner

**Source:** `packages/sandbox/src/overlay-scanner.ts`

The overlay scanner maintains an `overlay_index` table in the database that mirrors the content of host directories mounted via `OverlayFs`. It detects new files, changed files, and files that have been removed since the last scan.

#### scanOverlayIndex

```typescript
function scanOverlayIndex(
  db: Database,
  siteId: string,
  overlayMounts: Record<string, string>,
): ScanResult
```

For each mount path in `overlayMounts`, `scanOverlayIndex` recursively walks the directory tree on the host filesystem. For every file found:

- A deterministic UUID v5 is derived from the file's path using the fixed Bound namespace UUID (`550e8400-e29b-41d4-a716-446655440000`), so IDs are stable across restarts.
- A SHA-256 hash of the file content is computed.
- If no existing non-deleted row exists for that ID, a new row is inserted.
- If a row exists but the stored content hash differs, the row is updated with the new hash and size.

After the directory walk, any rows in `overlay_index` for this `siteId` that were not encountered during the scan are soft-deleted (`deleted = 1`). This handles files that were removed from the host since the last scan.

```typescript
interface ScanResult {
  created: number;
  updated: number;
  tombstoned: number;
}
```

#### startOverlayScanLoop

```typescript
function startOverlayScanLoop(
  db: Database,
  siteId: string,
  overlayMounts: Record<string, string>,
  intervalMs?: number,   // default: 300_000 (5 minutes)
): { stop: () => void }
```

Starts a `setInterval` loop that calls `scanOverlayIndex` on the given interval. Returns a handle with a `stop()` method to cancel the loop.

```typescript
const scanner = startOverlayScanLoop(db, siteId, { "/projects/myapp": "/mnt/myapp" });

// Later, when shutting down:
scanner.stop();
```

---

## Sandboxing in boundless

`boundless` (the terminal coding-agent client, package `@bound/less`) faces a different containment problem from `@bound/sandbox` above. The `@bound/sandbox` VFS is in-memory and server-side: the agent loop reads and writes a `MountableFs` that only reaches durable storage when `persistWorkspaceChanges` flushes it to the `files` table. boundless's tools, by contrast, act on the operator's *real* working directory — `boundless_read` / `boundless_write` / `boundless_edit` touch real files and `boundless_bash` runs real shell commands. That surface needs OS-level containment, and boundless gets it from Microsoft's [mxc](https://github.com/microsoft/mxc) (`@microsoft/mxc-sdk`).

**Source:** `packages/less/src/tools/sandbox-policy.ts` (SDK-free policy and config core), `packages/less/src/tools/sandbox.ts` (SDK-dependent spawn path).

### The policy shape

One rule, three knobs: read anything, write almost nothing, talk to the network freely. `buildPolicy` produces an mxc `SandboxPolicy` with:

- **`readonlyPaths: ["/"]`** — the whole filesystem is readable. Compilers and tools need system headers, libraries, and configs.
- **`readwritePaths: [cwd, tmpdir, ...extras]`** — writes are confined to the working directory, the system temp dir, and any operator-listed extra paths. A command can edit the project it is working in but cannot clobber `~/.ssh`, `/etc`, or a sibling checkout.
- **Network open** — outbound requests are unrestricted (package installs, API calls).

mxc compiles this abstract `process` containment to a per-OS backend: seatbelt on macOS, bubblewrap on Linux, and a native backend on Windows. `POLICY_VERSION` (`"0.6.0-alpha"`) is validated against the SDK's supported window but does **not** select the backend — the native `wxc-exec` probe picks the platform backend itself, so pinning the schema version cannot change which backend runs.

### The `.git` carve-out

One subpath runs the other way. Inside the writable cwd, `.git/hooks` and `.git/config` are pinned **read-only**. They hold scripts and config directives (`core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, aliases) that Git later executes as the operator, *outside* the sandbox — so without the carve-out a sandboxed run could plant a hook that fires on the operator's next `git` command and escape containment entirely. Git's own operations only ever read these paths, so the carve-out never breaks normal work. `computeGitProtectedPaths` computes the protected set.

It is enforced on Linux (bubblewrap layers the read-only bind after the cwd read-write bind; last-mount-wins) and for boundless's in-process file tools on every platform **except Windows**. No mxc Windows backend can yet express "readable but not writable" for a subpath of a writable parent, so `computeGitProtectedPaths` returns `[]` on win32 and `.git` stays writable there. The gap is tracked upstream.

### Degradation

When mxc cannot sandbox on a platform, behavior follows the `onUnavailable` setting: `"passthrough"` (default) runs the command unsandboxed with a warning rather than break the shell; `"error"` refuses to run it. The sandbox is configured in `~/.bound/less/config.json` under the `sandbox` key — `false` to disable, or an object (`enabled`, `writablePaths`, `network`, `onUnavailable`) for finer control.

### The Windows backend

mxc exposes two backends that can satisfy the `process` intent on Windows, and which one boundless uses comes down to capability. The first, **BaseContainer** (`processcontainer`), is a one-shot spawn — the same shape macOS (seatbelt) and Linux (bubblewrap) use — but on current Windows builds its kernel entry point is missing. Even with both BaseContainer feature-velocity flags enabled, the `Containers` optional features installed, and a supported build and edition (observed on 25H2 build 26300, Pro), the underlying kernel call `Experimental_CreateProcessInSandbox` returns `E_NOTIMPL` / `ERROR_CALL_NOT_IMPLEMENTED` — the OS reporting that the syscall is not implemented in this build. No user-mode configuration conjures a call the kernel does not ship. (The operator-facing detail — how to check the flags and enable the ones merely gated behind the staged rollout, on builds where the feature has shipped — lives in the README's boundless section.)

So on Windows boundless uses the second backend, **IsolationSession**, which succeeds where BaseContainer returns `E_NOTIMPL`: it provisions a short-lived Windows agent user, runs commands as that user, and enforces the write-confinement policy (a write inside `readwritePaths` succeeds; a write outside is denied by the OS). IsolationSession differs from the one-shot backends in shape — it is a stateful, five-phase lifecycle (provision -> start -> exec -> stop -> deprovision) rather than a spawn-and-forget call — so boundless drives it per session rather than per command: it provisions a session once when a boundless session attaches (carrying the same `buildPolicy` filesystem config), `exec`s each shell command against the live session, and deprovisions on teardown. macOS (seatbelt) and Linux (bubblewrap) keep the one-shot path; only Windows takes the stateful branch, because it is the only platform where the one-shot path is `E_NOTIMPL`.

The agent user IsolationSession provisions has an indefinite lifetime, so a boundless process that dies between provision and deprovision would orphan the account and its broker process with nothing on the books to reap it. boundless bounds that by sweeping for orphaned agent users at startup and reaping any left behind by a prior hard kill.

One caveat applies to every mxc backend: mxc notes its sandboxes "should not be treated as security boundaries currently." boundless's sandbox is a write-confinement guard against careless or accidental writes outside the working tree, not a hard jail against a determined adversary.
