# Bound CLI and Operations Guide

This document covers the Command Line Interface (CLI) for the Bound agent system, including initialization, operation, management, and the single-binary build pipeline.

---

## Table of Contents

1. [Overview](#overview)
2. [bound: Orchestrator Control](#bound-orchestrator-control)
   - [bound init](#bound-init)
   - [bound start](#bound-start)
3. [boundctl: Cluster Management](#boundctl-cluster-management)
   - [boundctl set-hub](#boundctl-set-hub)
   - [boundctl stop / resume](#boundctl-stop--resume)
   - [boundctl restore](#boundctl-restore)
4. [Configuration Reference](#configuration-reference)
5. [Bootstrap Sequence](#bootstrap-sequence)
6. [Build Pipeline](#build-pipeline)

---

## Overview

The Bound system provides two command-line interfaces:

- **bound**: Initializes configuration and starts the Bound orchestrator
- **boundctl**: Manages running orchestrators, including cluster hub configuration, emergency operations, and point-in-time recovery

Both CLIs expect a configuration directory (default: `config/`) containing JSON configuration files. Configuration is loaded and validated during startup before any services are initialized.

---

## bound: Orchestrator Control

## bound init

Initializes the configuration directory with required configuration files. The command creates `allowlist.json` (user whitelist and defaults) and `model_backends.json` (LLM backend configuration) based on the specified provider preset.

### Syntax

```
bound init [PRESET] [OPTIONS]
```

### Presets

Exactly one preset must be selected:

#### Ollama Preset

```
bound init --ollama
```

Configures a local Ollama instance. Defaults:
- Provider: `ollama`
- Base URL: `http://localhost:11434`
- Model: `llama3`
- Context window: 8192 tokens
- Capability tier: 3
- No API key required

#### Anthropic Preset

```
bound init --anthropic
```

Configures Anthropic API. Requires:
- Environment variable: `ANTHROPIC_API_KEY`

Defaults:
- Provider: `anthropic`
- Model: `claude-3-5-sonnet-20241022`
- Context window: 200000 tokens
- Capability tier: 3
- Base URL: Anthropic's default (not configurable via init)

If `ANTHROPIC_API_KEY` is not set, initialization continues but the API key will be empty in the configuration.

#### Bedrock Preset

```
bound init --bedrock --region <region>
```

Configures AWS Bedrock. Requires:
- `--region` parameter (e.g., `us-east-1`, `us-west-2`)

Defaults:
- Provider: `bedrock`
- Region: Specified by `--region` (defaults to `us-east-1` if omitted)
- Model: `anthropic.claude-3-5-sonnet-20241022-v2:0`
- Context window: 200000 tokens
- Capability tier: 3
- Credentials: Retrieved from AWS SDK (environment, credentials file, or IAM role)

### Options

`--name <name>`
: Sets the operator name. Defaults to `$USER` environment variable or `operator` if unset. Used as the default web user and to generate deterministic UUIDs.

`--with-sync`
: Creates an optional `sync.json` template for cluster synchronization configuration. Enables multi-host operation.

`--with-mcp`
: Creates an optional `mcp.json` template for Model Context Protocol (MCP) server connections.

`--with-overlay`
: Creates an optional `overlay.json` template for filesystem overlay configuration.

`--force`
: Overwrites existing configuration files. Without this flag, initialization exits if config already exists.

`--config-dir <dir>`
: Sets the configuration directory. Defaults to `config/`.

### Examples

Simple Ollama setup:
```
bound init --ollama
```

Anthropic with sync and MCP templates:
```
bound init --anthropic --with-sync --with-mcp
```

Bedrock in specific region with operator name:
```
bound init --bedrock --region eu-west-1 --name alice
```

Reinitialize with fresh configuration:
```
bound init --ollama --force
```

### Output

On success, displays:
- List of created files
- Operator name
- LLM provider and model
- Instructions to review config and start the orchestrator

Exit code 0 on success, 1 on error.

---

## bound start

Starts the Bound orchestrator and executes the bootstrap sequence.

### Syntax

```
bound start [OPTIONS]
```

### Options

`--config-dir <dir>`
: Sets the configuration directory. Defaults to `config/`.

### Process

The startup process is non-interactive. It loads configuration, initializes all services, seeds the database, and starts the web server. Progress is reported to stdout.

If any initialization step fails, the startup exits with error code 1 and does not continue to later steps.

### Examples

Start with default config directory:
```
bound start
```

Start with custom config directory:
```
bound start --config-dir /etc/bound/config
```

### Output

On successful startup:
```
Starting Bound orchestrator...
Loading configuration...
Initializing cryptography...
Initializing database...
Setting up services...
Seeding users from allowlist...
Registering host...
Scanning for crash recovery...
Initializing MCP servers...
Setting up sandbox...
Loading persona...
Initializing LLM...
Starting web server...
Initializing Discord...
Initializing sync loop...
Initializing overlay scanner...
Starting scheduler...

Bound is running!
Operator: <name>

Open http://localhost:3000 in your browser to start chatting.

Press Ctrl+C to stop.
```

The process responds to SIGINT and SIGTERM for graceful shutdown.

---

## boundctl: Cluster Management

### boundctl set-hub

Designates a cluster host as the hub (central synchronization point). Hub election is typically the first operation after initializing multiple hosts.

#### Syntax

```
boundctl set-hub <host-name> [OPTIONS]
```

#### Arguments

`<host-name>` (required)
: Identifier of the host to designate as hub. Examples: `primary-host`, `api-01`, `host-prod`.

#### Options

`--wait`
: Blocks until all peers confirm the hub change. Without this flag, the command returns immediately after writing the hub designation.

`--config-dir <dir>`
: Sets the configuration directory. Defaults to `config/`.

#### Behavior

Writes `cluster_hub` key to the `cluster_config` table in the database. Hosts sync this configuration on their next sync cycle and recognize the new hub.

If `--wait` is used, the command polls the `sync_status` table until all registered peers have confirmed the change.

#### Examples

Set hub without waiting:
```
boundctl set-hub primary-host
```

Set hub and wait for confirmation:
```
boundctl set-hub primary-host --wait
```

Set hub with custom config directory:
```
boundctl set-hub backup-01 --config-dir /var/lib/bound/config
```

#### Exit Codes

- 0: Success
- 1: Database error or peer confirmation timeout

---

### boundctl stop

Triggers an emergency stop across all connected hosts. Used to halt all autonomous agent operations cluster-wide for maintenance or incident response.

#### Syntax

```
boundctl stop [OPTIONS]
```

#### Options

`--config-dir <dir>`
: Sets the configuration directory. Defaults to `config/`.

#### Behavior

Writes `emergency_stop` key with current ISO 8601 timestamp to the `cluster_config` table. On the next sync cycle, all hosts check this flag and suspend autonomous operations. Web interface and manual commands remain available.

#### Examples

Trigger emergency stop:
```
boundctl stop
```

#### Output

```
Setting emergency stop flag...
Emergency stop set. All hosts will halt autonomous operations on next sync.
```

#### Exit Codes

- 0: Success
- 1: Database error

---

### boundctl resume

Clears the emergency stop flag to resume normal autonomous operations cluster-wide.

#### Syntax

```
boundctl resume [OPTIONS]
```

#### Options

`--config-dir <dir>`
: Sets the configuration directory. Defaults to `config/`.

#### Behavior

Deletes the `emergency_stop` key from the `cluster_config` table. On the next sync cycle, all hosts detect the flag is cleared and resume autonomous operations.

#### Examples

Resume normal operations:
```
boundctl resume
```

#### Output

```
Clearing emergency stop flag...
Emergency stop cleared. Normal operations resume.
```

#### Exit Codes

- 0: Success
- 1: Database error

---

### boundctl restore

Performs point-in-time recovery, reverting database state to a specified timestamp. Used for incident recovery, data corruption mitigation, or state rollback.

#### Syntax

```
boundctl restore --before <timestamp> [OPTIONS]
```

#### Arguments

`--before <timestamp>` (required)
: ISO 8601 formatted timestamp (e.g., `2024-01-01T12:00:00Z`). Recovery reverts all synced rows to their state before this moment. Local-only rows are not affected.

#### Options

`--preview`
: Shows what changes would be made without executing the restore. Useful for validation before committing.

`--tables <table1> <table2> ...`
: Restricts recovery to specified tables. If omitted, all tables are considered for recovery.

`--config-dir <dir>`
: Sets the configuration directory. Defaults to `config/`.

#### Behavior

Reads the changelog to identify rows modified after the specified timestamp. For each affected synced row, reverts to the state recorded in the changelog before that timestamp. Local rows (not part of sync) remain unchanged.

The restore process uses a copy-on-write approach to ensure atomicity: if the operation fails partway through, the original database state is preserved.

#### Examples

Preview recovery to specific timestamp:
```
boundctl restore --before "2024-01-01T12:00:00Z" --preview
```

Execute recovery:
```
boundctl restore --before "2024-01-01T12:00:00Z"
```

Recover specific tables:
```
boundctl restore --before "2024-01-15T09:30:00Z" --tables conversations messages
```

#### Output

Preview mode:
```
Point-in-time recovery before: 2024-01-01T12:00:00Z
PREVIEW MODE - No changes will be made

Restoring to state before: 2024-01-01T12:00:00Z
Preview complete. Run without --preview to execute.
```

Execution mode:
```
Point-in-time recovery before: 2024-01-01T12:00:00Z
Restoring to state before: 2024-01-01T12:00:00Z
Restore completed successfully.
```

#### Exit Codes

- 0: Success
- 1: Invalid timestamp format or database error

---

---

## Bootstrap Sequence

The `bound start` command executes a strictly ordered bootstrap sequence. All steps must complete successfully for startup to proceed. If any step fails, the startup halts with error code 1.

### Sequence Steps

1. **Load and validate all config files**
   - Reads and validates `allowlist.json` and `model_backends.json`
   - Checks for optional files (`sync.json`, `mcp.json`, `overlay.json`, `discord.json`)
   - Exits with error if required files are missing or invalid

2. **Initialize cryptography**
   - Ensures Ed25519 keypair exists (via `@bound/sync`)
   - Generates keypair if needed, stored in secure location
   - Used for cluster synchronization signing

3. **Initialize database**
   - Creates or opens `bound.db` (SQLite)
   - Runs all pending schema migrations
   - Establishes WAL (Write-Ahead Logging) mode for durability

4. **Set up dependency injection container**
   - Bootstraps tsyringe container
   - Registers all service singletons
   - Injects database, cryptography, and configuration into services

5. **Seed users from allowlist**
   - Creates user entries in the `users` table
   - Generates deterministic UUIDs using `deterministicUUID(BOUND_NAMESPACE, username)`
   - Marks default user as web default

6. **Register host**
   - Inserts or updates host entry in `hosts` table
   - Records host identifier, startup time, and current schema version

7. **Scan for crash recovery**
   - Scans for interrupted agent loops from previous crashes
   - Inserts recovery messages into the message queue for replay
   - Ensures no work is lost on unexpected shutdown

8. **Initialize MCP servers**
   - Reads `mcp.json` if present
   - Spawns MCP server subprocesses
   - Establishes stdio communication channels

9. **Set up sandbox**
   - Creates ClusterFs (sandboxed filesystem)
   - Defines available commands and tools
   - Loads overlay mounts from `overlay.json` if present

10. **Load persona**
    - Reads `config/persona.md` if present
    - Uses content as system prompt for agent
    - Falls back to default system prompt if absent

11. **Initialize LLM**
    - Creates model router from `model_backends.json`
    - Validates connectivity to configured backends
    - Selects default backend by tier and configuration

12. **Start web server**
    - Initializes Hono web framework
    - Sets up WebSocket for real-time communication
    - Listens on `http://localhost:3000` (customizable)

13. **Initialize Discord bot**
    - Reads `discord.json` if present
    - Checks if host matches current hostname
    - Connects to Discord API and joins specified server

14. **Initialize sync loop**
    - Reads `sync.json` if present
    - Starts periodic synchronization with hub
    - Establishes cluster membership

15. **Initialize overlay scanner**
    - Reads `overlay.json` if present
    - Scans mounted directories for file changes
    - Indexes files for agent access

16. **Start scheduler**
    - Initializes agent scheduler loop
    - Begins processing incoming messages and tasks
    - Starts autonomous agent execution if enabled

### Bootstrap Configuration

Bootstrap is driven by file presence and configuration:

- If `sync.json` is absent, steps 6 and 14 are skipped (single-host mode)
- If `mcp.json` is absent, step 8 is skipped
- If `persona.md` is absent, step 10 uses default system prompt
- If `discord.json` is absent or host doesn't match, step 13 is skipped
- If `overlay.json` is absent, step 15 is skipped

All other steps execute unconditionally.

### Graceful Shutdown

The orchestrator responds to SIGINT (Ctrl+C) and SIGTERM signals. Shutdown performs these steps in reverse order:
1. Stop scheduler
2. Stop sync loop (if running)
3. Close MCP connections
4. Shutdown web server
5. Close database
6. Clear cryptographic material
7. Exit with code 0

---

## Build Pipeline

The Bound CLI is built as a single standalone binary via `bun build --compile`, eliminating runtime dependency on Node.js or Bun.

### Build Process

The build pipeline is defined in `scripts/build.ts` and performs two main steps:

#### Step 1: Build Web Assets

```
cd packages/web && bun run build
```

Compiles the web UI (React, TypeScript, CSS) into static assets. These are embedded into the final binary.

Output: Static files in `packages/web/dist/`

#### Step 2: Compile Single Binary

```
bun build --compile packages/cli/src/bound.ts --outfile dist/bound
```

Compiles the CLI entry point and all dependencies into a standalone executable. The executable contains:
- Bound CLI code (bound.ts, boundctl.ts, and all commands)
- Web assets (embedded)
- All Node.js and Bun runtime dependencies
- No external runtime required

### Running the Build

```
bun scripts/build.ts
```

On successful completion, outputs binary size and location:
```
Building Bound...

1. Building web assets...
✓ Web assets built successfully

2. Compiling single binary...
✓ Binary compiled successfully

Build complete!
Binary: dist/bound (45.23 MB)

You can run: ./dist/bound --help
```

### Development Alternative

If binary compilation fails (expected without native build tools), run directly:

```
bun packages/cli/src/bound.ts --help
bun packages/cli/src/bound.ts init --ollama
bun packages/cli/src/bound.ts start
```

For `boundctl`, similarly:

```
bun packages/cli/src/boundctl.ts --help
bun packages/cli/src/boundctl.ts set-hub primary-host
```

### Binary Characteristics

- **Single file**: One executable, no external dependencies
- **Cross-platform**: Built on one platform, deployable to same OS/architecture
- **Self-contained**: All assets and runtimes embedded
- **Size**: Approximately 45-50 MB (includes Bun runtime and dependencies)
- **Format**: ELF (Linux), Mach-O (macOS), PE (Windows)

### Deployment

After building, deploy the binary to target systems:

```
scp dist/bound user@host:/usr/local/bin/bound
chmod +x /usr/local/bin/bound

# Verify
/usr/local/bin/bound --help
```

Create `boundctl` as a symlink or separate build:

```
ln -s /usr/local/bin/bound /usr/local/bin/boundctl
```

The binary detects the invocation name and routes to the appropriate CLI (bound or boundctl).

---

## Usage Workflows

### Single-Host Setup

1. Initialize with local Ollama:
   ```
   bound init --ollama --name operator
   ```

2. Review generated config:
   ```
   cat config/allowlist.json
   cat config/model_backends.json
   ```

3. Start the orchestrator:
   ```
   bound start
   ```

4. Open browser to `http://localhost:3000`

### Multi-Host Cluster Setup

1. Initialize hub host with sync:
   ```
   bound init --anthropic --with-sync --name alice
   ```

2. Initialize peer hosts (same init, different names):
   ```
   bound init --anthropic --with-sync --name bob
   bound init --anthropic --with-sync --name charlie
   ```

3. Start hub host:
   ```
   bound start
   ```

4. Start peer hosts (they discover hub via sync.json):
   ```
   bound start
   ```

5. Designate official hub:
   ```
   boundctl set-hub hub-host --wait
   ```

### Emergency Operations

Pause all hosts:
```
boundctl stop
```

Resume operations:
```
boundctl resume
```

### Recovery from Corruption

Preview state before timestamp:
```
boundctl restore --before "2024-01-15T10:00:00Z" --preview
```

Execute recovery:
```
boundctl restore --before "2024-01-15T10:00:00Z"
```

---

## Environment Variables

### Anthropic

- `ANTHROPIC_API_KEY`: API key for Anthropic Claude models

If unset, the init command logs a warning but continues (API key remains empty in config).

### AWS Bedrock

Standard AWS SDK environment variables:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` (optional, for temporary credentials)
- `AWS_REGION` (optional, overrides `--region` flag)

### Bound System

- `USER`: Fallback operator name if `--name` not provided (defaults to `operator`)

---

## Exit Codes

All CLI commands use standard exit codes:

- `0`: Success
- `1`: Error (invalid arguments, initialization failure, database error, etc.)

---

## Troubleshooting

### Configuration Loading Fails

Check that `config/allowlist.json` and `config/model_backends.json` exist and are valid JSON:

```
jq . config/allowlist.json
jq . config/model_backends.json
```

### Database Connection Fails

Ensure the database path exists and is writable:

```
ls -la config/bound.db
```

If missing, run `bound start` to initialize it.

### Anthropic API Key Missing

Set the environment variable before init:

```
export ANTHROPIC_API_KEY="sk-ant-..."
bound init --anthropic
```

### Bedrock Authentication Fails

Verify AWS credentials are configured:

```
aws sts get-caller-identity
```

Ensure the region supports Claude models.

### Binary Compilation Fails

This is expected without native build tools. Use the development runner instead:

```
bun packages/cli/src/bound.ts start
bun packages/cli/src/boundctl.ts set-hub primary-host
```

---

## Configuration Reference

All configuration files live in the `config/` directory (or the path passed to `--config-dir`). The directory is `.gitignored` and ships with `.example` templates for each file.

Only `allowlist.json` and `model_backends.json` are required. All other files are optional; the orchestrator detects their absence and disables the corresponding feature rather than failing.

### allowlist.json

**Required.** Defines which users may interact with the system and which identity the web UI operates as.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `default_web_user` | string | Username that the web UI operates as. Must be a key in `users`. |
| `users` | object | Map from username to user record. |
| `users.<name>.display_name` | string | Human-readable name shown in the UI. |
| `users.<name>.discord_id` | string | Optional. Discord user ID for DM linking. |

**Example:**

```json
{
  "default_web_user": "alice",
  "users": {
    "alice": {
      "display_name": "Alice"
    },
    "bob": {
      "display_name": "Bob",
      "discord_id": "987654321098765432"
    }
  }
}
```

Users are seeded into the `users` database table with deterministic UUIDs (`UUID5(BOUND_NAMESPACE, username)`) on every startup. Seeding is idempotent. Discord IDs are optional; omit them for web-only users.

This file is never exposed to the agent sandbox. The agent cannot read, modify, or infer the allowlist contents.

---

### model_backends.json

**Required.** Defines the available LLM backends and sets the default.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `backends` | array | List of backend configuration objects. |
| `default` | string | ID of the backend to use when the user has not selected one. |
| `daily_budget_usd` | number | Optional. When daily spend (summed from `daily_summary`) crosses this value, autonomous task scheduling pauses. Interactive conversations are never blocked. Resets at midnight. |
| `budget_warn_pct` | number | Optional. Percentage of `daily_budget_usd` at which a warning advisory is generated. Default: 80. |

**Backend object fields:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier used throughout the system. Convention: `provider/model-short-name`. |
| `provider` | string | Driver. Built-in values: `ollama`, `anthropic`, `bedrock`, `openai-compatible`. |
| `model` | string | Provider-specific model identifier string. |
| `base_url` | string | API endpoint. Required for `ollama` and `openai-compatible`. |
| `api_key` | string | Auth token. Env vars are expanded at load time (`${VAR}`). Used by `anthropic` and `openai-compatible`. |
| `region` | string | AWS region. Required for `bedrock`. |
| `context_window` | number | Token count. Used for summarization triggers, context budgeting, and await result buffering. |
| `tier` | number | Integer capability ranking 1 (smallest) to 5 (most capable). Used for summary reliability assessment and `--requires model:` task routing. |
| `price_per_m_input` | number | Optional. USD per million uncached input tokens. Set to 0 for local models. |
| `price_per_m_output` | number | Optional. USD per million output tokens. |
| `price_per_m_cache_write` | number | Optional. USD per million tokens written to the prompt cache. |
| `price_per_m_cache_read` | number | Optional. USD per million tokens served from the prompt cache. |

**Example (multi-backend setup):**

```json
{
  "backends": [
    {
      "id": "ollama",
      "provider": "ollama",
      "model": "llama3",
      "base_url": "http://localhost:11434",
      "context_window": 8192,
      "tier": 3,
      "price_per_m_input": 0,
      "price_per_m_output": 0,
      "price_per_m_cache_write": 0,
      "price_per_m_cache_read": 0
    },
    {
      "id": "anthropic",
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "api_key": "${ANTHROPIC_API_KEY}",
      "context_window": 200000,
      "tier": 4,
      "price_per_m_input": 3.0,
      "price_per_m_output": 15.0,
      "price_per_m_cache_write": 3.75,
      "price_per_m_cache_read": 0.30
    },
    {
      "id": "bedrock",
      "provider": "bedrock",
      "model": "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "region": "us-east-1",
      "context_window": 200000,
      "tier": 4,
      "price_per_m_input": 3.0,
      "price_per_m_output": 15.0,
      "price_per_m_cache_write": 3.75,
      "price_per_m_cache_read": 0.30
    }
  ],
  "default": "ollama",
  "daily_budget_usd": 10.00,
  "budget_warn_pct": 80
}
```

**Example (Ollama only, generated by `bound init --ollama`):**

```json
{
  "backends": [
    {
      "id": "ollama",
      "provider": "ollama",
      "model": "llama3",
      "base_url": "http://localhost:11434",
      "context_window": 8192,
      "tier": 3
    }
  ],
  "default": "ollama"
}
```

---

### sync.json

**Optional. Required for multi-host deployments.** Per-host file that enables the sync loop and sets the initial hub target. Without this file the orchestrator runs in single-host mode; the change_log accumulates but is never consumed by sync.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `hub` | string | Name of the initial sync target, resolved against `keyring.json`. After the first sync cycle, `cluster_config.cluster_hub` (managed by `boundctl set-hub`) takes over and this field is used only as a fallback. |
| `sync_interval_seconds` | number | Polling interval in seconds. Default: 30. The orchestrator may scale this adaptively based on current activity. |
| `change_log_min_retention_hours` | number | Optional. Minimum hours to retain change_log events regardless of peer acknowledgment status. Provides a guaranteed recovery window for `boundctl restore`. Default: 24. |

**Example:**

```json
{
  "hub": "cloud-vm",
  "sync_interval_seconds": 30,
  "change_log_min_retention_hours": 24
}
```

This file is per-host and its `hub` field may differ across hosts only during initial setup. Once `boundctl set-hub` has been used, the live `cluster_config.cluster_hub` value governs topology and this file is only consulted as a bootstrapping fallback.

---

### keyring.json

**Required when sync is enabled.** Shared across all hosts in the cluster — the file must be identical on every host. Lists every host's Ed25519 public key and static URL. This is the single source of truth for cluster membership and the trust root for sync authentication.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `hosts` | object | Map from host name to host entry. |
| `hosts.<name>.public_key` | string | Ed25519 public key in the format `ed25519:<base64>`. Read from `data/host.pub` on the corresponding host. |
| `hosts.<name>.url` | string | Initial sync URL for this host. Used on first-ever sync and as fallback if the dynamic URL from the `hosts` table fails. Prefer stable hostnames (DNS, Tailscale) over raw IPs. |

**Example:**

```json
{
  "hosts": {
    "laptop": {
      "public_key": "ed25519:MCowBQYDK2VwAyEA7x8Q...",
      "url": "https://laptop.tailscale:3000"
    },
    "cloud-vm": {
      "public_key": "ed25519:MCowBQYDK2VwAyEA9f2R...",
      "url": "https://cloud.example.com"
    }
  }
}
```

**Adding a host:** add its entry to this file and copy the updated file to all hosts, then start the new host. **Revoking a host:** remove its entry, copy to all hosts, and restart the hub. The revoked host's sync requests will be rejected (403) but its local database continues to function in solo mode.

Hub migration requires no change to this file. Only `boundctl set-hub` (or `sync.json` in a dead-hub recovery) is needed.

Private key material (`data/host.key`) is auto-generated by the orchestrator on first startup and is never written to any config file.

---

### mcp.json

**Optional.** Configures MCP server connections. The orchestrator reads this file at startup and connects to each server listed. If the file is absent, no MCP tools are available.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `servers` | array | List of MCP server configuration objects. |
| `servers[].name` | string | Server identifier. Tools from this server are namespaced as `{name}-{tool}`. |
| `servers[].instance` | string | Optional. When set, the effective server name becomes `{name}-{instance}`. Use to distinguish two servers of the same type with different credentials (e.g. personal vs work GitHub). |
| `servers[].transport` | string | `stdio` or `sse`. |
| `servers[].command` | string | For `stdio` transport: the executable to spawn (e.g. `npx`). |
| `servers[].args` | array | For `stdio` transport: arguments to the command. |
| `servers[].url` | string | For `sse` transport: the SSE endpoint URL. |
| `servers[].env` | object | Environment variables to set for the server process. Values are expanded from the operator's environment (`${VAR}`). |
| `servers[].headers` | object | For `sse` transport: HTTP headers to include. Values are expanded from the environment. |
| `servers[].allow_tools` | array | Optional. If present, only the listed tool names (without the server prefix) are registered as sandbox commands. Unlisted tools are silently dropped after discovery. |
| `servers[].confirm` | array | Optional. Tool names that require interactive user confirmation before execution. Confirmed tools are blocked during autonomous tasks. |

**Example:**

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "allow_tools": ["create-issue", "list-pull-requests", "get-file-contents"],
      "confirm": ["create-issue"]
    },
    {
      "name": "slack",
      "transport": "sse",
      "url": "https://mcp.slack.example.com/sse",
      "headers": { "Authorization": "Bearer ${SLACK_TOKEN}" },
      "confirm": ["post-message", "upload-file"]
    }
  ]
}
```

**Using `instance` to distinguish servers with different credentials:**

```json
{
  "servers": [
    {
      "name": "github",
      "instance": "personal",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_PERSONAL_TOKEN}" }
    },
    {
      "name": "github",
      "instance": "work",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_WORK_TOKEN}" }
    }
  ]
}
```

This produces tool names `github-personal-create-issue` and `github-work-create-issue`, avoiding proxy routing ambiguity in multi-host clusters.

Server URLs, credentials, and transport details are never exposed to the agent sandbox.

---

### overlay.json

**Optional.** Mounts host-local directories into the agent's virtual filesystem under `/mnt/<host-name>/`. The agent can read files from these mounts to understand codebases and documents. The overlay is read-only from the agent's perspective.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `mounts` | object | Map from mount name to mount configuration. |
| `mounts.<name>.path` | string | Absolute path on the host filesystem to mount. |

**Example:**

```json
{
  "mounts": {
    "projects": {
      "path": "/home/alice/projects"
    }
  }
}
```

Files under the mounted path are indexed into `overlay_index` and accessible to the agent at `/mnt/<hostname>/projects/...`. A background scanner keeps the index current. Auto-cached overlay files have a separate configurable budget from the agent's own workspace (default: 200 MB) with LRU eviction.

---

### network.json

**Optional.** Controls the sandbox runtime's outbound `curl` access. Without this file all outbound network calls from within the sandbox are blocked. MCP tool calls are not affected (they run outside the sandbox).

**Schema:**

| Field | Type | Description |
|---|---|---|
| `allowedUrlPrefixes` | array | URL prefixes the agent's `curl` may connect to. |
| `allowedMethods` | array | HTTP methods permitted. |
| `transform` | array | Credential injection rules. The orchestrator injects headers before the request leaves the sandbox so secrets are never visible to the agent. |
| `transform[].url` | string | URL prefix to apply the transform to. |
| `transform[].headers` | object | Headers to inject. Values are expanded from the operator's environment. |

**Example:**

```json
{
  "allowedUrlPrefixes": [
    "https://api.example.com"
  ],
  "allowedMethods": ["GET", "HEAD", "POST"],
  "transform": [
    {
      "url": "https://api.example.com",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" }
    }
  ]
}
```

---

### cron_schedules.json

**Optional.** Operator-defined scheduled tasks seeded into the `tasks` table at startup. Tasks are created with deterministic UUIDs (`UUID5(BOUND_NAMESPACE, "name|expression")`) so seeding is idempotent across restarts.

**Schema:**

Each key in the object is a task name. The value is a task configuration object.

| Field | Type | Description |
|---|---|---|
| `schedule` | string | Cron expression (5-field). |
| `thread` | string | Optional. Name of the thread to post results to. |
| `payload` | object | Optional. JSON payload passed to the agent loop as the task directive. |
| `template` | array | Optional. Shell commands to execute without an LLM call. Variables assigned in earlier commands are available in later ones. If any command exits non-zero the task is marked failed. |
| `requires` | string | Optional. Comma-separated list of MCP server names, model specifiers (`model:claude-opus-4`), or host pins (`host:laptop`) required to claim this task. |
| `model_hint` | string | Optional. Preferred backend ID for the agent loop. |
| `no_quiescence` | boolean | Optional. If true, runs at the configured frequency regardless of user activity level. Use for production-critical monitoring. |

**Example:**

```json
{
  "daily_standup": {
    "schedule": "0 9 * * 1-5",
    "thread": "Daily Standup",
    "payload": {
      "action": "summarize_overnight_activity"
    },
    "requires": "github,slack"
  },
  "hourly_ci_check": {
    "schedule": "0 * * * *",
    "thread": "CI Monitoring",
    "requires": "github",
    "no_quiescence": true,
    "payload": {
      "action": "check_failing_builds"
    }
  },
  "weekly_pipeline": {
    "schedule": "0 9 * * 1",
    "thread": "Weekly Report",
    "template": [
      "T1=$(schedule --quiet --no-history --in 0s --requires github --payload '{\"repo\":\"acme/frontend\"}')",
      "T2=$(schedule --quiet --no-history --in 0s --requires github --payload '{\"repo\":\"acme/backend\"}')",
      "schedule --after $T1,$T2 --requires slack --payload '{\"action\":\"post_weekly_summary\"}'"
    ]
  }
}
```

---

### discord.json

**Optional.** Enables the Discord bot module. The bot listens for direct messages from users whose `discord_id` appears in `allowlist.json`. Non-allowlisted senders are silently ignored.

**Schema:**

| Field | Type | Description |
|---|---|---|
| `bot_token` | string | Discord bot token. Expanded from environment (`${DISCORD_BOT_TOKEN}`). |
| `host` | string | Name of the host that should run the Discord bot. Only one host activates the bot; others ignore this config even if the file is present. Should be an always-online host. |

**Example:**

```json
{
  "bot_token": "${DISCORD_BOT_TOKEN}",
  "host": "cloud-vm"
}
```

---

### persona.md

**Optional.** A Markdown file that defines the agent's identity, voice, role, and behavioral guidelines. The persona is injected into the stable orientation block at context assembly time and cached across turns.

The agent cannot read the raw file content (it is held in orchestrator memory, outside the sandbox trust boundary). Without this file the agent uses the model's default behavior.

There is no fixed schema. The file is free-form Markdown. A typical persona might cover:

- The agent's name and role description
- Communication style and tone guidelines
- Domain expertise or focus areas
- Behavioral boundaries and things the agent should or should not do
- How the agent should handle ambiguous requests

**Example (`config/persona.md`):**

```markdown
You are Aria, a technical assistant for the Acme engineering team.

You are direct, concise, and prefer concrete examples over abstract explanations.
You have deep familiarity with the team's codebase and processes.

When summarizing pull requests, lead with the business impact before the technical details.
When a task fails, acknowledge it plainly and propose a next step rather than apologizing at length.

You do not speculate about information you do not have. If you are unsure, say so.
```
