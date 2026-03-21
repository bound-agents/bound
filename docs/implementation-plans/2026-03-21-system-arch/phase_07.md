# Bound System Architecture - Phase 7: CLI & Binary

**Goal:** Single binary distribution with `bound init` (interactive config generation), `bound start` (full orchestrator bootstrap), and `boundctl` management commands. Download → init → start → chat in under 60 seconds.

**Architecture:** `@bound/cli` package that imports and wires all other packages into a running process. The CLI handles config generation, orchestrator lifecycle, and operator management tools. `bun build --compile` produces a single binary with embedded Svelte assets.

**Tech Stack:** Bun CLI argument parsing, `bun build --compile` (single binary), @bound/* (all packages)

**Scope:** 8 phases from original design (phase 7 of 8)

**Codebase verified:** 2026-03-22 — All previous phases (1-6) provide the packages that the CLI wires together.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC1: Implementation architecture is documented with clear module boundaries
- **system-arch.AC1.1 Success:** 9 packages exist with correct dependency graph — no circular imports between packages
- **system-arch.AC1.5 Failure:** Importing a package that creates a circular dependency causes a build error
- **system-arch.AC1.6 Edge:** Packages with optional features (discord, sync) can be disabled without affecting core functionality

### system-arch.AC3: Phased build order produces working vertical slices
- **system-arch.AC3.5 Success:** Phase 7 completes with `bound init --ollama && bound start` producing a working system from a single binary

### Phase 7 Verification Criteria (derived from design "Done when")
- **V7.1:** Download binary, run `bound init --ollama && bound start`, chat at localhost:3000
- **V7.2:** `boundctl stop` halts operations cluster-wide
- **V7.3:** All 9 packages exist with no circular imports (verify via `tsc --noEmit`)
- **V7.4:** Start without discord.json or sync.json — system works in single-host mode (AC1.6)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: @bound/cli package setup

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/bound.ts` (main entry for `bound` command)
- Create: `packages/cli/src/boundctl.ts` (main entry for `boundctl` command)
- Modify: `tsconfig.json` (root) — add cli to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/cli",
  "version": "0.0.1",
  "description": "CLI tools for initializing, running, and managing the Bound agent system — bound init/start and boundctl management commands",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "bin": {
    "bound": "src/bound.ts",
    "boundctl": "src/boundctl.ts"
  },
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "@bound/agent": "workspace:*",
    "@bound/sync": "workspace:*",
    "@bound/web": "workspace:*",
    "@bound/discord": "workspace:*",
    "@bound/llm": "workspace:*",
    "@bound/sandbox": "workspace:*"
  }
}
```

**Step 2: Create tsconfig.json with references to all packages**

**Step 3: Verify**

Run: `bun install`
Expected: All workspace packages resolve

**Step 4: Commit**

```bash
git add packages/cli/ tsconfig.json bun.lockb
git commit -m "chore(cli): initialize @bound/cli package"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: `bound init` — interactive config generation

**Verifies:** system-arch.AC3.5

**Files:**
- Create: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/bound.ts` — add init subcommand

**Implementation:**

`packages/cli/src/commands/init.ts` — Config file generation per spec §1.3:

- `runInit(args: InitArgs): Promise<void>` where `InitArgs` supports:
  - `--ollama` → Preset: detect $USER, configure Ollama at localhost:11434, default model llama3
  - `--anthropic` → Preset: prompt for API key or read ANTHROPIC_API_KEY
  - `--bedrock --region <region>` → Preset: use AWS credentials
  - No flags → Interactive prompts: name, backend choice, model selection
  - `--name <name>` → Non-interactive name
  - `--with-sync` → Also create keyring.json + sync.json templates
  - `--with-mcp` → Also create mcp.json template
  - `--with-overlay` → Also create overlay.json template

  Process:
  1. Create `config/` directory if not exists
  2. Generate `config/allowlist.json` from user input (name → deterministic UUID)
  3. Generate `config/model_backends.json` from backend choice
  4. Optionally generate sync/mcp/overlay templates
  5. Print success message with next steps

  Interactive prompts use Bun's built-in `prompt()` or read from stdin. Non-interactive mode uses command-line flags directly.

  Idempotent: existing files are NOT overwritten unless `--force` flag is provided.

**Testing:**
- `init --ollama` in a temp dir: verify allowlist.json and model_backends.json created with correct content
- `init --ollama` twice: second run does not overwrite (prints "config already exists")
- `init --ollama --force`: overwrites existing files
- Invalid args produce helpful error messages

Test file: `packages/cli/src/__tests__/init.test.ts` (integration — temp directories)

**Verification:**
Run: `bun test packages/cli/`
Expected: All tests pass

**Commit:** `feat(cli): add bound init with presets and interactive config generation`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: `bound start` — orchestrator bootstrap

**Verifies:** system-arch.AC3.5

**Files:**
- Create: `packages/cli/src/commands/start.ts`
- Modify: `packages/cli/src/bound.ts` — add start subcommand

**Implementation:**

`packages/cli/src/commands/start.ts` — Full orchestrator startup:

- `runStart(args: StartArgs): Promise<void>` — Bootstrap sequence:
  1. **Config:** Load and validate all config files via `@bound/core` config loader. Exit with clear errors if required configs missing.
  2. **Crypto:** Ensure Ed25519 keypair via `@bound/sync` ensureKeypair(). Print public key on first run.
  3. **Database:** Create/open SQLite database. Run schema migrations via `@bound/core` applySchema(). Set WAL mode.
  4. **Identity:** Read or create site_id in host_meta table.
  5. **Crash recovery scan (R-E13):** Scan for interrupted loops — threads where the last message is `tool_call` or `tool_result` with no subsequent `assistant` message. For each, insert a `system` message: "Previous response on {host} was interrupted." This ensures crash state is visible to users.
  6. **DI Container:** Bootstrap tsyringe container with all services.
  7. **User seeding:** Seed users from allowlist.json with deterministic UUIDs (idempotent).
  8. **Host registration:** Upsert this host's row in the hosts table with version, mcp_servers, models, overlay_root.
  9. **Cron seeding:** Seed cron tasks from cron_schedules.json (if exists) with deterministic UUIDs.
  10. **MCP connections:** If mcp.json exists → connect to all configured MCP servers, auto-generate defineCommands from discovered tools, apply allow_tools filters and confirm gates. Update hosts.mcp_servers and hosts.mcp_tools.
  11. **Sandbox:** Create ClusterFs, hydrate workspace, register all defineCommands (core + MCP), create sandbox factory.
  12. **Persona:** Load config/persona.md if it exists, store for context assembly injection.
  13. **LLM:** Create model router from config.
  14. **Web server:** Start Hono + WebSocket via `@bound/web` createWebServer().
  15. **Discord:** If discord.json exists and this host matches → start Discord bot via `@bound/discord`.
  16. **Sync:** If sync.json exists → start sync loop via `@bound/sync`.
  17. **Overlay scanning:** If overlay.json exists → start overlay index scan loop.
  18. **Scheduler:** Start scheduler loop via `@bound/agent`.
  19. **Ready:** Print "Bound is running at http://localhost:{port}"

  Graceful shutdown on SIGINT/SIGTERM: stop scheduler, stop overlay scanner, stop sync, stop Discord, stop web server, close MCP connections, close database.

**Testing:**
- Bootstrap with valid config in temp dir: verify all services start (web server responds to /api/status)
- Bootstrap with missing required config: verify clear error message
- Graceful shutdown: send SIGINT, verify all services stopped cleanly

Test file: `packages/cli/src/__tests__/start.test.ts` (integration)

**Verification:**
Run: `bun test packages/cli/`
Expected: All tests pass

**Commit:** `feat(cli): add bound start with full orchestrator bootstrap`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-6) -->
<!-- START_TASK_4 -->
### Task 4: `boundctl` management commands

**Files:**
- Create: `packages/cli/src/commands/set-hub.ts`
- Create: `packages/cli/src/commands/stop-resume.ts`
- Create: `packages/cli/src/commands/restore.ts`
- Modify: `packages/cli/src/boundctl.ts` — add subcommands

**Implementation:**

`boundctl` communicates with the running orchestrator via local HTTP (`localhost:3000/api/...`) or operates directly on the database when the orchestrator is stopped. Per spec §12.7:

- `set-hub <host-name>` — Write `cluster_hub` key to `cluster_config` table. If `--wait`, poll sync_status until all peers confirm.
- `stop` — Set `emergency_stop` key in `cluster_config` with current timestamp. All hosts halt autonomous operations on next sync.
- `resume` — Clear `emergency_stop` key. Normal operations resume.
- `restore --before <timestamp> [--preview] [--tables ...]` — Point-in-time recovery per spec §12.8. Preview mode shows what would change without executing. Restore: revert synced rows to state before timestamp.

**Testing:**
- `set-hub`: set hub in a test database, verify cluster_config entry
- `stop/resume`: set emergency_stop, verify it's set; resume, verify it's cleared
- `restore --preview`: create data, restore preview, verify correct row counts reported

Test file: `packages/cli/src/__tests__/boundctl.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/cli/`
Expected: All tests pass

**Commit:** `feat(cli): add boundctl set-hub, stop, resume, and restore commands`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Single binary build pipeline

**Verifies:** system-arch.AC3.5

**Files:**
- Create: `scripts/build.ts`
- Modify: root `package.json` — add build script

**Implementation:**

`scripts/build.ts` — Build pipeline:

1. Run `cd packages/web && bun run build` to produce Svelte SPA assets in `packages/web/dist/client/`
2. Run `bun build --compile packages/cli/src/bound.ts --outfile dist/bound` to produce single binary
3. The binary embeds all workspace code and the Svelte assets
4. Print binary size and path

Add to root package.json: `"scripts": { "build": "bun run scripts/build.ts" }`

Note: `bun build --compile` includes all imported modules. The Svelte assets need to be embedded as static imports or via Bun's file embedding. The web server's `serveStatic` must reference the embedded assets correctly.

**Testing:**
- Run build script, verify binary exists at expected path
- Run the binary with `--help`, verify it prints usage information
- Binary size is reasonable (< 100MB including SQLite + Svelte assets)

Test file: `scripts/__tests__/build.test.ts` (integration)

**Verification:**
Run: `bun run build && ./dist/bound --help`
Expected: Binary builds and responds to --help

**Commit:** `feat(cli): add single binary build pipeline via bun build --compile`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: End-to-end CLI integration test

**Verifies:** system-arch.AC3.5

**Files:**
- Create: `packages/cli/src/__tests__/e2e.integration.test.ts`

**Implementation:**

Full integration test proving AC3.5: `bound init --ollama && bound start` produces a working system:

1. Create a temp directory for the test
2. Run `bound init --ollama` (subprocess or direct function call) pointing at the temp dir
3. Verify: `config/allowlist.json` and `config/model_backends.json` created
4. Start the orchestrator (direct call to `runStart` with temp dir) with a mock LLM backend
5. Wait for server to be ready (poll `/api/status`)
6. Verify: `GET /api/status` returns 200 with host info
7. Verify: `GET /api/threads` returns 200 with empty array
8. Create a thread, send a message, verify agent processes it
9. Stop the orchestrator
10. Verify: graceful shutdown completes

This test proves the complete init → start → use → stop lifecycle.

**Verification:**
Run: `bun test packages/cli/src/__tests__/e2e.integration.test.ts`
Expected: Test passes

**Commit:** `test(cli): add end-to-end init/start/stop integration test`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->
