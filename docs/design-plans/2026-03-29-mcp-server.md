# MCP Server Design

## Summary

This design adds first-class [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) support to bound by shipping a new standalone binary, `bound-mcp`, that lets any MCP host (such as Claude Desktop or another AI assistant) talk to a running bound agent through a single `bound_chat` tool. The binary communicates with the MCP host over stdio using the standard JSON-RPC transport and communicates with the bound agent over its existing HTTP API. No changes to the core agent loop or sync machinery are required.

The approach is deliberately minimal: the bound agent gains one new HTTP endpoint (`POST /api/mcp/threads`) and a fixed system user (`mcp`) that is auto-provisioned at startup so that threads created through this path are clearly attributed. The `bound-mcp` binary is a thin client — it creates or reuses a thread, posts the incoming message, polls the thread's status endpoint until the agent finishes, and returns the assistant's final reply. Error conditions (unreachable agent, poll timeout) surface as MCP-level tool errors so the calling host can handle them gracefully.

## Definition of Done

- A new `packages/mcp-server` package compiles to a standalone binary (`bound-mcp`) using `bun build --compile`
- It implements the MCP stdio transport protocol and exposes a `bound_chat` tool (takes `message` string + optional `thread_id`)
- It connects to a running bound agent over HTTP; if the agent is unreachable, all tools return a descriptive error
- Sending a message creates/reuses a thread owned by an auto-provisioned `mcp` system user, triggers the agent loop, then returns the agent's final assistant message as a text content block
- The bound agent gains a `POST /api/mcp/threads` endpoint to support thread creation with the mcp user, and auto-provisions the `mcp` user at startup

## Acceptance Criteria

### mcp-server.AC1: Binary compiles and runs as an MCP server
- **mcp-server.AC1.1 Success:** `bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp` exits 0 and produces the binary
- **mcp-server.AC1.2 Success:** The binary responds to an MCP `initialize` request on stdio and lists `bound_chat` in the `tools/list` response

### mcp-server.AC2: `bound_chat` tool interface
- **mcp-server.AC2.1 Success:** `bound_chat` accepts `message` (required string) and `thread_id` (optional string)
- **mcp-server.AC2.2 Failure:** MCP framework rejects a `bound_chat` call missing the required `message` parameter with a protocol error

### mcp-server.AC3: Bound agent URL configuration
- **mcp-server.AC3.1 Success:** `--url <url>` CLI arg sets the bound agent base URL
- **mcp-server.AC3.2 Success:** `BOUND_URL` env var sets the base URL when `--url` is absent
- **mcp-server.AC3.3 Success:** Defaults to `http://localhost:3000` when neither is provided

### mcp-server.AC4: Thread and message flow
- **mcp-server.AC4.1 Success:** `bound_chat` with no `thread_id` creates a new thread via `POST /api/mcp/threads`
- **mcp-server.AC4.2 Success:** Created thread has `interface = "mcp"` and `user_id = deterministicUUID(BOUND_NAMESPACE, "mcp")`
- **mcp-server.AC4.3 Success:** `bound_chat` with a supplied `thread_id` sends to that thread without creating a new one
- **mcp-server.AC4.4 Success:** `bound_chat` returns the last `role: "assistant"` message as a `{ type: "text" }` content block after the agent loop completes

### mcp-server.AC5: Error handling
- **mcp-server.AC5.1 Failure:** `bound_chat` returns `isError: true` with a message identifying the configured URL when the agent is unreachable
- **mcp-server.AC5.2 Failure:** `bound_chat` returns `isError: true` when the agent loop does not complete within 5 minutes

### mcp-server.AC6: Bound server additions
- **mcp-server.AC6.1 Success:** `POST /api/mcp/threads` returns 201 with `{ thread_id: string }`
- **mcp-server.AC6.2 Success:** Thread created by `POST /api/mcp/threads` has `user_id = deterministicUUID(BOUND_NAMESPACE, "mcp")` and `interface = "mcp"`
- **mcp-server.AC6.3 Success:** The `mcp` system user exists in the DB after bound startup with no `allowlist.json` entry
- **mcp-server.AC6.4 Success:** `mcp` user provisioning is idempotent — repeated restarts do not create duplicate rows or error
- **mcp-server.AC6.5 Failure:** `POST /api/mcp/threads` rejects requests with non-localhost `Host` headers (DNS-rebinding protection)

## Glossary

- **MCP (Model Context Protocol)**: An open protocol that lets AI hosts (such as Claude Desktop) discover and call tools exposed by external servers. Servers advertise tools over a JSON-RPC transport; the host invokes them by name with typed arguments.
- **stdio transport**: The MCP transport variant in which the server process communicates with its host over standard input/output rather than a network socket. The server must never write to stdout for any purpose other than JSON-RPC messages.
- **JSON-RPC**: A lightweight remote-procedure-call protocol encoded as JSON. MCP uses it to frame `initialize`, `tools/list`, and `tools/call` messages on the stdio stream.
- **`@modelcontextprotocol/sdk`**: The official TypeScript SDK for building MCP servers. Provides `McpServer`, `StdioServerTransport`, and Zod-based tool-registration helpers.
- **`bound_chat` tool**: The single MCP tool exposed by `bound-mcp`. It accepts a message string and an optional thread ID, drives the bound agent loop, and returns the agent's reply.
- **`bun build --compile`**: A Bun feature that bundles a TypeScript entrypoint and the Bun runtime into a single self-contained native binary with no external dependencies.
- **Hono**: The HTTP framework used by bound's web server. Routes are defined in factory functions and composed with `app.route()`.
- **`deterministicUUID`**: A helper in `@bound/shared` that derives a UUID v5 from a namespace and a name string, ensuring the same input always produces the same UUID. Used here to give the `mcp` system user a stable, reproducible identity.
- **`BOUND_NAMESPACE`**: The UUID v5 namespace constant used across the codebase when deriving deterministic IDs for system-level identities.
- **Change-log outbox (`insertRow` / `updateRow`)**: The required write pattern for synced tables in bound. Every write is wrapped together with a changelog entry in a single transaction so that the sync layer can replicate it to other nodes.
- **Idempotent provisioning**: A startup operation that is safe to run on every restart — it creates a resource the first time and does nothing (without error) on subsequent runs.
- **DNS-rebinding protection**: A Host-header check on all unauthenticated routes that rejects requests whose `Host` value is not `localhost` (or a whitelisted origin), preventing a malicious web page from calling the local HTTP server.
- **Thread interface field**: A discriminator column on the `threads` table (values such as `"web"`, `"discord"`, `"mcp"`) that identifies which entry point created the thread.
- **Poll / polling loop**: The technique used by `bound_chat` to wait for the agent to finish: repeatedly call `GET /api/threads/:id/status` every 500 ms until `active === false` or the timeout elapses.
- **`BoundClient`**: A new class in `packages/mcp-server` that encapsulates all HTTP calls to the bound agent and raises a `BoundNotRunningError` on connection failures.
- **`BoundNotRunningError`**: A typed error thrown by `BoundClient` when the bound agent is unreachable or returns a non-2xx response, which `server.ts` converts into an MCP `isError` response.
- **`isError`**: An MCP tool-result field. When `true`, the host treats the content as an error description rather than a successful result.
- **Workspace (Bun monorepo)**: A monorepo layout where each subdirectory under `packages/` is a separate npm-style package linked together by a root `package.json` `workspaces` array.

## Architecture

The MCP bridge has two parts: server-side additions to `packages/cli` and `packages/web` that expose an `mcp`-attributed user and a dedicated thread-creation endpoint, and a new `packages/mcp-server` standalone package that implements the MCP stdio protocol.

**Server-side additions (`packages/cli`, `packages/web`):**

An `mcp` system user is auto-provisioned at startup in `packages/cli/src/commands/start.ts` using `deterministicUUID(BOUND_NAMESPACE, "mcp")`. This runs after the allowlist user seeding loop and is idempotent (no-op if the user already exists). The user is never in `allowlist.json`; it is a fixed system identity.

A new `POST /api/mcp/threads` Hono route creates threads with `interface: "mcp"` and `user_id` set to the mcp user's deterministic ID. The route is mounted at `/api/mcp` in `packages/web/src/server/index.ts`; the existing global `app.use("*", ...)` DNS-rebinding middleware covers it automatically — no exemption needed.

**Client-side (`packages/mcp-server`):**

A standalone Bun binary (`bound-mcp`) built with `bun build --compile`. It connects to the MCP host via stdio using `@modelcontextprotocol/sdk`'s `StdioServerTransport`, and talks to the bound agent over HTTP via a `BoundClient` class.

The `bound_chat` tool flow:
1. If no `thread_id` supplied → `POST /api/mcp/threads` to create a new thread
2. `POST /api/threads/:id/messages` with the user's message
3. Poll `GET /api/threads/:id/status` every 500 ms until `active === false`, max 5 minutes
4. `GET /api/threads/:id/messages` → return the last `role: "assistant"` message as a `{ type: "text" }` content block

If the bound agent is unreachable at any step, the tool returns `{ isError: true, content: [{ type: "text", text: "Bound agent is not running at <url>." }] }`.

**Configuration:** Bound agent URL is read from `--url <url>` CLI arg or `BOUND_URL` env var, defaulting to `http://localhost:3000`.

All logging in `server.ts` uses `console.error` (stderr); `console.log` (stdout) is never used, as it would corrupt the JSON-RPC stream.

## Existing Patterns

**User provisioning** follows the pattern in `packages/cli/src/commands/start.ts:111–151`: existence check, then `insertRow` or `updateRow` with `deterministicUUID(BOUND_NAMESPACE, name)` and `appContext.siteId`.

**Route structure** follows `packages/web/src/server/routes/threads.ts`: a Hono app returned from a `createXxxRoutes(db)` factory, using `insertRow()` for changelog-outbox compliance and `getSiteId(db)` for the site ID inline.

**Route mounting** follows `packages/web/src/server/index.ts:77–82`: route factories registered in `packages/web/src/server/routes/index.ts` via `registerRoutes()`, then mounted with `app.route("/api/mcp", routes.mcp)`.

**Binary compilation** follows `scripts/build.ts`: `bun build --compile <entrypoint> --outfile dist/<name>`. The new `bound-mcp` binary and the previously missing `boundctl` binary are both added here.

`packages/mcp-server`'s `BoundClient` is new — no existing HTTP client abstraction exists in the codebase. It uses native `fetch` with explicit connection-error handling.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Bound server additions

**Goal:** Auto-provision the `mcp` system user at startup and expose `POST /api/mcp/threads`.

**Components:**
- `packages/cli/src/commands/start.ts` — add idempotent mcp user upsert after the allowlist seeding block (~line 151), using `deterministicUUID(BOUND_NAMESPACE, "mcp")` and `insertRow`/`updateRow`
- `packages/web/src/server/routes/mcp.ts` — new file; `createMcpRoutes(db)` factory exposing `POST /api/mcp/threads`; creates thread with `user_id = deterministicUUID(BOUND_NAMESPACE, "mcp")`, `interface: "mcp"`, color cycling, timestamps; returns `{ thread_id }`
- `packages/web/src/server/routes/index.ts` — add mcp route factory to `registerRoutes()`
- `packages/web/src/server/index.ts` — mount at `app.route("/api/mcp", routes.mcp)`

**Dependencies:** None (modifies existing packages)

**Done when:** mcp user row exists in DB after startup with the expected deterministic ID (idempotent across restarts); `POST /api/mcp/threads` returns 201 with `thread_id`; resulting thread has `interface = "mcp"` and `user_id = deterministicUUID(BOUND_NAMESPACE, "mcp")`. Tests cover: mcp user provisioning (idempotent), thread creation (correct `user_id` and `interface`), 400 on bad request. Covers `mcp-server.AC2`, `mcp-server.AC3`.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: `packages/mcp-server` scaffold and BoundClient

**Goal:** Stand up the new package and implement the HTTP client that wraps the bound agent API.

**Components:**
- `packages/mcp-server/package.json` — `name: @bound/mcp-server`, `bin: { "bound-mcp": "src/server.ts" }`, dependencies: `@bound/shared` (workspace), `@modelcontextprotocol/sdk`
- `packages/mcp-server/tsconfig.json` — extends monorepo base, `moduleResolution: bundler`
- Monorepo root `package.json` — add `packages/mcp-server` to `workspaces`
- `packages/mcp-server/src/bound-client.ts` — `BoundClient` class with `createMcpThread()`, `sendMessage(id, text)`, `getStatus(id)`, `getMessages(id)`; throws `BoundNotRunningError` on connection failure or non-2xx liveness response

**Dependencies:** Phase 1 (bound agent must have the `/api/mcp/threads` endpoint)

**Done when:** `bun install` succeeds for the new package; `BoundClient` unit tests pass with mocked `fetch` covering all four methods and `BoundNotRunningError` on connection failure. Covers `mcp-server.AC1`, `mcp-server.AC4`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: MCP stdio server and `bound_chat` tool

**Goal:** Implement the `bound_chat` MCP tool with full polling loop and error handling.

**Components:**
- `packages/mcp-server/src/server.ts` — main entrypoint; parses `--url`/`BOUND_URL` config; creates `McpServer({ name: "bound-mcp", version: "0.0.1" })`; registers `bound_chat` tool with Zod input schema (`message: z.string()`, `thread_id: z.string().optional()`); implements polling loop (500 ms interval, 5 min timeout); connects `StdioServerTransport`; all logging via `console.error`

**Dependencies:** Phase 2 (BoundClient)

**Done when:** `bound_chat` creates a new thread when no `thread_id` is supplied; reuses a supplied `thread_id`; returns last assistant message as `{ type: "text" }` content block; returns `{ isError: true }` when bound is unreachable; returns `{ isError: true }` on 5-minute poll timeout. Tests use a mock HTTP server or mock `BoundClient`. Covers `mcp-server.AC1`, `mcp-server.AC2`, `mcp-server.AC3`, `mcp-server.AC4`, `mcp-server.AC5`.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Build script updates

**Goal:** Compile all three binaries from `scripts/build.ts`.

**Components:**
- `scripts/build.ts` — add `bun build --compile packages/cli/src/boundctl.ts --outfile dist/boundctl` and `bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp` steps; update the summary block to report sizes for all three binaries

**Dependencies:** Phase 3 (mcp-server entrypoint must exist)

**Done when:** `bun run build` produces `dist/bound`, `dist/boundctl`, and `dist/bound-mcp`; all three sizes are reported in build output.
<!-- END_PHASE_4 -->
