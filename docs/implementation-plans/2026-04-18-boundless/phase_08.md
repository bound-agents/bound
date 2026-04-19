# Boundless Implementation Plan — Phase 8: CLI Entry & End-to-End Integration

**Goal:** Wire everything together: CLI argument parsing, startup sequence, graceful shutdown, binary compilation, and end-to-end validation that all components work as an integrated system.

**Architecture:** A single `boundless.tsx` entrypoint parses CLI args, loads config, connects to the bound server, acquires lockfile, performs attach, and renders the Ink App component. SIGTERM triggers graceful exit. The build script (already extended in Phase 1) compiles this to `dist/boundless`.

**Tech Stack:** TypeScript, Ink render(), BoundClient, bun:test

**Scope:** 8 phases from original design (phase 8 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC1: CLI Startup & Process Lifecycle
- **boundless.AC1.1 Success:** `boundless` with no args creates a new thread, acquires lockfile, launches TUI with empty scrollback
- **boundless.AC1.2 Success:** `boundless --attach <threadId>` loads existing thread, acquires lockfile, renders message history in scrollback
- **boundless.AC1.3 Success:** `boundless --url <url>` overrides config.json URL for the process lifetime without persisting
- **boundless.AC1.4 Failure:** `boundless --attach <nonexistent>` prints thread-not-found to stderr and exits 1
- **boundless.AC1.5 Failure:** `boundless` when bound server is unreachable prints connection error to stderr and exits 1
- **boundless.AC1.6 Success:** SIGTERM triggers graceful exit: MCP subprocesses terminated, lockfile released, exit 0
- **boundless.AC1.7 Success:** Binary compiles to `dist/boundless` via existing build script

### boundless.AC10: Protocol Extension — Content Widening
- **boundless.AC10.1 Success:** `tool:result` with `content: string` persisted as single text block (backward compatible)
- **boundless.AC10.2 Success:** `tool:result` with `content: ContentBlock[]` (text, image, document) persisted verbatim
- **boundless.AC10.3 Failure:** `tool:result` with invalid ContentBlock variant (e.g., tool_use, thinking) rejected with error response
- **boundless.AC10.4 Success:** Existing string-only clients continue to work unchanged

Note: AC10 was implemented server-side in Phase 1 (Task 9). This phase validates it end-to-end via integration tests.

---

<!-- START_TASK_1 -->
### Task 1: CLI entrypoint — boundless.tsx

**Verifies:** boundless.AC1.1, boundless.AC1.2, boundless.AC1.3, boundless.AC1.4, boundless.AC1.5, boundless.AC1.6

**Files:**
- Create: `packages/less/src/boundless.tsx`
- Test: `packages/less/src/__tests__/boundless-startup.test.ts`

**Implementation:**

`boundless.tsx` — the CLI entrypoint that orchestrates startup:

```tsx
#!/usr/bin/env bun
import { render } from "ink";
import React from "react";
```

**1. Parse arguments** from `process.argv.slice(2)`:
- `--attach <threadId>`: attach to existing thread
- `--url <url>`: override server URL for this process
- Unknown flags: print usage to stderr, exit 1

**2. Load config**:
```ts
const configDir = join(homedir(), ".bound", "less");
mkdirSync(configDir, { recursive: true });
const config = loadConfig(configDir);
const mcpConfig = loadMcpConfig(configDir);
```
If `--url` provided, override `config.url` (AC1.3 — without persisting).

**3. Connect BoundClient** with timeout:
```ts
const client = new BoundClient(config.url);
try {
    await Promise.race([
        client.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout")), 10000)),
    ]);
} catch (error) {
    process.stderr.write(`Error: Could not connect to bound server at ${config.url}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exit(1); // AC1.5
}
```

**4. Get or create thread**:
```ts
let threadId: string;
if (attachArg) {
    try {
        await client.getThread(attachArg);
        threadId = attachArg;
    } catch {
        process.stderr.write(`Error: Thread not found: ${attachArg}\n`);
        process.exit(1); // AC1.4
    }
} else {
    const thread = await client.createThread();
    threadId = thread.id; // AC1.1
}
```

**5. Acquire lockfile** (AC1.1, AC1.2):
```ts
try {
    acquireLock(configDir, threadId, process.cwd());
} catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
}
```

**6. Initialize logger and MCP**:
```ts
const logger = new AppLogger(configDir);
const mcpManager = new McpServerManager(logger);
import { hostname as getHostname } from "node:os";
const hostname = getHostname();
```

**7. Perform attach**:
```ts
const attachResult = await performAttach({
    client, threadId, mcpManager, mcpConfigs: mcpConfig.servers,
    cwd: process.cwd(), hostname, logger,
});
```

**8. Render App**:
```ts
const { waitUntilExit } = render(
    <App
        client={client}
        threadId={threadId}
        configDir={configDir}
        cwd={process.cwd()}
        hostname={hostname}
        mcpManager={mcpManager}
        mcpConfigs={mcpConfig.servers}
        logger={logger}
        initialMessages={attachResult.messages}
        model={config.model}
    />,
    { exitOnCtrlC: false }, // We handle Ctrl-C ourselves
);
```

**9. SIGTERM handler** (AC1.6):
```ts
process.on("SIGTERM", async () => {
    await mcpManager.terminateAll();
    releaseLock(configDir, threadId);
    client.disconnect();
    logger.close();
    process.exit(0);
});
```

**10. Wait for exit**:
```ts
await waitUntilExit();
```

**Testing:**

- boundless.AC1.4: Parse `--attach nonexistent-id`, mock client.getThread to throw, verify stderr output and exit code 1
- boundless.AC1.5: Mock BoundClient.connect to reject, verify stderr output and exit code 1
- boundless.AC1.1: Mock all dependencies to succeed, verify createThread called and lockfile acquired

Note: Full integration tests are in Task 3. This task tests the startup logic in isolation.

**Verification:**
Run: `bun test packages/less/src/__tests__/boundless-startup.test.ts`
Expected: All tests pass

**Commit:** `feat(less): CLI entrypoint with startup sequence and graceful shutdown`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Binary compilation verification

**Verifies:** boundless.AC1.7

**Files:**
- No modifications — verification only (build script already extended in Phase 1, Task 2)

**Step 1: Compile**

Run: `bun run build`
Expected: `dist/boundless` binary created (the entrypoint `packages/less/src/boundless.tsx` now exists).

**Step 2: Verify binary**

Run: `ls -la dist/boundless`
Expected: File exists with execute permissions

Run: `dist/boundless --help 2>&1 || true`
Expected: Prints usage or connection error (no server running is fine — verifies binary executes)

**Step 3: Commit**

```bash
git commit -m "chore: verify boundless binary compilation"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: End-to-end integration tests

**Verifies:** boundless.AC1.1, boundless.AC1.2, boundless.AC10.1, boundless.AC10.2, boundless.AC10.3, boundless.AC10.4

**Files:**
- Create: `packages/less/src/__tests__/e2e.integration.test.ts`

**Implementation:**

These tests require a running bound server. Structure them as integration tests that skip if no server is available.

**Test setup:**
```ts
import { BoundClient } from "@bound/client";

const BOUND_URL = process.env.BOUND_URL || "http://localhost:3001";
let client: BoundClient;

beforeAll(async () => {
    client = new BoundClient(BOUND_URL);
    try {
        await client.connect();
    } catch {
        // Skip all tests if no server
        return;
    }
});
```

**Test cases:**

1. **Startup with no args** (AC1.1): Create a new thread via client, verify it exists, verify empty message list.

2. **Startup with --attach** (AC1.2): Create a thread, send a message, list messages, verify history loads correctly.

3. **Content widening — string** (AC10.1): Send a tool:result with string content via WS, verify the persisted message has a single text block.

4. **Content widening — ContentBlock[]** (AC10.2): Send a tool:result with ContentBlock array (text + image), verify persisted verbatim.

5. **Content widening — invalid** (AC10.3): Send a tool:result with a tool_use ContentBlock, verify error response.

6. **Content widening — backward compat** (AC10.4): Send a tool:result with plain string (existing behavior), verify it works unchanged.

7. **Lockfile — same cwd conflict**: Acquire lock for a thread, try to acquire again from same cwd, verify error message.

8. **Lockfile — stale recovery**: Create a lockfile with dead PID, acquire lock, verify success.

**Testing notes:**
- Use `randomBytes(4).toString("hex")` for unique temp dirs
- Clean up lockfiles and threads in afterEach
- Integration tests may be slow — use longer timeouts

**Verification:**
Run: `bun test packages/less/src/__tests__/e2e.integration.test.ts`
Expected: All tests pass (or skip if no server)

**Commit:** `test(less): end-to-end integration tests for startup and content widening`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Full test suite verification

**Verifies:** None (verification only)

**Step 1: Run all package tests**

Run: `bun test packages/less`
Expected: All tests pass

**Step 2: Run affected packages**

Run: `bun test packages/web && bun test packages/agent && bun test packages/client`
Expected: No regressions from protocol changes

**Step 3: Typecheck all packages**

Run: `bun run typecheck`
Expected: All packages typecheck clean

**Step 4: Commit if fixups needed**

```bash
git commit -m "test: verify full suite passes after boundless integration"
```
<!-- END_TASK_4 -->
