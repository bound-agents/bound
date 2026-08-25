# Sandbox

This document covers two distinct sandboxing layers in Bound: the `@bound/sandbox` package — the agent's server-side virtual filesystem, OCC persistence, and command framework — and the OS-level filesystem sandbox that `boundless` (the terminal coding-agent client) uses to confine shell commands on the operator's real machine.

The two solve different problems. `@bound/sandbox` is an in-memory VFS whose contents never reach durable storage until they are persisted to the `files` table, so a stray write can never escape onto a real disk. boundless's sandbox, by contrast, guards a *real* working directory on the operator's host against writes outside it. The first half of this document covers `@bound/sandbox`; the [Sandboxing in boundless](#sandboxing-in-boundless) section at the end covers the latter.

---

## @bound/sandbox

The sandbox package provides a controlled Bash execution environment built on top of the `just-bash` library. It manages a virtual filesystem, persists workspace changes to a SQLite database, and defines custom commands that agents can invoke.

### ClusterFs

**Source:** `packages/sandbox/src/cluster-fs.ts`

`createClusterFs` constructs a `MountableFs` instance that routes filesystem paths to different underlying storage backends.

The layout is fixed:

| Mount path | Backend | Notes |
|---|---|---|
| `/` (base) | `InMemoryFs` | Catch-all for everything not otherwise mounted |
| `/home/user` | `InMemoryFs` | The agent's primary working directory |

```typescript
import { createClusterFs } from "@bound/sandbox";

const fs = createClusterFs({
  hostName: "worker-1",
  syncEnabled: true,
});
```

#### Snapshotting and diffing

The OCC (Optimistic Concurrency Control) persistence model relies on before/after snapshots of the in-memory workspace. Two functions handle this:

- **`snapshotWorkspace(fs, options?)`** — Returns a `Map<string, string>` of `path -> SHA-256 hash`. When `options.paths` is provided, only those specific paths are snapshotted — used by the agent loop to scope pre-execution snapshots to in-memory (agent-written) files only. Without `paths`, falls back to scanning all `/home/user/` paths via `fs.getAllPaths()`. Directories and unreadable entries are skipped.

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

## Sandboxing in boundless

`boundless` (the terminal coding-agent client, package `@bound/less`) faces a different containment problem from `@bound/sandbox` above. The `@bound/sandbox` VFS is in-memory and server-side: the agent loop reads and writes a `MountableFs` that only reaches durable storage when `persistWorkspaceChanges` flushes it to the `files` table. boundless's tools, by contrast, act on the operator's *real* working directory — `boundless_read` / `boundless_write` / `boundless_edit` touch real files and `boundless_bash` runs real shell commands. That surface needs OS-level containment. macOS and Linux use Microsoft [mxc](https://github.com/microsoft/mxc) (`@microsoft/mxc-sdk`); Windows uses Bound's native one-shot AppContainer lowbox helper.

**Source:** `packages/less/src/tools/sandbox-policy.ts` (shared policy and config core), `packages/less/src/tools/sandbox.ts` (POSIX mxc spawn path), `packages/less/src/tools/lowbox-runtime.ts` and `packages/less/src/native/bound-lowbox.cpp` (Windows spawn and native confinement).

### The policy shape

One rule, three knobs: read anything, write almost nothing, talk to the network freely. `buildPolicy` produces an mxc `SandboxPolicy` with:

- **`readonlyPaths: ["/"]`** — the whole filesystem is readable. Compilers and tools need system headers, libraries, and configs.
- **`readwritePaths: [cwd, tmpdir, ...extras]`** — writes are confined to the working directory, the system temp dir, and any operator-listed extra paths. A command can edit the project it is working in but cannot clobber `~/.ssh`, `/etc`, or a sibling checkout.
- **Network open** — outbound requests are unrestricted (package installs, API calls).

On macOS and Linux, mxc compiles this abstract `process` containment to seatbelt and bubblewrap. Windows bypasses mxc and maps the same policy to Bound's AppContainer token, scoped filesystem DACLs, and kill-on-close Job Object. `POLICY_VERSION` (`"0.6.0-alpha"`) validates the mxc SDK's supported window on the POSIX path; it does not select the Windows backend.

### The `.git` carve-out

One subpath runs the other way. Inside the writable cwd, `.git/hooks` and `.git/config` are pinned **read-only**. They hold scripts and config directives (`core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, aliases) that Git later executes as the operator, *outside* the sandbox — so without the carve-out a sandboxed run could plant a hook that fires on the operator's next `git` command and escape containment entirely. Git's own operations only ever read these paths, so the carve-out never breaks normal work. `computeGitProtectedPaths` computes the protected set.

It is enforced on Linux by layering read-only binds after the cwd read-write bind, by the in-process file tools on every platform, and on Windows by the lowbox helper's scoped DACL restoration. The Windows oracle covers existing and nested hook paths: `.git/config` and `.git/hooks` remain readable but cannot be replaced, while `.git/index`, refs, logs, and objects remain writable so normal Git operations continue to work.

### Degradation

When the selected platform backend cannot start, behavior follows the `onUnavailable` setting: `"error"` (default) refuses to run the command rather than execute it without write confinement, so a backend that breaks (e.g. after an OS update) can't silently drop write protection — the error names the exact config edit to opt into the lower-friction posture. `"passthrough"` runs the command unsandboxed with a warning instead. The sandbox is configured in `~/.bound/less/config.json` under the `sandbox` key — `false` to disable, or an object (`enabled`, `writablePaths`, `network`, `onUnavailable`) for finer control.

### The Windows backend

Windows commands go directly to Bound's native **one-shot AppContainer lowbox** backend; boundless never probes or falls back to mxc's BaseContainer or IsolationSession paths. Each command creates an AppContainer profile and lowbox token, grants only the working directory, temporary directories, and configured extras, launches the shell in a kill-on-close Job Object, and transfers cleanup authority to a watcher. The watcher owns cancellation after handoff, proves the descendant process tree is dead, restores ACLs, deletes the profile and journal, and reports cleanup failures.

The Windows CI oracle exercises eight confinement cases: writes inside allowed roots; denial of sibling, traversal, and junction escapes; ordinary Git writes with read-only `.git/config` and `.git/hooks` (including nested existing hooks); descendant process-tree cancellation; and watcher-owned profile, ACL, and journal cleanup. These are OS-enforced checks on `windows-latest`, not source-shape assertions.

Profile creation is intentionally unprivileged. A host policy or Windows configuration that prevents the current user from calling `CreateAppContainerProfile` makes lowbox unavailable; no administrator bootstrap or persisted privileged service is installed. The default `onUnavailable: "error"` posture refuses the command with guidance. `"passthrough"` is an explicit unsandboxed escape hatch and is always surfaced as `ran UNSANDBOXED`.

The POSIX mxc project notes that its sandboxes "should not be treated as security boundaries currently." Across all platforms, boundless treats this machinery as a write-confinement guard against careless or accidental writes outside the working tree, not as a hard jail against a determined adversary.
