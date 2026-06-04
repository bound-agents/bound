# Configuration Reference

Every file bound reads from its config directory (default `./config`, override with
`--config-dir`), field by field. The schemas are the source of truth — see
`packages/shared/src/config-schemas.ts`. Every schema is **strict**: unknown keys fail
the parse loudly at startup with the offending key name, so a typo is a hard error, not a
silent default. Add a field to the Zod schema before you use it.

The [README config-file table](../README.md#config-files) is the one-line-per-file index;
this is where the per-field detail lives.

| File | Required | Purpose |
|------|----------|---------|
| [`allowlist.json`](#allowlistjson) | Yes | Who may talk to the agent |
| [`model_backends.json`](#model_backendsjson) | Yes | LLM backends, routing, pricing, caching |
| [`network.json`](#networkjson) | No | Outbound HTTP allowlist for the sandbox |
| [`platforms.json`](#platformsjson) | No | Platform connectors (Discord, etc.) |
| [`sync.json`](#syncjson) | No | Hub URL, relay, WebSocket sync tuning |
| [`keyring.json`](#keyringjson) | No | Per-host identity keys (auto-populated) |
| [`mcp.json`](#mcpjson) | No | MCP server connections |
| [`overlay.json`](#overlayjson) | No | Codebase mount points |
| [`cron_schedules.json`](#cron_schedulesjson) | No | Recurring + heartbeat task definitions |
| [`memory.json`](#memoryjson) | No | Pinned-memory caps |
| `persona.md` | No | Custom system-prompt personality (free-form Markdown, no schema) |

---

## `allowlist.json`

The guest list. Anyone not here cannot interact with the agent.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `default_web_user` | string (non-empty) | — | The user id assumed for unauthenticated web-UI sessions. **Must** be a key in `users`. |
| `users` | map<id, user> | — | At least one user required. Key is the user id; value is the user entry below. |

**User entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `display_name` | string (non-empty) | — | Human-readable name. |
| `platforms` | map<string, string> | absent | Per-platform identity, e.g. `{ "discord": "<discord-user-id>" }`. |

> `discord_id` was removed. Use `platforms.discord` instead — the old key now fails the parse with a pointer to the replacement.

---

## `model_backends.json`

The LLM backends and how inference routes across them. An **empty `backends` array is
valid** for a hub-only node that relays all inference to spokes; in that case `default`
must be `""`.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `backends` | array<backend> | — | The backends this host can serve locally. May be empty (hub-only). |
| `default` | string | `""` | Backend `id` used when a turn names no model. Must reference a real backend, or be `""` when `backends` is empty. |
| `daily_budget_usd` | number ≥ 0 | absent | Optional soft daily spend ceiling. |
| `cache_warming` | cache-warming block | absent | Cluster-level cache-warming driver toggle (see below). |

**Backend entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `id` | string (non-empty) | — | Logical alias you route to (e.g. `"opus"`). Distinct from `model`. |
| `provider` | enum | — | One of `ollama`, `bedrock`, `anthropic`, `openai-compatible`, `cerebras`, `zai`. |
| `model` | string (non-empty) | — | Provider-specific identifier (model name or Bedrock ARN). |
| `base_url` | url | absent | **Required** for `ollama` and `openai-compatible`. |
| `api_key` | string | absent | **Required** for `cerebras`, `anthropic`, `zai`. |
| `region` | string | absent | AWS region (Bedrock). |
| `profile` | string | absent | AWS profile name (Bedrock). |
| `context_window` | int > 0 | — | Token budget bound for context assembly. |
| `tier` | int 1–5 | — | Capability/cost tier; used by tier-based model hints. |
| `price_per_m_input` | number ≥ 0 | `0` | USD per million non-cached input tokens. |
| `price_per_m_output` | number ≥ 0 | `0` | USD per million output tokens. |
| `price_per_m_cache_write` | number ≥ 0 | absent | USD per million cache-write tokens. |
| `price_per_m_cache_read` | number ≥ 0 | absent | USD per million cache-read tokens. |
| `capabilities` | capabilities override | absent | Force capability flags (see below). |
| `thinking` | thinking config | absent | Extended-thinking / reasoning config (see below). |
| `effort` | enum | absent | Reasoning depth: `low`, `medium`, `high`, `xhigh`, `max`. Replaces `budget_tokens` on Opus 4.7; `xhigh` recommended for agentic work, `max` is Opus-tier only. |
| `max_output_tokens` | int > 0 | absent | Per-backend cap on output tokens. Use when a model rejects the 16384 default (e.g. Nova Pro caps at 10000). Applied as `min(this, default)`, so lowering is always safe. |
| `cache_ttl` | enum `5m`\|`1h` | absent (`5m`) | Prompt-cache TTL hint. `1h` is extended TTL (Bedrock: Claude Opus/Sonnet/Haiku 4.5+ only); silently falls back to `5m` where unsupported. |
| `cache_warming` | cache-warming block | absent | Per-backend cache-warming (see below). Absent means this backend is never warmed. |

**Capabilities override** (`capabilities`) — all fields optional booleans except
`max_context`; set only to override the driver's autodetected defaults:
`streaming`, `tool_use`, `system_prompt`, `prompt_caching`, `vision` (bool),
`max_context` (int > 0).

**Thinking config** (`thinking`) — either the literal `true` (legacy shorthand), or an
object:

| Field | Type | Meaning |
|-------|------|---------|
| `type` | `enabled`\|`adaptive` | `enabled` + `budget_tokens` is the legacy fixed-budget shape (removed on Opus 4.7); `adaptive` lets the model decide, with depth set by the backend's `effort`. |
| `budget_tokens` | int > 0 | Legacy fixed thinking budget. Rejected (400) on Opus 4.7. |
| `display` | `omitted`\|`summarized` | Opt into visible reasoning text on Opus 4.7 (default `omitted`). |

**Cache-warming block** (`cache_warming`, issue #10) — opt-in periodic "warm poke" that
keeps the prompt cache hot on active threads so the next real message lands on a
cache-read instead of a cache-write. Off by default.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `false` | Master toggle. |
| `max_pokes` | int ≥ 0 | `3` | Pokes per thread since its last real activity. The load-bearing economic control — break-even scales with the cache-write/read price ratio, so cheap-read backends tolerate more pokes. `0` disables warming on this backend even with `enabled: true`. |

The poke *window* is not configured — it is derived per-thread from that thread's backend
`cache_ttl` (a poke fires only when the cache would otherwise lapse before the next scan).

---

## `network.json`

Outbound HTTP allowlist for sandboxed code. Absent means no outbound HTTP path.

| Field | Type | Meaning |
|-------|------|---------|
| `allowedUrlPrefixes` | array<string> | URL prefixes the sandbox may fetch. |
| `allowedMethods` | array<string> | HTTP methods permitted. |
| `transform` | array<{ url, headers }> | Optional per-URL header injection (e.g. auth headers). `headers` is a string→string map. |

---

## `platforms.json`

Platform connectors. Each is an in-process MCP server; only the leader host runs active
subscriptions, with failover to standbys.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `connectors` | array<connector> | — | The configured connectors. |

**Connector entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `platform` | string (non-empty) | — | Platform name, e.g. `discord`. |
| `token` | string | absent | Bot token / credential. |
| `signing_secret` | string | absent | Webhook signing secret. |
| `allowed_users` | array<string> | `[]` | Platform user ids permitted to reach the agent on this connector. |
| `leadership` | enum | `auto` | `auto`, `leader`, `standby`, or `all` — this host's role in leader election. |
| `failover_threshold_ms` | int > 0 | `30000` | How long a leader may be silent before a standby takes over. |

---

## `sync.json`

Multi-host sync. Absent means single-host.

| Field | Type | Meaning |
|-------|------|---------|
| `hub` | string (non-empty) | Hub host name this node syncs to. Absent on the hub itself. |
| `relay` | relay block | Inference-relay tuning (see below). |
| `ws` | ws block | WebSocket sync tuning (see below). |

**`relay` block:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `true` | Relay inference between hosts. |
| `max_payload_bytes` | int > 0 | `2097152` (2 MiB) | Max relay frame size. |
| `request_timeout_ms` | int > 0 | `30000` | Non-inference relay request timeout. |
| `prune_interval_seconds` | int > 0 | `60` | How often to prune relay tables. |
| `prune_retention_seconds` | int > 0 | `300` | How long delivered relay rows are retained. |
| `drain_timeout_seconds` | int > 0 | `120` | Graceful-drain budget on shutdown. |
| `inference_timeout_ms` | int > 0 | `300000` (5m) | Per-host inference-streaming timeout. Must cover sync-delivery latency + LLM time. |

**`ws` block:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `backfill_interval` | int ≥ 0 | `300` | Seconds between backfill reconciliation passes. |
| `backpressure_limit` | int > 0 | `2097152` | Buffered-bytes ceiling before applying backpressure. |
| `idle_timeout` | int > 0 | `120` | Seconds before an idle WS connection is closed. |
| `reconnect_max_interval` | int > 0 | `60` | Max seconds between reconnect attempts (backoff ceiling). |

---

## `keyring.json`

Per-host identity keys for sync trust. **Auto-populated** — you usually don't hand-edit
this.

| Field | Type | Meaning |
|-------|------|---------|
| `hosts` | map<host-name, { public_key, url }> | Each known host's Ed25519 `public_key` (non-empty string) and `url` (sync endpoint). |

---

## `mcp.json`

MCP server connections. Tools from connected servers are auto-registered as agent
commands.

| Field | Type | Meaning |
|-------|------|---------|
| `servers` | array<server> | Discriminated on `transport`. |

**Common to every server:** `name` (non-empty string), `allow_tools` (optional
array<string> allowlist), `confirm` (optional array<string> of tools that require
confirmation).

**`transport: "stdio"`:** `command` (non-empty string), `args` (optional array<string>),
`env` (optional string→string map).

**`transport: "http"`:** `url` (url), `headers` (optional string→string map).

Unknown keys on one transport do not slip through via the other — each variant is strict
independently.

---

## `overlay.json`

Codebase mount points exposed to the agent's virtual filesystem.

| Field | Type | Meaning |
|-------|------|---------|
| `mounts` | map<string, string> | Mount name → host filesystem path. |

---

## `cron_schedules.json`

Recurring tasks. The `heartbeat` key is special (the agent's maintenance loop); every
other key defines a named cron entry. The schema is closed-by-shape: any non-`heartbeat`
key must match the cron-entry shape.

**`heartbeat`:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `true` | Run the heartbeat at all. |
| `interval_ms` | int ≥ 60000 | `1800000` (30m) | Heartbeat cadence. Floor is 60s. |
| `model_hint` | string | absent | Model to run the heartbeat on. |

**Any other key (a named cron entry):**

| Field | Type | Meaning |
|-------|------|---------|
| `schedule` | string (non-empty) | Cron expression. |
| `thread` | string | Optional thread id to run in. |
| `payload` | string | Optional task payload (the instructions). |
| `template` | array<string> | Optional payload template lines. |
| `requires` | array<string> | Optional task dependencies. |
| `model_hint` | string | Optional model to run on. |

---

## `memory.json`

Pinned-memory caps — a context-management control. Absent means the defaults below apply
(the enforcement code falls back to the same numbers).

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `pinned_count_cap` | int ≥ 1 | `10` | Max number of pinned memory entries. |
| `pinned_size_cap` | int ≥ 1 | `2000` | Max characters per pinned entry. |

---

## `persona.md`

Free-form Markdown folded into the system prompt as personality. No schema, no fields —
whatever you write is the voice.
