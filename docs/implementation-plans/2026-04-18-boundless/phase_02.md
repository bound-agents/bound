# Boundless Implementation Plan — Phase 2: Configuration, Lockfile & Logging

**Goal:** Implement the on-disk state layer for boundless: config loading/saving with forward compatibility, lockfile protocol for single-attach enforcement, and structured JSON-lines logging.

**Architecture:** Three standalone modules in `packages/less/src/` with no dependencies beyond Node `fs`, `os`, and Zod. Config files live at `~/.bound/less/`, lockfiles at `~/.bound/less/locks/`, logs at `~/.bound/less/logs/`. All use Node.js `fs` module following existing codebase convention.

**Tech Stack:** TypeScript, Zod v4, Node.js `fs`, bun:test

**Scope:** 8 phases from original design (phase 2 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC4: Configuration & Lockfile
- **boundless.AC4.1 Success:** Absent `config.json` treated as defaults (url=http://localhost:3001, model=null)
- **boundless.AC4.2 Success:** Absent `mcp.json` treated as `{ servers: [] }`
- **boundless.AC4.3 Success:** Config save preserves unknown fields (forward compatibility)
- **boundless.AC4.4 Success:** Lockfile acquired with O_EXCL for new thread; file contains `{ cwd, pid, attachedAt }`
- **boundless.AC4.5 Success:** Stale lockfile (dead pid via ESRCH) is cleared and re-acquired
- **boundless.AC4.6 Failure:** Live pid + same cwd produces error "thread X is already attached from this directory by pid Y"
- **boundless.AC4.7 Failure:** Live pid + different cwd produces error "thread X is attached from Z by pid Y; you are in W"
- **boundless.AC4.8 Success:** Lockfile released on detach (transition, exit, SIGTERM)
- **boundless.AC4.9 Failure:** Duplicate server names in `mcp.json` rejected at load time with specific error

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Config loading and saving with Zod schemas

**Verifies:** boundless.AC4.1, boundless.AC4.2, boundless.AC4.3, boundless.AC4.9

**Files:**
- Create: `packages/less/src/config.ts`
- Test: `packages/less/src/__tests__/config.test.ts`

**Implementation:**

Create `config.ts` with these exports:

1. **`configSchema`** — Zod schema for `~/.bound/less/config.json`:
   ```ts
   const configSchema = z.object({
       url: z.string().default("http://localhost:3001"),
       model: z.string().nullable().default(null),
   }).passthrough(); // forward compat: preserve unknown fields
   ```
   `passthrough()` is critical for AC4.3 — it preserves any fields the schema doesn't know about during parse + re-serialize.

2. **`mcpServerSchema`** — Mirror the existing `mcpServerSchema` pattern from `packages/shared/src/config-schemas.ts:201-204` but in camelCase:
   ```ts
   const mcpServerStdioSchema = z.object({
       transport: z.literal("stdio"),
       name: z.string(),
       command: z.string(),
       args: z.array(z.string()).default([]),
       env: z.record(z.string(), z.string()).optional(),
       enabled: z.boolean().default(true),
       allowTools: z.array(z.string()).optional(),
       confirm: z.array(z.string()).optional(),
   });
   const mcpServerHttpSchema = z.object({
       transport: z.literal("http"),
       name: z.string(),
       url: z.string(),
       enabled: z.boolean().default(true),
       allowTools: z.array(z.string()).optional(),
       confirm: z.array(z.string()).optional(),
   });
   const mcpServerSchema = z.discriminatedUnion("transport", [
       mcpServerStdioSchema,
       mcpServerHttpSchema,
   ]);
   ```

3. **`mcpConfigSchema`** — Wrapping schema:
   ```ts
   const mcpConfigSchema = z.object({
       servers: z.array(mcpServerSchema),
   }).passthrough();
   ```

4. **`loadConfig(configDir: string)`** — Returns `{ url, model, _raw }`:
   - Read `configDir/config.json` with `readFileSync`
   - If file doesn't exist, return defaults (AC4.1)
   - Parse with `configSchema.safeParse(JSON.parse(content))`
   - On parse error, throw with details
   - Store raw parsed object (including unknown fields) for round-trip

5. **`saveConfig(configDir: string, config: Config)`** — Writes config preserving unknown fields:
   - Merge known fields into `_raw` object
   - `writeFileSync(path, JSON.stringify(merged, null, "\t"))` (tabs match Biome)

6. **`loadMcpConfig(configDir: string)`** — Returns `{ servers }`:
   - Read `configDir/mcp.json`
   - If file doesn't exist, return `{ servers: [] }` (AC4.2)
   - Parse with `mcpConfigSchema.safeParse()`
   - **Validate server name uniqueness** (AC4.9): after parsing, check for duplicate `name` fields. If found, throw a specific error: `"Duplicate MCP server name: '${name}' appears ${count} times in mcp.json"`

7. **`saveMcpConfig(configDir: string, config: McpConfig)`** — Same round-trip pattern as `saveConfig`.

Export types: `Config`, `McpConfig`, `McpServerConfig`.

**Testing:**

Tests must verify each AC:
- boundless.AC4.1: Call `loadConfig` on nonexistent config dir path, verify returns `{ url: "http://localhost:3001", model: null }`
- boundless.AC4.2: Call `loadMcpConfig` on nonexistent path, verify returns `{ servers: [] }`
- boundless.AC4.3: Load a config.json with extra fields (`{ "url": "...", "model": null, "futureField": 42 }`), save it, reload, verify `futureField` is preserved
- boundless.AC4.9: Load an mcp.json with two servers named "github", verify throws error containing "Duplicate MCP server name"

Use temp directories with `randomBytes(4).toString("hex")` per test for isolation.

**Verification:**
Run: `bun test packages/less/src/__tests__/config.test.ts`
Expected: All tests pass

**Commit:** `feat(less): config loading and saving with forward compatibility`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Lockfile protocol with O_EXCL and stale detection

**Verifies:** boundless.AC4.4, boundless.AC4.5, boundless.AC4.6, boundless.AC4.7, boundless.AC4.8

**Files:**
- Create: `packages/less/src/lockfile.ts`
- Test: `packages/less/src/__tests__/lockfile.test.ts`

**Implementation:**

Create `lockfile.ts` with these exports:

1. **`ensureLocksDir(configDir: string)`** — Creates `${configDir}/locks/` with `mkdirSync({ recursive: true })`.

2. **`acquireLock(configDir: string, threadId: string, cwd: string)`** — Atomic lockfile acquisition:
   ```ts
   const lockPath = join(configDir, "locks", `${threadId}.json`);
   const lockData = JSON.stringify({ cwd, pid: process.pid, attachedAt: new Date().toISOString() });
   ```

   Use Node `fs.openSync` with `O_WRONLY | O_CREAT | O_EXCL` flags for atomic creation (AC4.4):
   ```ts
   import { openSync, writeSync, closeSync, constants } from "node:fs";
   const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
   writeSync(fd, lockData);
   closeSync(fd);
   ```

   If `openSync` throws `EEXIST`:
   - Read existing lock: `JSON.parse(readFileSync(lockPath, "utf-8"))`
   - Check if PID is alive via `process.kill(existingLock.pid, 0)` in try-catch
   - If dead (throws): stale lock — `unlinkSync(lockPath)`, retry acquisition (AC4.5)
   - If alive + same cwd: throw `"thread ${threadId} is already attached from this directory by pid ${existingLock.pid}"` (AC4.6)
   - If alive + different cwd: throw `"thread ${threadId} is attached from ${existingLock.cwd} by pid ${existingLock.pid}; you are in ${cwd}"` (AC4.7)

3. **`releaseLock(configDir: string, threadId: string)`** — Best-effort removal:
   ```ts
   try { unlinkSync(join(configDir, "locks", `${threadId}.json`)); } catch {}
   ```
   Silent failure is fine — lock may already be cleaned up (AC4.8).

4. **`readLock(configDir: string, threadId: string)`** — Returns parsed lock data or null if no lock exists.

**Testing:**

Tests must verify each AC:
- boundless.AC4.4: Call `acquireLock` for a new thread, verify lock file created with correct `{ cwd, pid, attachedAt }` JSON content
- boundless.AC4.5: Create a lockfile with a dead PID (e.g., PID 999999), call `acquireLock`, verify stale lock cleared and new lock acquired
- boundless.AC4.6: Acquire lock with current PID and cwd "/a", call `acquireLock` again with same cwd "/a", verify error message matches "thread X is already attached from this directory by pid Y"
- boundless.AC4.7: Acquire lock with current PID and cwd "/a", call `acquireLock` with cwd "/b", verify error message matches "thread X is attached from /a by pid Y; you are in /b"
- boundless.AC4.8: Acquire lock, call `releaseLock`, verify lock file no longer exists

Use temp directories for isolation. For AC4.6/AC4.7, acquiring with current PID means the stale check will pass (process is alive), so those test the live-pid error paths.

**Verification:**
Run: `bun test packages/less/src/__tests__/lockfile.test.ts`
Expected: All tests pass

**Commit:** `feat(less): lockfile protocol with O_EXCL and stale PID detection`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Structured JSON-lines logging

**Verifies:** None (infrastructure, verified operationally)

**Files:**
- Create: `packages/less/src/logging.ts`
- Test: `packages/less/src/__tests__/logging.test.ts`

**Implementation:**

Create `logging.ts` with these exports:

1. **`ensureLogDirs(configDir: string)`** — Creates `${configDir}/logs/` with `mkdirSync({ recursive: true })`.

2. **`AppLogger` class** — Structured JSON-lines logger:
   ```ts
   class AppLogger {
       private appFd: number; // file descriptor for application.log
       private connFd: number | null = null; // per-connection log
       private connLogPath: string | null = null;

       constructor(configDir: string) {
           ensureLogDirs(configDir);
           const appLogPath = join(configDir, "logs", "application.log");
           this.appFd = openSync(appLogPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
       }
   ```

3. **Log methods**: `info()`, `warn()`, `error()`, `debug()`. Each writes a JSON line to the application log:
   ```ts
   { "ts": "2026-04-18T...", "level": "INFO", "pid": 12345, "event": "startup", ...fields }
   ```
   Application log is INFO+ only. `debug()` writes to connection log (if open) only.

4. **`openConnectionLog(configDir: string, threadId: string, connectionId: string)`** — Opens a per-connection log at `${configDir}/logs/${threadId}/${connectionId}.log` at DEBUG+ level. Creates thread subdirectory if needed.

5. **`closeConnectionLog()`** — Closes the connection-level file descriptor.

6. **`openMcpStderrLog(configDir: string, threadId: string, connectionId: string, serverName: string)`** — Returns a writable path `${configDir}/logs/${threadId}/${connectionId}-${serverName}.log` for piping MCP subprocess stderr.

7. **`close()`** — Closes all open file descriptors.

**Testing:**

- Create AppLogger with temp dir, call `logger.info("test", { event: "startup" })`, read the log file, verify valid JSON line with expected fields
- Open connection log, call `logger.debug("detail")`, verify written to connection log but NOT to application log
- Call `close()`, verify file descriptors released (no errors on subsequent operations)

**Verification:**
Run: `bun test packages/less/src/__tests__/logging.test.ts`
Expected: All tests pass

**Commit:** `feat(less): structured JSON-lines logging with per-connection logs`
<!-- END_TASK_3 -->
