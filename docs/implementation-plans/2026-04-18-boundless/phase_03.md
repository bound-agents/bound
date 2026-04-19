# Boundless Implementation Plan — Phase 3: Core Tools

**Goal:** Implement the four host-side tool handlers (read, write, edit, bash) with provenance metadata, abort support, and a tool registry that merges core tools with MCP-proxied tools.

**Architecture:** Each tool is a standalone async function returning `ContentBlock[]`. A registry module merges all tools into a unified `ToolDefinition[]` for `session:configure`. The bash tool uses `Bun.spawn` for real shell execution with AbortSignal support. All tools prepend a provenance text block.

**Tech Stack:** TypeScript, Bun.spawn, Node.js `fs`, bun:test

**Scope:** 8 phases from original design (phase 3 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC5: Core Tools
- **boundless.AC5.1 Success:** `boundless_read` returns line-numbered content with provenance prefix for valid file path
- **boundless.AC5.2 Success:** `boundless_read` with offset/limit returns the specified line range
- **boundless.AC5.3 Failure:** `boundless_read` on nonexistent file returns isError with ENOENT message
- **boundless.AC5.4 Edge:** `boundless_read` on binary file returns summary instead of raw content
- **boundless.AC5.5 Success:** `boundless_write` creates file with parent directories, returns byte count
- **boundless.AC5.6 Success:** `boundless_edit` replaces exactly one match of old_string with new_string
- **boundless.AC5.7 Failure:** `boundless_edit` with no match returns isError with "not found" message
- **boundless.AC5.8 Failure:** `boundless_edit` with multiple matches returns isError with match count and context
- **boundless.AC5.9 Success:** `boundless_bash` executes command in cwd, returns stdout/stderr with exit code
- **boundless.AC5.10 Success:** `boundless_bash` on AbortSignal sends SIGTERM, waits 2s, sends SIGKILL
- **boundless.AC5.11 Edge:** `boundless_bash` output >100KB is truncated from the middle with marker
- **boundless.AC5.12 Success:** All tool results are `ContentBlock[]` with provenance text block first
- **boundless.AC5.13 Success:** Tool registry detects name collisions and rejects the offending MCP server

---

<!-- START_TASK_1 -->
### Task 1: ToolHandler type and provenance formatting

**Verifies:** boundless.AC5.12

**Files:**
- Create: `packages/less/src/tools/types.ts`
- Create: `packages/less/src/tools/provenance.ts`
- Test: `packages/less/src/__tests__/provenance.test.ts`

**Implementation:**

`types.ts`:
```ts
import type { ContentBlock } from "@bound/llm";

export type ToolHandler = (
    args: Record<string, unknown>,
    signal: AbortSignal,
    cwd: string,
) => Promise<ContentBlock[]>;

export interface ToolResult {
    content: ContentBlock[];
    isError?: boolean;
}
```

`provenance.ts`:
```ts
import type { ContentBlock } from "@bound/llm";

export function formatProvenance(hostname: string, cwd: string, toolName: string): ContentBlock {
    return { type: "text", text: `[boundless] host=${hostname} cwd=${cwd} tool=${toolName}` };
}

export function formatMcpProvenance(hostname: string, serverName: string, toolName: string): ContentBlock {
    return { type: "text", text: `[boundless:mcp] host=${hostname} server=${serverName} tool=${toolName}` };
}
```

**Testing:**

- boundless.AC5.12: Verify `formatProvenance` returns a text ContentBlock with the correct format string

**Verification:**
Run: `bun test packages/less/src/__tests__/provenance.test.ts`
Expected: All tests pass

**Commit:** `feat(less): tool handler types and provenance formatting`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->

<!-- START_TASK_2 -->
### Task 2: boundless_read tool handler

**Verifies:** boundless.AC5.1, boundless.AC5.2, boundless.AC5.3, boundless.AC5.4, boundless.AC5.12

**Files:**
- Create: `packages/less/src/tools/read.ts`
- Test: `packages/less/src/__tests__/read.test.ts`

**Implementation:**

Export `readTool: ToolHandler`. Args: `{ file_path: string, offset?: number, limit?: number }`.

1. Resolve `file_path` relative to `cwd` if not absolute.
2. Read file with `readFileSync(resolvedPath)`.
3. On ENOENT: return `[provenance, { type: "text", text: "Error: ENOENT: no such file or directory: ..." }]` with `isError: true`.
4. **Binary detection** (AC5.4): Check first 8KB of buffer for null bytes (`buffer.indexOf(0) !== -1 && buffer.indexOf(0) < 8192`). If binary, return summary: `"Binary file: ${path} (${size} bytes)"` instead of content.
5. Convert to string, split into lines.
6. Apply offset (1-indexed) and limit if provided (AC5.2). Default: all lines.
7. Format with line numbers: `"  ${lineNum}\t${line}"` per line (matching `cat -n` style).
8. Return `[provenance, { type: "text", text: numberedContent }]`.

**Testing:**

- boundless.AC5.1: Create temp file with known content, call readTool, verify output has provenance block first and line-numbered content
- boundless.AC5.2: Create 20-line file, call with offset=5, limit=3, verify only lines 5-7 returned
- boundless.AC5.3: Call with nonexistent path, verify isError result with ENOENT
- boundless.AC5.4: Create a file with null bytes, verify returns binary summary
- boundless.AC5.12: Verify first ContentBlock is always provenance text

**Verification:**
Run: `bun test packages/less/src/__tests__/read.test.ts`
Expected: All tests pass

**Commit:** `feat(less): boundless_read tool with line numbers and binary detection`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: boundless_write tool handler

**Verifies:** boundless.AC5.5, boundless.AC5.12

**Files:**
- Create: `packages/less/src/tools/write.ts`
- Test: `packages/less/src/__tests__/write.test.ts`

**Implementation:**

Export `writeTool: ToolHandler`. Args: `{ file_path: string, content: string }`.

1. Resolve `file_path` relative to `cwd`.
2. Create parent directories: `mkdirSync(dirname(resolvedPath), { recursive: true })`.
3. Atomic write: write to temp file in same directory (`.${basename}.tmp.${randomBytes(4).toString("hex")}`), then `renameSync(tempPath, resolvedPath)`.
4. Calculate byte count: `Buffer.byteLength(content, "utf-8")`.
5. Return `[provenance, { type: "text", text: "Wrote ${byteCount} bytes to ${file_path}" }]`.

**Testing:**

- boundless.AC5.5: Call writeTool to a path with nonexistent parent dirs, verify file created with correct content and parent dirs exist
- boundless.AC5.12: Verify provenance block first

**Verification:**
Run: `bun test packages/less/src/__tests__/write.test.ts`
Expected: All tests pass

**Commit:** `feat(less): boundless_write tool with atomic writes`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: boundless_edit tool handler

**Verifies:** boundless.AC5.6, boundless.AC5.7, boundless.AC5.8, boundless.AC5.12

**Files:**
- Create: `packages/less/src/tools/edit.ts`
- Test: `packages/less/src/__tests__/edit.test.ts`

**Implementation:**

Export `editTool: ToolHandler`. Args: `{ file_path: string, old_string: string, new_string: string }`.

1. Resolve and read file content.
2. Count occurrences of `old_string` in content using `split(old_string).length - 1`.
3. If count === 0: return error `"old_string not found in ${file_path}"` (AC5.7).
4. If count > 1: return error with match count and context. Show first 2-3 match locations with surrounding lines for disambiguation (AC5.8).
5. If count === 1: replace with `content.replace(old_string, new_string)`, write back (AC5.6).
6. Return `[provenance, { type: "text", text: "Edited ${file_path}: replaced 1 occurrence" }]`.

**Testing:**

- boundless.AC5.6: Create file with unique string, call editTool, verify replacement applied correctly
- boundless.AC5.7: Call with old_string not in file, verify isError with "not found"
- boundless.AC5.8: Create file with duplicated string, call editTool, verify isError with match count
- boundless.AC5.12: Verify provenance block in all cases

**Verification:**
Run: `bun test packages/less/src/__tests__/edit.test.ts`
Expected: All tests pass

**Commit:** `feat(less): boundless_edit tool with exact-match validation`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: boundless_bash tool handler

**Verifies:** boundless.AC5.9, boundless.AC5.10, boundless.AC5.11, boundless.AC5.12

**Files:**
- Create: `packages/less/src/tools/bash.ts`
- Test: `packages/less/src/__tests__/bash.test.ts`

**Implementation:**

Export `bashTool: ToolHandler`. Args: `{ command: string, timeout?: number }`.

Also export `bashToolWithStreaming(args, signal, cwd, onStdoutChunk: (chunk: string) => void): Promise<ContentBlock[]>` — a variant that streams stdout chunks to a callback in real-time (for AC9.3 TUI streaming). The base `bashTool` calls this internally with a no-op callback.

1. Default timeout: 300000ms (5 minutes).
2. Spawn subprocess using `Bun.spawn`:
   ```ts
   const proc = Bun.spawn(["sh", "-c", command], {
       cwd,
       stdout: "pipe",
       stderr: "pipe",
       env: { ...process.env },
   });
   ```

3. **AbortSignal handling** (AC5.10): Listen for `signal.addEventListener("abort", ...)`. On abort:
   - Send SIGTERM to process group: `process.kill(-proc.pid, "SIGTERM")` (negative PID = process group). Fall back to `proc.kill("SIGTERM")` if group kill fails.
   - Wait 2 seconds via `setTimeout`.
   - If still alive, send SIGKILL: `proc.kill("SIGKILL")`.

4. **Timeout**: Create an `AbortController` internally, schedule `setTimeout(() => controller.abort(), timeout)`. Chain with the external signal.

5. Collect stdout and stderr. For the streaming variant: read from `proc.stdout` as a ReadableStream, calling `onStdoutChunk(chunk)` for each decoded text chunk. For the base variant: use `Bun.readableStreamToText(proc.stdout)` for simplicity. Stderr is always collected in full (not streamed).

6. **Output truncation** (AC5.11): If combined output exceeds 100KB (102400 bytes), truncate from the middle:
   ```
   [first 50KB]
   \n... [truncated X bytes from middle] ...\n
   [last 50KB]
   ```

7. Format result:
   ```
   Exit code: ${exitCode}
   stdout:
   ${stdout}
   stderr:
   ${stderr}
   ```

8. Return `[provenance, { type: "text", text: formattedOutput }]`.

**Testing:**

- boundless.AC5.9: Run `echo hello`, verify stdout contains "hello" and exit code 0
- boundless.AC5.10: Run `sleep 60`, immediately abort via AbortController, verify process terminated within ~3s
- boundless.AC5.11: Run a command that produces >100KB output (e.g., `seq 1 50000`), verify output is truncated with marker
- boundless.AC5.12: Verify provenance block first

Note: AC5.10 test should use `setTimeout` to trigger abort after a short delay, then verify the process was killed. Use `afterEach` cleanup to ensure no zombie processes.

**Verification:**
Run: `bun test packages/less/src/__tests__/bash.test.ts`
Expected: All tests pass

**Commit:** `feat(less): boundless_bash tool with abort and output truncation`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Tool registry with collision detection

**Verifies:** boundless.AC5.13

**Files:**
- Create: `packages/less/src/tools/registry.ts`
- Test: `packages/less/src/__tests__/registry.test.ts`

**Implementation:**

Export:

1. **`buildToolSet(cwd: string, hostname: string, mcpTools?: Map<string, ToolDefinition[]>)`** — Returns `{ tools: ToolDefinition[], handlers: Map<string, ToolHandler> }`:

   - Start with core four tools: `boundless_read`, `boundless_write`, `boundless_edit`, `boundless_bash`. Create `ToolDefinition` objects for each with appropriate JSON Schema parameters.
   - If `mcpTools` provided, merge under `boundless_mcp_<server>_<tool>` namespace.
   - **Collision detection** (AC5.13): Before merging each MCP server's tools, check if any `boundless_mcp_<server>_<tool>` name collides with existing names (core tools or previously merged MCP tools). If collision found, reject the entire MCP server with an error: `"MCP server '${server}' has tool '${tool}' that collides with existing tool '${existingName}'"`. Return the error in a list of failures; do not include that server's tools.

2. **`buildSystemPromptAddition(cwd: string, hostname: string, mcpServers: string[])`** — Returns a string to be used as `systemPromptAddition`:
   ```
   You are connected to a boundless terminal client.
   Host: ${hostname}
   Working directory: ${cwd}
   Available tool namespaces: boundless_read, boundless_write, boundless_edit, boundless_bash${mcpServers.map(s => `, boundless_mcp_${s}_*`).join("")}
   
   Tool results include provenance metadata showing which host and directory produced them.
   ```

3. **Core tool definitions** — Define `ToolDefinition` objects matching the `ToolDefinition` type from `@bound/client`:
   - `boundless_read`: `{ file_path: string (required), offset: number (optional), limit: number (optional) }`
   - `boundless_write`: `{ file_path: string (required), content: string (required) }`
   - `boundless_edit`: `{ file_path: string (required), old_string: string (required), new_string: string (required) }`
   - `boundless_bash`: `{ command: string (required), timeout: number (optional) }`

**Testing:**

- boundless.AC5.13: Build a tool set, then attempt to add an MCP server with a tool named `boundless_read`, verify it's rejected with collision error. Also test that two MCP servers with different tools merge cleanly.

**Verification:**
Run: `bun test packages/less/src/__tests__/registry.test.ts`
Expected: All tests pass

**Commit:** `feat(less): tool registry with collision detection and system prompt builder`
<!-- END_TASK_6 -->
