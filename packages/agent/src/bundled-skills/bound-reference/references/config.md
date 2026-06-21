# Config Reference

Configuration is **operator-owned host state**, deliberately kept out of the
sandbox VFS. This is the single most common orientation mistake: reaching for
`bms_read` or `bms_bash` to inspect config and finding nothing, because config does not
live where your file tools look. It lives on the host's real disk in a `config/`
directory, is loaded into memory once at startup, and is guarded by strict
schemas.

## Where it lives

The `config/` directory sits on the host filesystem, defaulting to `./config`
relative to the process working directory (`--config-dir` overrides it; data
defaults to `./data`, `--data-dir` overrides). It is created by `bound init`. Its
contents are **not** VFS paths — `read("/config/...")` or `bash cat config/...`
inside the sandbox will not reach them. On a boundless thread you can read the
real files with `boundless_read` against the host checkout, but for reasoning
about *running* behavior, the loaded config is what matters, not the file on disk.

## The files

| File | Required | Holds |
|------|----------|-------|
| `allowlist.json` | yes | users allowed to interact with the agent |
| `model_backends.json` | yes | LLM backend configuration |
| `platforms.json` | no | platform connector config (e.g. Discord bot token, MCP server settings) |
| `sync.json` | no | hub URL, sync interval, relay + WS settings |
| `keyring.json` | no | per-host identity keys (auto-populated) |
| `mcp.json` | no | MCP server connections (stdio or http transport) |
| `overlay.json` | no | codebase mount points (drives the sandbox overlays) |
| `memory.json` | no | pinned-memory caps (`pinned_count_cap`, `pinned_size_cap`) |

## Schemas are strict — unknown keys fail loudly

Every schema in `configSchemaMap`
(`packages/shared/src/config-schemas.ts`) is declared `.strict()`, so an unknown
key fails the parse at startup rather than being ignored. The practical
consequence: **a new config field must be declared in the Zod schema before it can
be used**, or the loader rejects the whole file and the process will not come up.
This is invariant #13.

## How config reaches you

At startup `createAppContext(configDir, dbPath)` loads and validates the files
into `AppContext.config` (required) and `AppContext.optionalConfig` (the rest).
From there it flows to wherever it is needed — model routing reads
`model_backends.json` via `toRouterConfig()`, platform connectors read
`platforms.json`, and so on. You
never parse config yourself; you observe its *effects* (which models resolve,
which connectors are up).

`config-reload` exists as an operator command to re-read config without a full
restart for the subset of fields that support it. Identity keys in `keyring.json`
and the Ed25519 host keypair (`data/host.key` / `data/host.pub`) are
auto-generated and not something you edit.

## Config vs the sandbox — the mental model

- **Sandbox VFS** (`files` table, synced): your writable workspace. Database-backed,
  replicates across hosts, reachable with `bms_read`/`bms_write`/`bms_edit`/`bms_bash`.
- **Config** (`config/` on host disk, loaded into `AppContext`): operator-owned
  inputs that shape how bound runs. Not in the VFS, not reachable with your file
  tools, strict-schema validated, changed by the operator and (for some fields)
  `config-reload`.
- **`cluster_config` table** (synced): a *different* thing from the `config/`
  files despite the name — it holds runtime cluster state like the platform-leader
  pointer and emergency stop/resume flags, written through the outbox, not loaded
  from disk.

When a request references an operational setting (a model, a Discord token, a cron
schedule, a mount point), the answer is in the loaded config or the config files on
the operator's host — not in the sandbox, and not something to ask the operator for
if you can read the host checkout.
