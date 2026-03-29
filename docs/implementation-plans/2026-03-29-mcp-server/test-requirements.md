# MCP Server — Test Requirements

Maps every acceptance criterion from the [MCP Server design plan](../../design-plans/2026-03-29-mcp-server.md) to either an automated test or a documented human verification procedure.

## Summary Table

| AC ID | Description | Verification | Type | Phase | Test File / Procedure |
|---|---|---|---|---|---|
| AC1.1 | `bun build --compile` exits 0 and produces `dist/bound-mcp` | Human | -- | P3, P4 | [Human: AC1.1](#mcp-serverac11-bun-build---compile-exits-0-and-produces-distbound-mcp) |
| AC1.2 | Binary responds to MCP `initialize` and lists `bound_chat` in `tools/list` | Human | -- | P3 | [Human: AC1.2](#mcp-serverac12-binary-responds-to-mcp-initialize-and-lists-bound_chat-in-toolslist) |
| AC2.1 | `bound_chat` accepts `message` (required) and `thread_id` (optional) | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/server.test.ts` |
| AC2.2 | MCP framework rejects `bound_chat` call missing `message` | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/server.test.ts` |
| AC3.1 | `--url` CLI arg sets the bound agent base URL | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/server.test.ts` |
| AC3.2 | `BOUND_URL` env var sets the base URL when `--url` absent | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/server.test.ts` |
| AC3.3 | Defaults to `http://localhost:3000` when neither provided | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/server.test.ts` |
| AC4.1 | `bound_chat` with no `thread_id` creates new thread via `POST /api/mcp/threads` | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/handler.test.ts` |
| AC4.2 | Created thread has `interface="mcp"` and correct `user_id` | Automated | Integration | P1 | `packages/web/src/server/__tests__/mcp.integration.test.ts` |
| AC4.3 | `bound_chat` with supplied `thread_id` sends to that thread without creating new one | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/handler.test.ts` |
| AC4.4 | `bound_chat` returns last `role:"assistant"` message as `{ type:"text" }` content block | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/handler.test.ts` |
| AC5.1 | `bound_chat` returns `isError:true` with URL when agent unreachable | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/handler.test.ts` |
| AC5.2 | `bound_chat` returns `isError:true` when agent loop exceeds 5 minutes | Automated | Unit | P3 | `packages/mcp-server/src/__tests__/handler.test.ts` |
| AC6.1 | `POST /api/mcp/threads` returns 201 with `{ thread_id }` | Automated | Integration | P1 | `packages/web/src/server/__tests__/mcp.integration.test.ts` |
| AC6.2 | Thread has correct `user_id` and `interface="mcp"` | Automated | Integration | P1 | `packages/web/src/server/__tests__/mcp.integration.test.ts` |
| AC6.3 | `mcp` system user exists in DB after startup | Automated | Unit | P1 | `packages/cli/src/__tests__/mcp-user.test.ts` |
| AC6.4 | `mcp` user provisioning is idempotent | Automated | Unit | P1 | `packages/cli/src/__tests__/mcp-user.test.ts` |
| AC6.5 | `POST /api/mcp/threads` rejects non-localhost Host headers | Automated | Integration | P1 | `packages/web/src/server/__tests__/mcp.integration.test.ts` |

---

## AC1: Binary compiles and runs as an MCP server

### mcp-server.AC1.1: `bun build --compile` exits 0 and produces `dist/bound-mcp`

**Verification:** Human

**Justification:** Binary compilation is a build-system operation that depends on the host environment (OS, architecture, Bun version). It cannot be meaningfully unit-tested because the test would need to invoke `bun build --compile` as a subprocess and inspect the resulting file. This is better handled as a CI gate or manual build verification.

**Step-by-step verification:**

1. From the repository root, run:
   ```bash
   bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp
   echo "Exit code: $?"
   ```
2. Confirm exit code is `0`.
3. Confirm binary exists and has a non-zero size:
   ```bash
   ls -lh dist/bound-mcp
   ```
4. Alternatively, run `bun run build` and confirm the build summary lists `dist/bound-mcp` with a non-zero size.

---

### mcp-server.AC1.2: Binary responds to MCP `initialize` and lists `bound_chat` in `tools/list`

**Verification:** Human

**Justification:** This criterion requires running the compiled binary as a subprocess, writing JSON-RPC messages to its stdin, and reading JSON-RPC responses from its stdout. This is an end-to-end verification of the stdio transport that depends on the binary being compiled first (AC1.1). It crosses process boundaries and involves timing-sensitive I/O. While technically automatable, it requires subprocess management that would be fragile and slow. Better suited as a manual smoke test.

**Step-by-step verification:**

1. Build the binary (per AC1.1 procedure).
2. Send an `initialize` request followed by `tools/list` over stdin:
   ```bash
   printf '%s\n%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
     | timeout 5 ./dist/bound-mcp 2>/dev/null || true
   ```
3. Confirm stdout contains two JSON-RPC responses.
4. Confirm the response with `"id":2` contains a `tools` array.
5. Confirm one entry in `tools` has `"name":"bound_chat"`.
6. Confirm the `inputSchema` for `bound_chat` has `"message"` in `"required"` and both `message` (string) and `thread_id` (string, optional) in `"properties"`.

---

## AC2: `bound_chat` tool interface

### mcp-server.AC2.1: `bound_chat` accepts `message` (required) and `thread_id` (optional)

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/server.test.ts`

**Description:** Validates that the Zod input schema used by the `bound_chat` tool registration accepts objects with `message` (string, required) and `thread_id` (string, optional). Covered by the `"bound-mcp bound_chat schema"` describe block. Specifically, `schema.safeParse({ message: "Hello" })` succeeds and `schema.safeParse({ message: "Hello", thread_id: "t-1" })` succeeds, confirming both parameters are accepted with the correct types and optionality.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/server.test.ts
```

---

### mcp-server.AC2.2: MCP framework rejects `bound_chat` call missing `message`

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/server.test.ts`

**Description:** Tests that the Zod input schema rejects objects missing the `message` field. The test `"mcp-server.AC2.2: inputSchema rejects call without message parameter"` asserts `schema.safeParse({}).success === false` and `schema.safeParse({ thread_id: "t-1" }).success === false`. Since the MCP SDK validates tool inputs against this schema before dispatching to the handler, a failed parse results in a protocol error returned to the MCP host.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/server.test.ts
```

---

## AC3: Bound agent URL configuration

### mcp-server.AC3.1: `--url` CLI arg sets the bound agent base URL

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/server.test.ts`

**Description:** The test `"mcp-server.AC3.1: --url arg sets the base URL"` calls the replicated `getBaseUrl` function with `argv = ["bun", "server.ts", "--url", "http://myhost:4000"]` and an empty env. Asserts the returned URL is `"http://myhost:4000"`. An additional test confirms `--url` takes precedence over `BOUND_URL`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/server.test.ts
```

---

### mcp-server.AC3.2: `BOUND_URL` env var sets the base URL when `--url` absent

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/server.test.ts`

**Description:** The test `"mcp-server.AC3.2: BOUND_URL env var used when --url absent"` calls `getBaseUrl` with no `--url` in argv and `env = { BOUND_URL: "http://myhost:4000" }`. Asserts the returned URL is `"http://myhost:4000"`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/server.test.ts
```

---

### mcp-server.AC3.3: Defaults to `http://localhost:3000` when neither provided

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/server.test.ts`

**Description:** The test `"mcp-server.AC3.3: defaults to http://localhost:3000 when neither provided"` calls `getBaseUrl` with no `--url` arg and empty env. Asserts the returned URL is `"http://localhost:3000"`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/server.test.ts
```

---

## AC4: Thread and message flow

### mcp-server.AC4.1: `bound_chat` with no `thread_id` creates new thread via `POST /api/mcp/threads`

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/handler.test.ts`

**Description:** The test `"mcp-server.AC4.1: creates new thread when no thread_id supplied"` creates a mock `BoundClient`, invokes the handler with `{ message: "Hello" }` (no `thread_id`), and asserts that `client.createMcpThread` was called exactly once and `client.sendMessage` was called with the thread ID returned by `createMcpThread`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/handler.test.ts
```

---

### mcp-server.AC4.2: Created thread has `interface="mcp"` and `user_id=deterministicUUID(BOUND_NAMESPACE, "mcp")`

**Verification:** Automated (integration)

**Test file:** `packages/web/src/server/__tests__/mcp.integration.test.ts`

**Description:** The test `"mcp-server.AC6.2: thread has correct user_id and interface"` creates a thread via `POST /api/mcp/threads` on an in-memory Hono app backed by a real SQLite database, then queries the `threads` table directly. Asserts `user_id === deterministicUUID(BOUND_NAMESPACE, "mcp")` and `interface === "mcp"`. This test covers both AC4.2 and AC6.2 since AC4.2 is about the thread attributes set by the server-side endpoint that AC6.2 also validates.

**Run:**
```bash
bun test packages/web/src/server/__tests__/mcp.integration.test.ts
```

---

### mcp-server.AC4.3: `bound_chat` with supplied `thread_id` sends to that thread without creating new one

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/handler.test.ts`

**Description:** The test `"mcp-server.AC4.3: reuses supplied thread_id without creating a new thread"` invokes the handler with `{ message: "Follow up", thread_id: "existing-thread" }` and asserts that `client.createMcpThread` was **not** called, while `client.sendMessage` was called with `"existing-thread"` as the thread ID.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/handler.test.ts
```

---

### mcp-server.AC4.4: `bound_chat` returns last `role:"assistant"` message as `{ type:"text" }` content block

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/handler.test.ts`

**Description:** Two tests in the `"mcp-server.AC4.4"` describe block:
1. `"returns correct content from last assistant message"` -- mock client returns a message list with one assistant message. Asserts the handler returns `{ content: [{ type: "text", text: "Hello from bound!" }] }` with no `isError`.
2. `"returns empty string when no assistant message exists"` -- mock client returns an empty message list. Asserts the handler returns `{ content: [{ type: "text", text: "" }] }`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/handler.test.ts
```

---

## AC5: Error handling

### mcp-server.AC5.1: `bound_chat` returns `isError:true` with URL when agent unreachable

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/handler.test.ts`

**Description:** Three tests in the `"mcp-server.AC5.1"` describe block cover unreachability at each stage of the handler flow:
1. `"returns isError:true with URL in message when createMcpThread throws BoundNotRunningError"` -- mock `createMcpThread` throws `BoundNotRunningError("http://localhost:3000")`. Asserts `result.isError === true` and `result.content[0].text` contains `"http://localhost:3000"`.
2. `"returns isError:true when sendMessage throws BoundNotRunningError"` -- mock `sendMessage` throws. Asserts `result.isError === true`.
3. `"returns isError:true when getStatus throws BoundNotRunningError"` -- mock `getStatus` throws. Asserts `result.isError === true`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/handler.test.ts
```

---

### mcp-server.AC5.2: `bound_chat` returns `isError:true` when agent loop exceeds 5 minutes

**Verification:** Automated (unit)

**Test file:** `packages/mcp-server/src/__tests__/handler.test.ts`

**Description:** The test `"mcp-server.AC5.2: returns isError on 5-minute poll timeout"` mocks `Date.now` to simulate time advancing past the 5-minute threshold after one poll iteration. The mock `getStatus` always returns `{ active: true }`. Asserts the handler returns `{ isError: true }` with a message containing `"5 minutes"`.

**Run:**
```bash
bun test packages/mcp-server/src/__tests__/handler.test.ts
```

---

## AC6: Bound server additions

### mcp-server.AC6.1: `POST /api/mcp/threads` returns 201 with `{ thread_id: string }`

**Verification:** Automated (integration)

**Test file:** `packages/web/src/server/__tests__/mcp.integration.test.ts`

**Description:** The test `"mcp-server.AC6.1: returns 201 with thread_id"` sends `POST http://localhost/api/mcp/threads` to an in-memory Hono app. Asserts `res.status === 201`, response body has a `thread_id` property of type `string` with non-zero length.

**Run:**
```bash
bun test packages/web/src/server/__tests__/mcp.integration.test.ts
```

---

### mcp-server.AC6.2: Thread has `user_id=deterministicUUID(BOUND_NAMESPACE, "mcp")` and `interface="mcp"`

**Verification:** Automated (integration)

**Test file:** `packages/web/src/server/__tests__/mcp.integration.test.ts`

**Description:** The test `"mcp-server.AC6.2: thread has correct user_id and interface"` creates a thread via the API, then queries the SQLite database directly to verify the thread row has `user_id === deterministicUUID(BOUND_NAMESPACE, "mcp")` and `interface === "mcp"`.

**Run:**
```bash
bun test packages/web/src/server/__tests__/mcp.integration.test.ts
```

---

### mcp-server.AC6.3: `mcp` system user exists in DB after startup

**Verification:** Automated (unit)

**Test file:** `packages/cli/src/__tests__/mcp-user.test.ts`

**Description:** The test `"mcp-server.AC6.3: creates mcp user row on first call"` creates an in-memory database with the full schema applied, calls `ensureMcpUser(db, siteId)`, then queries the `users` table. Asserts a row exists with `id === deterministicUUID(BOUND_NAMESPACE, "mcp")`, `display_name === "mcp"`, and `deleted === 0`.

**Run:**
```bash
bun test packages/cli/src/__tests__/mcp-user.test.ts
```

---

### mcp-server.AC6.4: `mcp` user provisioning is idempotent

**Verification:** Automated (unit)

**Test file:** `packages/cli/src/__tests__/mcp-user.test.ts`

**Description:** The test `"mcp-server.AC6.4: idempotent -- second call does not throw or create duplicate"` calls `ensureMcpUser(db, siteId)` twice on the same database. Asserts no error is thrown and exactly one row exists in the `users` table with the mcp user ID.

**Run:**
```bash
bun test packages/cli/src/__tests__/mcp-user.test.ts
```

---

### mcp-server.AC6.5: `POST /api/mcp/threads` rejects non-localhost Host headers

**Verification:** Automated (integration)

**Test file:** `packages/web/src/server/__tests__/mcp.integration.test.ts`

**Description:** The test `"mcp-server.AC6.5: rejects non-localhost Host header with 400"` sends a `POST` request to `/api/mcp/threads` with `Host: evil.example.com`. Asserts the response status is `400`. This validates that the existing global DNS-rebinding middleware in the Hono app covers the new MCP route.

**Run:**
```bash
bun test packages/web/src/server/__tests__/mcp.integration.test.ts
```

---

## Test Execution Summary

### Run all automated tests for this feature

```bash
# Phase 1 tests (server-side)
bun test packages/cli/src/__tests__/mcp-user.test.ts
bun test packages/web/src/server/__tests__/mcp.integration.test.ts

# Phase 2-3 tests (mcp-server package)
bun test packages/mcp-server

# Full regression
bun test --recursive
```

### Automated test count by file

| Test File | Test Count | AC Coverage |
|---|---|---|
| `packages/cli/src/__tests__/mcp-user.test.ts` | 2 | AC6.3, AC6.4 |
| `packages/web/src/server/__tests__/mcp.integration.test.ts` | 3 | AC6.1, AC6.2, AC4.2, AC6.5 |
| `packages/mcp-server/src/__tests__/bound-client.test.ts` | 13 | Supporting (BoundClient methods, error handling) |
| `packages/mcp-server/src/__tests__/handler.test.ts` | 8 | AC4.1, AC4.3, AC4.4, AC5.1, AC5.2 |
| `packages/mcp-server/src/__tests__/server.test.ts` | 5 | AC2.1, AC2.2, AC3.1, AC3.2, AC3.3 |
| **Total** | **31** | **17 AC mappings across 15 ACs** |

### Human verification count

| AC ID | Justification |
|---|---|
| AC1.1 | Build-system operation; depends on host environment |
| AC1.2 | Cross-process stdio verification; requires compiled binary |
| **Total** | **2 human verifications** |
