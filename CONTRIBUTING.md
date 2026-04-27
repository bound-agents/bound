# Contributing to Bound

Last verified: 2026-04-26

Thanks for your interest in contributing! This document is the developer-facing companion to [README.md](README.md) — if you're running `bun test` and touching SQL, this is the file you want.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend for end-to-end testing (Ollama works offline; Bedrock/Anthropic/OpenAI-compatible also supported)
- For Playwright e2e: system dependencies per `bun run test:e2e` output

## Setup

```bash
git clone https://github.com/karashiiro/bound.git
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
  platforms/    PlatformConnector framework (Discord, webhook)
  web/          Hono API + Svelte 5 SPA
  client/       BoundClient (HTTP + WS) for external consumers
  mcp-server/   Standalone stdio MCP server (bound-mcp)
  less/         Terminal coding agent client (boundless)
  cli/          bound/boundctl/bound-mcp/boundless binaries
```

For design rationale per package, see `docs/design/` — six topic files covering core infrastructure, sync protocol, agent system, sandbox+LLM, web+platforms, and the top-level architecture overview.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript 6.x (strict, ES2022, bundler module resolution)
- **Database**: `bun:sqlite` in WAL mode with STRICT tables
- **DI**: tsyringe + reflect-metadata (decorator-based singletons, setter injection)
- **Validation**: Zod v4
- **Web**: Hono (server) + Svelte 5 (client, Vite build)
- **Linting**: Biome (tabs, double quotes, semicolons, 100-char lines)
- **Testing**: `bun:test`, Playwright for e2e

## Testing Conventions

- **Unit tests**: `*.test.ts` — alongside the code they cover (or under `__tests__/`)
- **Integration tests**: `*.integration.test.ts`
- **Runner**: `bun:test` (`describe` / `it` / `expect`)
- **Coverage targets**: core/agent/sync/platforms 80%, web/cli 60%
- **Test DBs**: use temp paths with `randomBytes(4).toString("hex")` to avoid collisions
- **Multi-instance sync tests**: use random ports AND a unique `testRunId` per test. Without both, you'll hit `EADDRINUSE` or cross-test state bleed.
- **Mock LLM**: implement the `LLMBackend` interface with `setTextResponse()` / `setToolThenTextResponse()` — see existing tests in `packages/agent`.
- **Typecheck in tests**: the typecheck config excludes `__tests__/` directories, so missing fields on test-only fixtures can be silent. Mirror production shapes precisely when constructing `StreamChunk.done.usage` etc.

## Critical Invariants

These rules exist because violating them has historically caused real production incidents (sync loss, SQL injection risk, cache misses, hot loops). Read each one before writing code that touches the subject.

### Database writes

**1. Change-log outbox pattern.** All writes to synced tables MUST use `insertRow()`, `updateRow()`, or `softDelete()` from `@bound/core` (`packages/core/src/change-log.ts`). Never write directly to a synced table with raw SQL. Synced tables are:

```
users, threads, messages, semantic_memory, tasks, files, hosts,
overlay_index, cluster_config, advisories, skills, memory_edges, turns
```

The source-of-truth type is `SyncedTableName` in `packages/shared/src/types.ts`. Writes bypassing the outbox never generate a `change_log` entry, so other hosts never learn about them.

**2. Soft deletes only.** Synced tables use a `deleted = 0|1` column. Never physically `DELETE` rows — use `softDelete()`.

**3. Relay tables are local-only.** `relay_outbox`, `relay_inbox`, `relay_cycles` do NOT use the change-log outbox. Use the dedicated CRUD helpers (`writeOutbox`, `insertInbox`, …) from `@bound/core`.

**4. Column-name validation.** Any SQL that interpolates a column name MUST pass it through `validateColumnName()` (regex `/^[a-z_]+$/`). Values always use parameterized queries. This applies to change-log replay, restore, reducers — anywhere JSON row data could drive column selection.

### Consistency and events

**5. OCC filesystem.** Compare hash-to-hash (never hash vs raw content). Persist inside `BEGIN IMMEDIATE`. Emit `file:changed` events AFTER the commit, never during.

**6. Events after commit.** `file:changed`, `changelog:written`, and similar events must fire AFTER `db.exec("COMMIT")`. Emitting during the transaction can cause listeners to observe uncommitted state.

**7. Tool-message persistence.** Tool messages must be persisted immediately after each tool execution, before the next LLM call. Batching these persists has caused context drift and duplicate tool calls.

### Types and shapes

**8. `bun:sqlite .get()` returns `null`** (not `undefined`) when no row is found. Guard accordingly.

**9. LLM message roles diverge between layers.** Two distinct types:
- `MessageRole` in `@bound/shared` (DB + event bus): `user | assistant | system | developer | alert | tool_call | tool_result | purge`
- `LLMMessage.role` in `@bound/llm` (driver input): `user | assistant | system | tool_call | tool_result | developer | cache`

`developer` carries volatile context and MUST be merged into an adjacent user message by the driver/bridge — wrapped in `<system-context>...</system-context>`. Orphan developer-only inputs are dropped. `cache` is a zero-content marker that tells drivers to place a cache breakpoint on the preceding message.

**10. `LLMMessage.content` can be `string | ContentBlock[]`.** Code handling messages must account for both forms. String-only assumptions break image/tool-use content.

**11. Model-alias passthrough.** Never pass `payload.model` to `backend.chat()` from the relay processor — `payload.model` is a logical alias (e.g., `"opus"`) that differs from the provider-specific identifier (e.g., a Bedrock ARN). The backend already knows its configured model.

**12. Canonical edge relations.** `memory_edges.relation` must be one of 10 values in `CANONICAL_RELATIONS` (from `@bound/core/memory-relations.ts`): `related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes`. SQLite triggers enforce this. Use the `context` TEXT column for bespoke phrasing. `upsertEdge()` validates before write and throws `InvalidRelationError`.

**13. Config schemas are closed (strict mode).** Every schema in `configSchemaMap` in `packages/shared/src/config-schemas.ts` uses `.strict()`, so unknown keys fail parse loudly. `cronSchedulesSchema` is closed-by-shape via `.catchall(cronEntrySchema)`. **When adding a config field, declare it in the Zod schema first** — otherwise the loader rejects the file at startup.

**19. `role: "system"` is forbidden in the `messages` table.** It is reserved for the LLM driver layer (stable-prefix system prompt). Use `role: "developer"` for any injected system-generated context intended for the agent — notifications, wakeup context, interruption notices, retry nudges. Defense in depth: `insertRow()` throws on `role: "system"` at the write boundary, AND both sync reducers in `packages/sync/src/reducers.ts` reject + log on replay so a peer running pre-fix code cannot corrupt this node via changelog push. Historically, `resolveDelegationMessageId()` (notifications) and the client-tool-expiry injector wrote `role: "system"` rows that Stage 2.5 of context assembly silently dropped; the rows existed in the DB but the LLM never saw them. `readMessageMetadata()` / `writeMessageMetadata()` in `@bound/core` provide an opaque JSON property bag on `messages.metadata` for platform-specific state (e.g. Discord delivery-retry tombstones); keys follow a `<platform>_*` namespace convention and the field is invisible to the agent loop and context assembly.

### Inference routing

**14. Hub response-kind routing.** Response kinds (`stream_chunk`, `stream_end`, `result`, `error`, `status_forward`) targeting the hub itself must be inserted into `relay_inbox`, NOT sent through `executeImmediate()`. The executor only handles request kinds.

**15. Platform intake affinity.** `intake` relay with a `platform` field must route to the host with that platform connector, not the host with the best model. Without this, the agent lacks platform tools (e.g., `discord_send_message`).

**16. Extended-thinking routing.** `ChatParams.thinking` is a discriminated union; `ChatParams.effort` rides alongside. The Bedrock driver folds both into `providerOptions.bedrock.reasoningConfig`. Temperature is suppressed whenever `reasoningConfig` is set. Config lives in `model_backends.json` and must be mirrored in `inferenceRequestPayloadSchema` to forward over the relay.

**18. ProcessPayload.message_id must reference a real `messages` row.** When `handleThread()` (spoke side) delegates to a remote host, the `message_id` it forwards via `ProcessPayload` must exist in the `messages` table on the delegating host so the receiving host's `executeProcess()` can resolve it. User-message entries are safe because `enqueueMessage(db, messageId, threadId)` stores the real `messages.id` as `dispatch_queue.message_id`. **Notifications are the trap**: `enqueueNotification()` generates a synthetic UUID — the injected system message gets a fresh UUID in a separate `insertRow()` call. Historically the spoke forwarded the dispatch-queue id, the hub's lookup returned null, and the notification was silently dropped. Use `resolveDelegationMessageId()` in `packages/cli/src/commands/start/server.ts` — it injects notifications AND returns the id to forward. The receiving side no longer hard-rejects on missing rows (it warns and proceeds on thread state alone), but the spoke is still the source of truth and should always forward a real id.

### Shared-config → router hand-off

**17.** `toRouterConfig()` in `packages/cli/src/commands/start/inference.ts` is the single place that translates snake_case `ModelBackendsConfig` into the camelCase `BackendConfig` consumed by `createModelRouter`. Any new per-backend field (e.g., `thinking`, `effort`, `max_output_tokens`) MUST be copied here or it silently never reaches the router. `ModelResolution.local` must also carry the field, and both agent-loop and relay-processor must propagate it.

## Common Gotchas

Accumulated the hard way — check here before writing a bug report.

- **`global.fetch` pollution**: tests that mock `global.fetch` (e.g., Ollama driver tests) MUST save and restore it in `afterAll`, or sync integration tests start failing with mysterious network errors.
- **SQLite `datetime()` vs ISO 8601**: never compare `datetime('now', '-Nh hours')` (which returns `2026-03-28 22:23:33`, space-separated) against JS `toISOString()` timestamps (`2026-03-28T22:23:33.091Z`, `T`-separated). ASCII `T` > ASCII space, so all ISO dates appear "newer". Always compute cutoffs in JS: `new Date(Date.now() - N * 3600_000).toISOString()` and pass as a parameter.
- **Zod v4 `z.record`**: requires two arguments — `z.record(keySchema, valueSchema)`. Single-arg calls don't type-check.
- **Typecheck is per-package**: there is no composite mode at the root. Run `tsc -p packages/<name> --noEmit` or `bun run typecheck` (sequential).
- **`bun test packages/cli`** prints init-test stdout — use the exit code to check success, not `grep`.
- **Mixed positional + flag arg parsing** (in `commands.ts`): the `hasFlags` heuristic detects `key=value` tokens; if your SQL or payload happens to include `=`, it may be misparsed. Use `--query` / `--payload` flags explicitly when values contain `=`.
- **`loopContextStorage` (AsyncLocalStorage)**: exported from `@bound/sandbox`. Commands running inside the agent loop see `threadId` / `taskId` in context automatically. Commands invoked outside (e.g., boundctl) don't.
- **`bound-mcp` polling**: `polaris.bound_chat()` may return a prior turn's content if the new turn hasn't completed by poll time. The DB is ground truth — check the `messages` table directly when debugging.
- **bound CLI config dir**: defaults to `./config` (relative to cwd) and data to `./data`. Use `--config-dir` / `--data-dir` to override, or run from the directory where your config lives.
- **Stale binaries**: `bun run build && cp dist/bound* ~/.local/bin/` is the install step. Running a stale compiled binary in one shell while iterating on source in another has burned us repeatedly. Check `bound --version` if behavior doesn't match source.
- **`query` accepts PRAGMAs**: the agent `query` command allows `SELECT` plus a small read-only PRAGMA allowlist (`table_info`, `index_list`, `foreign_key_list`, `integrity_check`, etc.; see `SAFE_PRAGMA_ALLOWLIST` in `packages/agent/src/commands/query.ts`). The `PRAGMA x = y` assignment form is rejected regardless of name. Anything else (INSERT/UPDATE/DELETE/ATTACH/unknown PRAGMA) errors out. `LIMIT 1000` is still auto-appended to SELECTs but skipped for PRAGMAs.
- **Thread `interface` tag**: POST `/api/threads` accepts an optional body `{ interface?: string }` (default `"web"`, regex `/^[a-z0-9-]+$/i`, ≤32 chars; 400 otherwise). The value lives in `threads.interface` and flows into the agent's volatile context as a platform tag. `isUserFacingInterface()` in `packages/cli/src/commands/start/server.ts` is the single gate for "should the agent see `platform: <name>`?" — currently allows everything except `scheduler` and `mcp`. Adding a new user-facing surface usually needs no code change beyond setting the tag on thread creation; adding a new system-driven surface means extending the filter. `BoundClient.createThread(options?: { interface?: string })` is the client-side counterpart — `boundless` sets `interface: "boundless"`.

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

### Adding an agent command

1. Create `packages/agent/src/commands/<name>.ts` implementing `CommandDefinition` with a required `description` (used for auto-generated orientation + `--help` text).
2. Register it in `packages/agent/src/commands/registry.ts` / the command registry wiring.
3. If it needs filesystem access, type-annotate `ctx.fs?: IFileSystem`.
4. If it's platform-scoped, gate it in the relevant `PlatformConnector`.
5. Add unit tests under `packages/agent/src/commands/__tests__/` — mock `CommandContext` minimally.
6. `--help` / `-h` is handled by `formatHelp()` automatically unless `customHelp: true`.

## PR Expectations

- `bun run lint` clean (or `bun run lint:fix` first)
- `bun run typecheck` clean across all packages
- Relevant tests added or updated
- For user-visible changes: update `README.md` and/or `docs/design/*`
- For new invariants or gotchas: add them here

See the git log for commit message style — concise, conventional-commits-ish (`feat(web):`, `fix(llm):`, etc.), present tense.

## Further Reading

- [README.md](README.md) — user-facing overview and quickstart
- [docs/design/architecture.md](docs/design/architecture.md) — package dep graph and data flow
- [docs/design/core-infrastructure.md](docs/design/core-infrastructure.md) — schema, DI, config, outbox internals
- [docs/design/sync-protocol.md](docs/design/sync-protocol.md) — Ed25519, HLC, reducers, relay
- [docs/design/agent-system.md](docs/design/agent-system.md) — agent loop, context pipeline, commands
- [docs/design/sandbox-and-llm.md](docs/design/sandbox-and-llm.md) — VFS, driver shims, model routing
- [docs/design/web-and-discord.md](docs/design/web-and-discord.md) — HTTP API, WS protocol, platform connectors
- [docs/cli-operations.md](docs/cli-operations.md) — operator-facing CLI reference
