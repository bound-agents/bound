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
| [`cron_schedules.json`](#cron_schedulesjson) | — | Removed — use the `task` tool for recurring tasks |
| [`memory.json`](#memoryjson) | No | Pinned-memory caps |

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
| `provider` | enum | — | One of `ollama`, `bedrock`, `bedrock-mantle`, `anthropic`, `openai-compatible`, `cerebras`, `zai`, `opencode-go`. |
| `model` | string (non-empty) | — | Provider-specific identifier (model name or Bedrock ARN). For `bedrock-mantle`, the mantle model id (e.g. `openai.gpt-5.4`). |
| `base_url` | url | absent | **Required** for `ollama` and `openai-compatible`. Optional override for `bedrock-mantle` (default is derived from `region`). |
| `api_key` | string | absent | **Required** for `cerebras`, `anthropic`, `zai`, `opencode-go`. Unused by `bedrock-mantle` (auth is AWS SigV4, not a bearer token). |
| `region` | string | absent | AWS region (Bedrock, and **required** for `bedrock-mantle` — the mantle endpoint host is region-scoped). |
| `profile` | string | absent | AWS profile name (Bedrock and `bedrock-mantle`; falls back to the ambient credential chain when absent). |
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
| `connect_timeout_ms` | int > 0 | absent (off) | Connect / time-to-first-byte deadline. If response headers don't arrive within this window the request aborts with a self-identifying error instead of the opaque transport `TimeoutError`. Headers-scoped only — a slow-but-progressing stream is governed by the agent-loop silence timeout, not this. Applied on whichever host runs the fetch (not forwarded over the relay). Absent → no deadline; set generously (TTFB on a 200k-token prompt can run tens of seconds) and lower it only to fail-fast-and-retry sooner. |
| `additional_headers` | map (string→string) | absent | Arbitrary custom HTTP headers added to every request to the upstream endpoint, layered on top of the provider's own headers (the `api_key`-derived `Authorization` is applied first, so a header here can't silently clobber auth unless it names `Authorization` itself). Currently honored by the OpenAI-compatible-shim providers (`openai-compatible`, `cerebras`, `zai`). Applied on whichever host runs the fetch (not forwarded over the relay), so a spoke uses its own headers rather than a hub-set set. Absent → no extra headers. |

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

**MCP Apps.** When an `http`/`sse` server advertises the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
`io.modelcontextprotocol/ui` capability, its UI-bearing tool results render inline as
interactive apps in the web UI. There is no separate config: app-bearing servers are
discovered by joining `mcp.json` against the synced capability inventory (captured at
connect time), and the web router serves the browser-reachable subset via
`GET /api/mcp-apps`. The agent still calls these tools server-side as normal; the browser
is purely a renderer (it reads the server's `ui://` resources and routes the app's
callbacks), never a second tool provider.

---

## `overlay.json`

Codebase mount points exposed to the agent's virtual filesystem.

| Field | Type | Meaning |
|-------|------|---------|
| `mounts` | map<string, string> | Mount name → host filesystem path. |

---

## `cron_schedules.json`

Removed. Recurring tasks are created at runtime through the agent's `task` tool
(`schedule` action with a `cron` expression), which writes `tasks` rows directly —
the file's per-task seeding was redundant with that path. The agent heartbeat is now
a system-managed, uncancellable task seeded at a fixed cadence with no config surface.

---

## `memory.json`

Pinned-memory caps — a context-management control. Absent means the defaults below apply
(the enforcement code falls back to the same numbers).

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `pinned_count_cap` | int ≥ 1 | `10` | Max number of pinned memory entries. |
| `pinned_size_cap` | int ≥ 1 | `2000` | Max characters per pinned entry. |

---

## `persona`

The cluster-wide operator persona — free-form Markdown folded into the system prompt as
personality. No schema, no fields — whatever you write is the voice.

The persona is **not** a config file. It lives as a single synced `cluster_config['persona']`
row, set after initialization with `boundctl set-persona` (from a file or stdin) or the web
UI's Persona view. There is no `persona.md` seed; a fresh install starts with no persona and
uses the model's default behavior until you set one. The value is a single global row that
replicates to every host (so a turn relayed elsewhere renders the same voice) and is read
live at context-assembly time — no cache, no reload signal. Capped at 64 KB.

```bash
boundctl set-persona --file my-persona.md
cat my-persona.md | boundctl set-persona
```
