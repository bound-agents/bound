# Bound System Architecture Design

## Summary

Bound is a personal autonomous agent system that operates as a long-running conversational assistant with tool execution, distributed sync, and multi-interface access. This design establishes the implementation architecture for a Bun-based monorepo containing 9 packages that collectively deliver an agent capable of maintaining context across conversations, executing sandboxed commands, managing scheduled tasks, and synchronizing state across multiple instances.

The architecture follows a layered dependency graph with clear boundaries: `@bound/shared` provides cross-cutting types and utilities; `@bound/core` owns the SQLite database and dependency injection container; `@bound/llm`, `@bound/sandbox`, and specialized logic packages build on this foundation; and `@bound/agent` orchestrates the core loop. Three interface packages (`@bound/web`, `@bound/discord`, `@bound/cli`) expose the system to users. The sync protocol (`@bound/sync`) enables distributed operation where multiple instances converge via event-sourced changesets with LWW and append-only conflict resolution. Implementation proceeds in 8 phases, starting with schema and sync infrastructure, then building up to a complete system delivered as a single compiled binary with an interactive web UI.

## Definition of Done

A complete implementation architecture for the Bound autonomous agent system that delivers four concrete outputs:

1. **Implementation architecture document** covering module boundaries across the Bun monorepo, data flow between packages, dependency injection patterns, error handling conventions, and testing strategy per package.

2. **Confirmed technology stack** with specific versions/libraries for each concern (HTTP server, WebSocket, SVG rendering, test runner, build tooling, etc.).

3. **Phased build order** defining which packages to build first and what constitutes a working vertical slice at each phase, starting with Schema + Sync as Phase 1.

4. **Testing strategy per package** detailing what gets unit tested, what gets integration tested, and a local multi-instance testing approach for the sync protocol where two separate `bound` instances with different hostnames/configs run on the same machine to validate the full distributed sync flow end-to-end.

## Acceptance Criteria

### system-arch.AC1: Implementation architecture is documented with clear module boundaries
- **system-arch.AC1.1 Success:** 9 packages exist with correct dependency graph — no circular imports between packages
- **system-arch.AC1.2 Success:** Each package has a well-defined responsibility boundary documented in its package.json description
- **system-arch.AC1.3 Success:** DI container resolves all services at startup without runtime errors
- **system-arch.AC1.4 Success:** Typed event bus delivers events across package boundaries (e.g., agent emits `message:created`, web receives it)
- **system-arch.AC1.5 Failure:** Importing a package that creates a circular dependency causes a build error
- **system-arch.AC1.6 Edge:** Packages with optional features (discord, sync) can be disabled without affecting core functionality

### system-arch.AC2: Technology stack is confirmed with specific libraries
- **system-arch.AC2.1 Success:** Hono serves HTTP API routes and static Svelte assets from a single `Bun.serve` call
- **system-arch.AC2.2 Success:** Bun.serve native WebSocket pushes new messages to connected browser clients
- **system-arch.AC2.3 Success:** `bun:sqlite` creates the database with WAL mode and all 13 STRICT tables
- **system-arch.AC2.4 Success:** just-bash sandbox executes defineCommands, returns stdout/stderr/exitCode, and persists filesystem changes
- **system-arch.AC2.5 Success:** Zod validates config files at startup and rejects malformed input with specific error messages
- **system-arch.AC2.6 Failure:** Invalid config file (e.g., missing required `model_backends.json` fields) produces a clear validation error, not a runtime crash

### system-arch.AC3: Phased build order produces working vertical slices
- **system-arch.AC3.1 Success:** Phase 1 completes with a runnable monorepo where `bun install` and `bun test` succeed
- **system-arch.AC3.2 Success:** Phase 2 completes with two instances syncing changesets on localhost
- **system-arch.AC3.3 Success:** Phase 4 completes with a full agent loop processing a message end-to-end (user message in -> assistant response out, with tool execution)
- **system-arch.AC3.4 Success:** Phase 5 completes with a browser-based chat UI at localhost:3000
- **system-arch.AC3.5 Success:** Phase 7 completes with `bound init --ollama && bound start` producing a working system from a single binary
- **system-arch.AC3.6 Edge:** Each phase's tests pass independently without requiring later phases to be implemented

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.1 Success:** Every package has unit tests that run via `bun test`
- **system-arch.AC4.2 Success:** Core, agent, and sync packages have integration tests using real SQLite databases
- **system-arch.AC4.3 Success:** Sync integration tests run two bound instances on different ports with different configs on the same machine
- **system-arch.AC4.4 Success:** Multi-instance sync tests validate: basic replication, bidirectional sync, LWW conflict resolution, append-only dedup, change_log pruning, reconnection catch-up, hub promotion
- **system-arch.AC4.5 Success:** Playwright E2E tests verify the web chat flow end-to-end
- **system-arch.AC4.6 Success:** Code coverage meets thresholds: 80% for core/agent/sync, 60% for web/discord/cli
- **system-arch.AC4.7 Failure:** Tests that depend on external services (real LLM, real Discord) are skippable via environment flag without breaking the test suite

## Glossary

- **tsyringe**: Lightweight TypeScript dependency injection container using decorators to register and resolve services as singletons
- **Hono**: Minimalist HTTP framework supporting multiple runtimes (Bun, Node, Deno) with built-in static file serving
- **just-bash**: Sandboxed Bash execution environment with in-memory and overlay filesystems, custom command registration, and state persistence
- **Bun**: JavaScript/TypeScript runtime with native SQLite, WebSocket, bundler, and single-binary compilation capabilities
- **WAL mode**: Write-Ahead Logging — SQLite journal mode enabling concurrent readers during writes
- **STRICT tables**: SQLite 3.37+ feature enforcing type affinity and rejecting type mismatches at insert time
- **Svelte 5**: Reactive UI framework with compile-time optimizations, small bundle sizes, and native support for SVG manipulation
- **Playwright**: Browser automation framework for end-to-end testing of web applications
- **Biome**: Fast linter and formatter combining ESLint and Prettier functionality in a single Rust-based tool
- **LWW (Last-Write-Wins)**: Conflict resolution strategy where the most recent modification timestamp determines the canonical value
- **Append-only dedup**: Conflict resolution for collections where entries are merged and duplicates removed by primary key
- **Transactional outbox**: Pattern where business logic and change log entry creation occur atomically in a single database transaction
- **OCC (Optimistic Concurrency Control)**: Concurrency pattern that detects conflicts at commit time by comparing current state to a snapshot taken at transaction start
- **ClusterFs**: Virtual filesystem implementation routing paths to in-memory, overlay, or cached storage backends
- **Changeset**: Atomic batch of row-level changes (snapshots with operation metadata) exchanged during sync
- **Ed25519**: Elliptic curve public-key signature system used to authenticate sync protocol requests between instances
- **defineCommand**: just-bash extension mechanism for registering custom commands (orchestrator commands like `query`, `memorize`, etc.)
- **Vertical slice**: Working implementation of a complete feature path from UI to database, proving architecture viability at each phase
- **Quiescence**: Graduated reduction of autonomous task frequency based on time since the last user interaction across all interfaces
- **Spending ceiling**: Daily budget (`daily_budget_usd`) that pauses autonomous task scheduling when exceeded; interactive conversations are never blocked
- **Hub promotion**: Protocol for designating an instance as the authoritative sync hub during cluster topology changes
- **Reducer**: Function that merges conflicting database row versions into a single canonical state using LWW or append-only logic
- **Peer cursor**: Tracking structure recording which change_log sequence number each remote instance has successfully replicated

## Architecture

### Monorepo Structure

Bun workspace monorepo with 9 packages organized by domain. Dependencies flow downward — no circular imports.

```
bound/
  packages/
    shared/     # Types, events, utils — zero runtime deps
    core/       # DB schema, DI container, config loading
    llm/        # LLM backend drivers, model router, streaming
    sandbox/    # just-bash wrapper, ClusterFs, defineCommands
    agent/      # Agent loop state machine, context assembly, scheduler
    sync/       # Change log, sync protocol, reducers
    web/        # Hono API + Svelte UI
    discord/    # Discord bot handler
    cli/        # bound + boundctl CLI
  e2e/          # Playwright end-to-end tests
  docs/
  bunfig.toml
  package.json  # Bun workspaces root
```

Package dependency graph:

```
                    ┌─────────┐
                    │  shared  │
                    └────┬────┘
            ┌────────────┼────────────────┐
            v            v                v
       ┌────────┐   ┌────────┐      ┌─────────┐
       │  core  │   │  llm   │      │ sandbox │
       └───┬────┘   └───┬────┘      └────┬────┘
           │             │                │
           v             v                v
       ┌─────────────────────────────────────┐
       │              agent                   │
       └──────┬──────────┬──────────┬────────┘
              │          │          │
         ┌────v───┐ ┌───v────┐ ┌──v──────┐
         │  sync  │ │  web   │ │ discord │
         └────────┘ └────────┘ └─────────┘
                         │
                    ┌────v────┐
                    │   cli   │
                    └─────────┘
```

**Package scoping:** All packages use `@bound/` namespace (e.g., `@bound/core`, `@bound/agent`).

### Package Responsibilities

**`@bound/shared`** — TypeScript interfaces for cross-package contracts (Message, Task, Thread, LLMBackend, SandboxRuntime), the typed event map (`Events`), UUID helpers, Zod schemas for config file validation, the `Result<T, E>` type, and a lightweight `createLogger()` factory.

**`@bound/core`** — SQLite schema (all 13 tables from spec section 5), migration runner, DI container bootstrap via tsyringe, `AppContext` wiring, config file loading and validation. Owns the database connection and exposes typed query helpers.

**`@bound/llm`** — `LLMBackend` interface implementations for Ollama, Anthropic, Bedrock, and OpenAI-compatible endpoints. Model router that selects backends per-thread. Streaming chunk parser that normalizes provider-specific formats into the common `StreamChunk` type. Prompt caching breakpoint hints.

**`@bound/sandbox`** — just-bash wrapper that creates configured `Bash` instances. ClusterFs implementation routing `/home/user/` to InMemoryFs and `/mnt/` to OverlayFs or cached files. Filesystem hydrate/diff/persist lifecycle with OCC. defineCommand registration framework for orchestrator commands.

**`@bound/agent`** — Agent loop state machine (IDLE -> HYDRATE_FS -> ASSEMBLE_CONTEXT -> LLM_CALL -> PARSE_RESPONSE -> TOOL_EXECUTE/RESPONSE_PERSIST -> FS_PERSIST -> QUEUE_CHECK). Context assembly pipeline. Scheduler loop (cron, deferred, event-driven tasks). All defineCommand implementations (query, memorize, forget, schedule, await, cancel, emit, purge, cache-warm, cache-pin, cache-unpin, cache-evict, model-hint, archive). Task DAG resolution. Quiescence and spending ceiling enforcement.

**`@bound/sync`** — Change log producer (transactional outbox). Sync protocol HTTP endpoints (push/pull). LWW and append-only reducers. Peer cursor tracking via `sync_state` table. Change log pruning after peer confirmation. Ed25519 request signing and verification.

**`@bound/web`** — Hono HTTP API (threads, messages, files, status, cancel, sync endpoints). Bun.serve native WebSocket for real-time message push. Svelte 5 SPA built via Vite (System Map, Line View, Timetable, Network Status, Advisory views). Static asset serving via Hono's `serveStatic`.

**`@bound/discord`** — discord.js gateway connection. Message handler mapping DMs to threads. Allowlist enforcement (silent rejection per R-W1). Reaction-based cancel. Thread creation and mapping.

**`@bound/cli`** — `bound init` (interactive config generation), `bound start` (orchestrator bootstrap), `boundctl set-hub`, `boundctl stop/resume`, `boundctl restore`. Imports and wires all other packages into the running process.

### Dependency Injection & Events

Structural dependencies use tsyringe with decorator-based injection. Services are registered as singletons at startup in the DI container.

Cross-cutting concerns use a typed event bus (`TypedEventEmitter<Events>` in `@bound/shared`). Key events:

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `message:created` | agent, web, discord | web (WS push), discord (channel notify) |
| `task:triggered` | agent (scheduler) | agent (loop start) |
| `task:completed` | agent | web (timetable update) |
| `sync:completed` | sync | agent (await polling) |
| `file:changed` | agent (FS_PERSIST) | web (file link updates) |
| `alert:created` | agent, sync | web (notification badge) |

### Technology Stack

| Concern | Choice | Version/Notes |
|---------|--------|---------------|
| Runtime | Bun | 1.2+ (built-in SQLite, single binary) |
| HTTP framework | Hono | Lightweight, multi-runtime, `serveStatic` |
| WebSocket | Bun.serve native | Built-in pub/sub, no extra deps |
| Frontend | Svelte 5 + Vite | Reactive, small bundles, SVG-friendly |
| Database | `bun:sqlite` | WAL mode, STRICT tables |
| Sandbox | just-bash | 2.14+ (InMemoryFs, defineCommand, exec) |
| DI container | tsyringe | Lightweight decorator-based injection |
| Discord | discord.js | Full gateway support |
| Crypto | Built-in `crypto` | Ed25519 for sync auth |
| Schema validation | Zod | Config files, API inputs, sync payloads |
| Test runner | `bun test` | Native, Jest-compatible |
| E2E tests | Playwright | Browser automation |
| Component tests | @testing-library/svelte | Accessible query patterns |
| Linting | Biome | Replaces ESLint + Prettier |

No ORM — raw SQL via `bun:sqlite`. The spec defines all schemas precisely, queries are straightforward, and we need fine control over transactions (OCC with `BEGIN IMMEDIATE`, change_log outbox pattern).

### Error Handling

The spec mandates "recoverability over crash prevention" and "observability over prevention." Error handling by layer:

| Layer | Pattern |
|-------|---------|
| Database | Typed `DatabaseError` with operation context. Never swallowed. |
| LLM drivers | Retry with backoff for transient errors (429, 503). Typed `LLMError` for permanent failures. |
| Sandbox | Capture exec() results (stdout, stderr, exitCode). Non-zero exits feed back to LLM, never throw. |
| Sync | Log + increment `sync_errors`. Alert after configurable threshold. Never crash the process. |
| API routes | Hono middleware catches errors. Structured JSON responses. No stack trace leakage. |
| Agent loop | Catch at state machine level -> ERROR_PERSIST. Always attempt FS_PERSIST before IDLE. |

Fallible operations at module boundaries use the `Result<T, E>` type from `@bound/shared`. Truly exceptional cases throw.

### Testing Strategy

Balanced test pyramid per package:

| Package | Unit | Integration | E2E |
|---------|------|-------------|-----|
| shared | Type guards, helpers | N/A | N/A |
| core | Schema helpers, config parsing, UUID gen | Real SQLite: migrations, queries, change_log | N/A |
| llm | Stream parsing, message translation | Real HTTP against mock LLM server | N/A |
| sandbox | ClusterFs path routing, diff algorithm | Real just-bash exec(), defineCommand | N/A |
| agent | State transitions, context assembly | Full loop: mock LLM + real sandbox + real SQLite | N/A |
| sync | Reducer logic, changeset serialization | Multi-instance sync (see below) | N/A |
| web | Route handlers with mock context | Real Hono app with fetch | Playwright: chat flow |
| discord | Message parsing, command routing | discord.js with mock gateway | N/A |
| cli | Argument parsing, config generation | CLI subprocess execution | N/A |

**Local multi-instance sync testing** — the critical integration test:

Two `bound` instances run on the same machine with different configs:
- Instance A ("laptop"): DB at `/tmp/bound-test-a/bound.db`, port 3100, role: hub
- Instance B ("cloud-vm"): DB at `/tmp/bound-test-b/bound.db`, port 3200, role: spoke -> hub at localhost:3100

Test scenarios: basic replication, bidirectional sync, LWW conflict resolution, append-only dedup, change log pruning, reconnection catch-up, and hub promotion.

These run as integration tests in `@bound/sync` using real SQLite and real HTTP between instances — no mocking. A test harness spawns both instances, runs scenarios, and tears down.

**Conventions:**
- Files: `*.test.ts` for unit, `*.integration.test.ts` for integration
- Integration tests create temp databases in `/tmp/` and clean up
- `bunfig.toml` sets coverage thresholds: 80% for core/agent/sync, 60% for web/discord/cli

### Data Flow: Interactive Message

```
User types in Web UI
  -> POST /api/threads/{id}/messages
    -> Persist user message to DB + change_log (@bound/core)
    -> Emit 'message:created' (@bound/shared events)
    -> Agent loop starts (@bound/agent)
      -> HYDRATE_FS: files table -> InMemoryFs snapshot
      -> ASSEMBLE_CONTEXT: system + memory + history + volatile
      -> LLM_CALL: stream to backend (@bound/llm)
      -> PARSE_RESPONSE: tool_use or text
        -> tool_use: TOOL_EXECUTE (@bound/sandbox) -> TOOL_PERSIST -> loop
        -> text: RESPONSE_PERSIST -> FS_PERSIST -> QUEUE_CHECK
    -> WebSocket pushes new messages (@bound/web)
```

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case.ts | `agent-loop.ts`, `llm-backend.ts` |
| Classes | PascalCase | `AgentLoop`, `ModelRouter` |
| Interfaces | PascalCase, no I prefix | `LLMBackend`, `SandboxRuntime` |
| Events | domain:action | `message:created`, `sync:completed` |
| DB columns | snake_case | `modified_at`, `thread_id` |
| Config keys | snake_case JSON | `daily_budget_usd`, `sync_interval` |
| Packages | @bound/{name} | `@bound/core`, `@bound/agent` |

## Existing Patterns

This is a greenfield project — no existing codebase patterns to follow. The spec (`docs/design/specs/2026-03-20-base.md`) serves as the canonical reference for all domain concepts, database schemas, and interface contracts.

The design introduces these patterns for the codebase:
- **Functional core, imperative shell** — Pure logic in shared/core, side effects at the edges (LLM calls, DB writes, sandbox exec)
- **Transactional outbox** — Every synced DB write produces a change_log entry in the same transaction
- **OCC (Optimistic Concurrency Control)** — Filesystem persist diffs against pre-hydration snapshot inside `BEGIN IMMEDIATE`
- **Event-sourced sync** — Row-level snapshots as events, LWW/append-only reducers for convergence
- **Typed event bus** — Cross-cutting communication without tight coupling between packages

These patterns are prescribed by the spec, not arbitrary choices.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Foundation
**Goal:** Runnable monorepo with database schema, DI container, and config loading

**Components:**
- `@bound/shared` — All TypeScript interfaces, event type map, Result type, UUID helpers, Zod config schemas, createLogger factory
- `@bound/core` — SQLite schema (all 13 tables), migration runner, tsyringe container setup, config loader (allowlist.json, model_backends.json), AppContext type and factory

**Dependencies:** None (first phase)

**Done when:** `bun install` succeeds across workspaces, database can be created with all tables, config files parse and validate, change_log entries are produced for every synced table write. Covers system-arch.AC1.x.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Sync Protocol
**Goal:** Two instances on localhost can exchange changesets and converge

**Components:**
- `@bound/sync` — LWW reducer, append-only reducer, changeset serialization (JSON row snapshots), HTTP push/pull endpoints (Hono routes), peer cursor tracking (sync_state table), change_log pruning, Ed25519 request signing/verification, sync loop (configurable interval)
- Multi-instance test harness — spawns two configured instances, runs sync scenarios, tears down

**Dependencies:** Phase 1 (schema, core)

**Done when:** All 7 multi-instance sync test scenarios pass (basic replication, bidirectional, LWW conflict, append-only dedup, change_log pruning, reconnection catch-up, hub promotion). Covers system-arch.AC2.x.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Sandbox & LLM
**Goal:** Can execute commands in a sandboxed environment and stream responses from an LLM

**Components:**
- `@bound/sandbox` — just-bash Bash wrapper (configured instances), ClusterFs implementation (path routing for `/home/user/` vs `/mnt/`), defineCommand registration framework, filesystem hydrate/diff/persist lifecycle with OCC
- `@bound/llm` — LLMBackend interface, Ollama driver (first driver — testable locally), streaming chunk parser, model router (backend selection per thread), common message format translation

**Dependencies:** Phase 1 (schema, core — files table for hydration, config for model backends)

**Done when:** Can hydrate filesystem from DB, exec commands in sandbox, diff and persist changes via OCC. Can stream a response from Ollama and parse it into common message format. Covers system-arch.AC3.x.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Agent Loop & Scheduler
**Goal:** Complete agent loop processes a message end-to-end; scheduler triggers tasks

**Components:**
- `@bound/agent` — Agent loop state machine (all states from spec section 4.5), context assembly pipeline, all defineCommand implementations (query, memorize, forget, schedule, await, cancel, emit, purge, cache-warm, cache-pin, cache-unpin, cache-evict, model-hint, archive), scheduler loop (cron seeding, deferred execution, event-driven triggers), task DAG resolution (depends_on), lease pattern, heartbeats, quiescence enforcement, spending ceiling checks

**Dependencies:** Phase 1 (core), Phase 3 (sandbox, llm)

**Done when:** A user message triggers a full loop: hydrate -> assemble context -> LLM call -> tool execution -> persist -> respond. Scheduler fires cron tasks on time, deferred tasks resolve, event-driven tasks trigger on emit. Task DAGs resolve dependencies correctly. Covers system-arch.AC4.x.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Web Interface
**Goal:** Interactive web UI for chatting with the agent

**Components:**
- `@bound/web` — Hono API routes (CRUD for threads, messages, files; status endpoint; cancel endpoint; sync trigger), Bun.serve WebSocket handler (real-time message push, activity status), Svelte 5 SPA (System Map with SVG transit diagram, Line View for thread chat, Timetable for task monitoring, Network Status for cluster topology, Advisory view), static asset serving, model selector in top bar

**Dependencies:** Phase 1 (core), Phase 4 (agent)

**Done when:** Open browser at localhost:3000, see System Map, create thread, send message, see agent response with tool calls in real-time, cancel running loop, switch models. Covers system-arch.AC5.x.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Discord Interface
**Goal:** Chat with the agent via Discord DM

**Components:**
- `@bound/discord` — discord.js gateway connection, DM message handler, allowlist enforcement (silent rejection for non-allowlisted users), reaction-based cancel (cross reaction or "cancel" message), thread creation and mapping to DB threads

**Dependencies:** Phase 1 (core), Phase 4 (agent)

**Done when:** DM the bot, receive agent response, cancel with cross reaction. Non-allowlisted users get no response. Covers system-arch.AC6.x.
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: CLI & Binary
**Goal:** Single binary distribution with init and management commands

**Components:**
- `@bound/cli` — `bound init` (interactive config generation with presets: --ollama, --anthropic, --bedrock), `bound start` (full orchestrator bootstrap wiring all packages), `boundctl set-hub` (hub promotion via cluster_config), `boundctl stop/resume` (emergency stop), `boundctl restore` (point-in-time recovery)
- Build pipeline — `bun build --compile` producing single binary with embedded Svelte assets

**Dependencies:** All previous phases

**Done when:** Download binary, run `bound init --ollama && bound start`, chat at localhost:3000. `boundctl stop` halts operations cluster-wide. Covers system-arch.AC7.x.
<!-- END_PHASE_7 -->

<!-- START_PHASE_8 -->
### Phase 8: Additional LLM Drivers & Advanced Features
**Goal:** Full multi-provider support and remaining spec features

**Components:**
- `@bound/llm` additions — Anthropic driver, Bedrock driver, OpenAI-compatible driver, prompt caching breakpoint support per provider
- `@bound/sandbox` additions — Overlay index scanning (periodic, content-addressed), ClusterFs remote file support (cache-warm, staleness detection)
- `@bound/agent` additions — Advisories system (proposed/approved/dismissed/deferred/applied lifecycle), message redaction cascade (content replacement + memory tombstoning), thread title generation (at-most-once after first response), summary/memory extraction on idle, cross-thread activity digest in volatile context
- `@bound/web` additions — Advisory view, redaction UI, network status with live sync health

**Dependencies:** All previous phases

**Done when:** Can chat via Anthropic, Bedrock, and OpenAI-compatible backends. Overlay files discoverable across hosts. Advisories lifecycle works. Message redaction cascades to memory. Thread titles auto-generate. Covers system-arch.AC8.x.
<!-- END_PHASE_8 -->

## Additional Considerations

**Implementation scoping:** This design has exactly 8 phases, fitting within the implementation plan limit.

**Spec as source of truth:** The functional spec (`docs/design/specs/2026-03-20-base.md`) contains complete database schemas, interface contracts, and behavioral requirements. This design document covers the implementation architecture — how the code is organized, what tools are used, and in what order things get built. The spec should be referenced directly during implementation for detailed behavioral requirements.

**Logging:** Structured JSON to stderr via `createLogger(pkg, component)` in `@bound/shared`. Log levels: debug, info, warn, error. Every entry includes timestamp, level, package, component, and contextual fields (thread_id, task_id, host_name). No logging framework for v1.
