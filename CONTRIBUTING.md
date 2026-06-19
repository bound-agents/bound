# Contributing to Bound

Last verified: 2026-05-25

Thanks for your interest in contributing! This document is the developer-facing companion to [README.md](README.md) — if you're running `bun test` and touching SQL, this is the file you want.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend for end-to-end testing (Ollama works offline; Bedrock/OpenAI-compatible also supported)
- For Playwright e2e: system dependencies per `bun run test:e2e` output

## Setup

```bash
git clone https://github.com/bound-agents/bound.git
cd bound
bun install
```

First run (pick whichever LLM backend you have credentials for):

```bash
bun run packages/cli/src/bound.ts init --ollama
bun run packages/cli/src/bound.ts start
```

Open http://localhost:3001 for the web UI. The sync protocol listens on 3000.

## Commands

```bash
# Tests
bun test --recursive                                 # All packages
bun test packages/core                               # One package
bun test packages/core/src/__tests__/schema.test.ts  # Single file
bun test --test-name-pattern "pattern"               # Filter by name
bun run test:e2e                                     # Playwright e2e

# Lint / format (biome)
bun run lint
bun run lint:fix

# Typecheck (per-package — no composite mode at root)
tsc -p packages/shared --noEmit
bun run typecheck                                    # All packages sequentially

# Build (produces binaries in dist/)
bun run build
```

## Repo Layout

12 packages in a Bun workspace monorepo. Detailed dependency graph and per-package responsibilities live in [docs/design/architecture.md](docs/design/architecture.md).

Top-level:

```
packages/
  shared/       Types, events, Result<T,E>, Zod config schemas, HLC
  core/         SQLite schema, DI container, change-log outbox, relay CRUD
  sync/         Ed25519 WS sync, XChaCha20 encryption, LWW/append reducers
  sandbox/      Virtual filesystem (InMemoryFs/ClusterFs), command framework
  llm/          Driver shims (Bedrock, OpenAI-compatible) over Vercel AI SDK
  agent/        Agent loop, 8-stage context pipeline, commands, scheduler, MCP bridge
  platforms/    MCP-based platform connectors (Discord), connector handles, connector tool
  web/          Hono API + Svelte 5 SPA
  client/       BoundClient (HTTP + WS) for external consumers
  mcp-server/   Standalone stdio MCP server (bound-mcp)
  less/         Terminal coding agent client (boundless)
  cli/          bound/boundctl/bound-mcp/boundless binaries
```

For design rationale per package, see `docs/design/` — seven topic files covering core infrastructure, sync protocol, agent system, sandboxing, inference backends, web+platforms, and the top-level architecture overview.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript 6.x (strict, ES2022, bundler module resolution)
- **Database**: `bun:sqlite` in WAL mode with STRICT tables
- **DI**: tsyringe + reflect-metadata (decorator-based singletons, setter injection)
- **Validation**: Zod v4
- **Web**: Hono (server) + Svelte 5 (client, Vite build)
- **Linting**: Biome (tabs, double quotes, semicolons, 100-char lines)
- **Testing**: `bun:test`, Playwright for e2e, `fast-check` for property-based tests (currently used only for the R-VC25 stable-prefix purity properties in `packages/agent/src/stable-prefix/__tests__/`)

## Testing Conventions

- **Unit tests**: `*.test.ts` — alongside the code they cover (or under `__tests__/`)
- **Integration tests**: `*.integration.test.ts`
- **Runner**: `bun:test` (`describe` / `it` / `expect`)
- **Coverage targets**: core/agent/sync/platforms 80%, web/cli 60%
- **Test DBs**: prefer an in-memory DB (`new Database(":memory:")`) for unit tests that pass the `db` object directly and never reopen from a path — it sidesteps Windows `EBUSY` when a recursive `rmSync` races the still-closing SQLite WAL/SHM handle. When a file-backed DB is genuinely needed, build the path under `os.tmpdir()` (e.g. `join(tmpdir(), \`x-${randomBytes(4).toString("hex")}.db\`)`), never a hardcoded `/tmp/...` (which is not portable to Windows runners), and clean up with `rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`.
- **Multi-instance sync tests**: bind servers to an OS-assigned ephemeral port (`Bun.serve({ port: 0 })`, then read `server.port` back) rather than picking a random port and hoping it's free. A caller-chosen port races other clusters in the same run and — especially on Windows, where a just-closed listener lingers in `TIME_WAIT` — intermittently throws `EADDRINUSE` in `beforeEach`. The OS only hands out free ports, so collisions are impossible. Still give each cluster a unique `testRunId` to keep its on-disk DB/keypair paths from colliding. See `createWsTestCluster` in `packages/sync/src/__tests__/test-harness.ts`.
- **Mock LLM**: implement the `LLMBackend` interface with `setTextResponse()` / `setToolThenTextResponse()` — see existing tests in `packages/agent`.
- **Typecheck in tests**: the typecheck config excludes `__tests__/` directories, so missing fields on test-only fixtures can be silent. Mirror production shapes precisely when constructing `StreamChunk.done.usage` etc.

**Behavioral probes.** Tests under `packages/agent/src/__tests__/probes/` exercise real LLM drivers and consume inference budget. They are gated behind `BOUND_RUN_BEHAVIORAL_PROBE=1` and run on a separate cadence (weekly via the behavioral-probe workflow) rather than per-PR. Per-PR CI skips them. See `docs/test-plans/2026-05-22-volatile-context-probe.md` for the §8.6 procedure and operator workflow setup instructions.

## Critical Invariants

These rules exist because violating them has historically caused real production incidents (sync loss, SQL injection risk, cache misses, hot loops). The list below is the index — the full explanation, rationale, and mitigation for each lives in [docs/invariants.md](docs/invariants.md). Read the linked section before writing code that touches the subject. They're numbered flat (no category grouping), because the numbers and the old category headings disagreed about order.

1. [Change-log outbox pattern](docs/invariants.md#1-change-log-outbox-pattern) — all writes to synced tables go through `insertRow()` / `updateRow()` / `softDelete()`, never raw SQL.
2. [Soft deletes only](docs/invariants.md#2-soft-deletes-only) — flip `deleted = 0|1` via `softDelete()`; never physically `DELETE` a synced row.
3. [Relay tables are local-only](docs/invariants.md#3-relay-tables-are-local-only) — `relay_outbox` / `relay_inbox` / `relay_cycles` use dedicated CRUD, not the outbox.
4. [Column-name validation](docs/invariants.md#4-column-name-validation) — any interpolated column name passes through `validateColumnName()`; values stay parameterized.
5. [OCC filesystem](docs/invariants.md#5-occ-filesystem) — compare hash-to-hash, persist inside `BEGIN IMMEDIATE`, emit `file:changed` only after commit.
6. [Events after commit](docs/invariants.md#6-events-after-commit) — `file:changed` / `changelog:written` fire after `COMMIT`, never mid-transaction.
7. [Tool-message persistence](docs/invariants.md#7-tool-message-persistence) — persist each tool message before the next LLM call; batching causes context drift.
8. [`bun:sqlite` `.get()` returns `null`](docs/invariants.md#8-empty-reads-return-null-not-undefined) — guard for `null`, not `undefined`, on empty reads.
9. [LLM message roles diverge between layers](docs/invariants.md#9-llm-message-roles-diverge-between-layers) — `MessageRole` (DB) and `LLMMessage.role` (driver) are different unions.
10. [`LLMMessage.content` can be `string | ContentBlock[]`](docs/invariants.md#10-message-content-is-string-or-contentblock-array) — handle both forms or break image/tool-use content.
11. [Model-alias passthrough](docs/invariants.md#11-model-alias-passthrough) — never pass `payload.model` to `backend.chat()` from the relay processor.
12. [Canonical edge relations](docs/invariants.md#12-canonical-edge-relations) — `memory_edges.relation` must be one of the 10 `CANONICAL_RELATIONS`.
13. [Config schemas are closed (strict mode)](docs/invariants.md#13-config-schemas-are-closed-strict-mode) — declare every config field in its Zod schema or the loader rejects the file.
14. [Hub response-kind routing](docs/invariants.md#14-hub-response-kind-routing) — hub-targeted response kinds go into `relay_inbox`, not `executeImmediate()`.
15. [Platform intake affinity](docs/invariants.md#15-platform-intake-affinity) — `intake` relay with a `platform` field routes to the host with that connector.
16. [Extended-thinking routing](docs/invariants.md#16-extended-thinking-routing) — `thinking` / `effort` fold into `reasoningConfig`; mirror new fields in `inferenceRequestPayloadSchema`.
17. [Shared-config → router hand-off](docs/invariants.md#17-shared-config-to-router-hand-off) — new per-backend fields must be copied in `toRouterConfig()` or they never reach the router.
18. [`ProcessPayload.message_id` must reference a real `messages` row](docs/invariants.md#18-forwarded-message_id-must-reference-a-real-messages-row) — forward a real id; notifications are the trap (use `resolveDelegationMessageId()`).
19. [`role: "system"` is forbidden in the `messages` table](docs/invariants.md#19-the-system-role-is-forbidden-in-the-messages-table) — use `role: "developer"` for injected system context.
20. [No foreign key constraints on synced tables](docs/invariants.md#20-no-foreign-key-constraints-on-synced-tables) — replay inserts rows out of order; FK clauses would fail intermittently.
21. [Client-session affinity wins over model-based delegation](docs/invariants.md#21-client-session-affinity-wins-over-model-based-delegation) — a live boundless / `BoundClient` session pins client-tool execution to its host.

## Common Gotchas

Accumulated the hard way — check here before writing a bug report. The list below is the index; each links to the full writeup in [docs/gotchas.md](docs/gotchas.md).

- [AI SDK `usage.inputTokens` is the summed total, not non-cached input](docs/gotchas.md#ai-sdk-inputtokens-is-the-summed-total-not-non-cached-input)
- [`global.fetch` pollution in tests](docs/gotchas.md#globalfetch-pollution-in-tests)
- [TUI frame-capture tests are sensitive to ambient stdout state](docs/gotchas.md#tui-frame-capture-tests-and-ambient-stdout-state)
- [SQLite `datetime()` vs ISO 8601](docs/gotchas.md#sqlite-datetime-vs-iso-8601)
- [Zod v4 `z.record` requires two arguments](docs/gotchas.md#zod-v4-zrecord-needs-two-arguments)
- [Typecheck is per-package](docs/gotchas.md#typecheck-is-per-package)
- [`bun test packages/cli` prints init stdout — check the exit code](docs/gotchas.md#bun-test-cli-prints-init-stdout)
- [Mixed positional + flag arg parsing](docs/gotchas.md#mixed-positional-and-flag-arg-parsing)
- [`loopContextStorage` (AsyncLocalStorage) scope](docs/gotchas.md#loopcontextstorage-scope-asynclocalstorage)
- [`bound-mcp` polling can return stale turns](docs/gotchas.md#bound-mcp-polling-can-return-stale-turns)
- [bound CLI config and data dirs](docs/gotchas.md#bound-cli-config-and-data-dirs)
- [Stale binaries](docs/gotchas.md#stale-binaries)
- [Universal 256 KiB tool-result cap](docs/gotchas.md#universal-256-kib-tool-result-cap)
- [Oversized bash output offloads to a file](docs/gotchas.md#oversized-bash-output-offloads-to-a-file)
- [`query` accepts PRAGMAs](docs/gotchas.md#query-accepts-pragmas)
- [Thread `interface` tag](docs/gotchas.md#thread-interface-tag)
- [Cross-provider `tool_use` portability (id and name)](docs/gotchas.md#cross-provider-tool_use-portability-id-and-name)
- [`thinking`-signature portability](docs/gotchas.md#thinking-signature-portability)
- [`boundless_bash` runs inside a filesystem sandbox by default](docs/gotchas.md#boundless_bash-runs-inside-a-filesystem-sandbox-by-default)

## Recurring Checklists

### Adding a new synced table

1. Declare the CREATE TABLE in `packages/core/src/schema.ts` (or `metrics-schema.ts` for observability tables) as a STRICT table with `deleted INTEGER NOT NULL DEFAULT 0` (if LWW) and `modified_at TEXT NOT NULL`.
2. Add the name to `SyncedTableName` and `TABLE_REDUCER_MAP` in `packages/shared/src/types.ts`.
3. If its primary key is not `id`, add an entry to `TABLE_PK_COLUMN` in `packages/core/src/change-log.ts`.
4. Decide the reducer (`lww` or `append-only`) — wiring lives in `packages/sync/src/reducers.ts`, keyed off `TABLE_REDUCER_MAP`.
5. Use only `insertRow` / `updateRow` / `softDelete` for writes — never raw SQL.
6. Add migration logic if upgrading existing deployments (see `metrics-schema.ts` for the `turns` INTEGER→TEXT id migration as a template).
7. Update `docs/design/sync-protocol.md` if the reducer behavior is non-obvious.
8. Add the table to `SYNCED_TABLE_NAMES` in `packages/core/src/schema-introspection.ts` so `getSyncedTableSchemas()` exposes its columns in the agent's stable-prefix `## Database Schema` block. Tables not listed there are invisible to the `query` command's schema hint.
9. Add the table to `SNAPSHOT_TABLE_ORDER` in `packages/sync/src/ws-transport.ts` — this list controls the order in which tables are seeded to new spoke nodes joining the cluster. Omission here causes silent data loss on new spokes (that table's data will never appear in snapshots).

### Adding a config field

1. Add the field to the Zod schema in `packages/shared/src/config-schemas.ts` (remember `.strict()` mode means you MUST declare it or startup breaks).
2. If the field propagates to the router, thread it through `toRouterConfig()` in `packages/cli/src/commands/start/inference.ts`.
3. If it forwards over the relay, mirror it in `inferenceRequestPayloadSchema`.
4. If it's per-backend, consider whether `BackendConfig`, `ModelResolution`, agent-loop, and relay-processor all need to know.
5. Update the config example in `README.md` if the field is user-facing.

### Adding an agent tool

1. Create `packages/agent/src/tools/<name>.ts` exporting a `create<Name>Tool(ctx: ToolContext): RegisteredTool` factory function.
2. Define a `ToolDefinition` with JSON schema parameters (flat params, proper types). The LLM receives structured JSON — no string parsing needed.
3. Implement the `execute` handler: `(input: Record<string, unknown>) => Promise<BuiltInToolResult>`. Access `ctx.db`, `ctx.siteId`, `ctx.eventBus`, etc. via the closure.
4. Register the factory in `packages/agent/src/tools/index.ts` by adding it to the `createAgentTools()` array.
5. Add unit tests under `packages/agent/src/tools/__tests__/` — use real temp SQLite DBs, minimal `ToolContext` stubs.
6. For grouped tools (multiple operations), use an `action` enum parameter to dispatch (see memory, skill tools).
7. You don't need a per-tool byte cap for correctness — a universal 256 KiB backstop runs at the dispatch return (see `capToolResultContent` in the Common Gotchas list). But adding a per-tool cap with a domain-specific truncation message (like `read`'s line-aware cap or `query`'s row-aware cap) gives the LLM a more actionable error than the generic middle-truncation marker, so prefer it for tools whose outputs commonly approach the cap.

## PR Expectations

- `bun run lint` clean (or `bun run lint:fix` first)
- `bun run typecheck` clean across all packages
- Relevant tests added or updated
- For user-visible changes: update `README.md` and/or `docs/design/*`
- For new invariants or gotchas: add them to [docs/invariants.md](docs/invariants.md) / [docs/gotchas.md](docs/gotchas.md) and add an index line here

See the git log for commit message style — concise, conventional-commits-ish (`feat(web):`, `fix(llm):`, etc.), present tense.

## Further Reading

- [README.md](README.md) — user-facing overview and quickstart
- [docs/invariants.md](docs/invariants.md) — full explanations of the critical invariants indexed above
- [docs/gotchas.md](docs/gotchas.md) — full writeups of the common gotchas indexed above
- [docs/design/architecture.md](docs/design/architecture.md) — package dep graph and data flow
- [docs/design/core-infrastructure.md](docs/design/core-infrastructure.md) — schema, DI, config, outbox internals
- [docs/design/sync-protocol.md](docs/design/sync-protocol.md) — Ed25519, HLC, reducers, relay
- [docs/design/agent-system.md](docs/design/agent-system.md) — agent loop, context pipeline, native tools
- [docs/design/sandbox.md](docs/design/sandbox.md) — VFS, command framework, boundless filesystem sandbox
- [docs/design/inference-backends.md](docs/design/inference-backends.md) — LLM driver shims, model routing
- [docs/design/web-and-discord.md](docs/design/web-and-discord.md) — HTTP API, WS protocol, platform connectors
- [docs/cli-operations.md](docs/cli-operations.md) — operator-facing CLI reference
- [docs/config.md](docs/config.md) — per-field reference for every config file
