---
title: Configuration reference
description: Fields, defaults, validation rules, and selected examples for Bound configuration files.
---

This reference lists Bound's host-local configuration files, their fields, defaults, and
validation rules. Bound reads these files from `./config` by default. Use `--config-dir` to
select another directory. The schemas are the source of truth; see
[`packages/shared/src/config-schemas.ts`](https://github.com/bound-agents/bound/blob/main/packages/shared/src/config-schemas.ts).
Every file schema is strict, so startup rejects unknown keys instead of ignoring them.

## Scope and propagation

Use this legend to distinguish files and secrets that stay on one host from state that
replicates or belongs to a single request or thread.

| Scope | Meaning | Entries on this page |
| --- | --- | --- |
| **Host-local file** | Read from one host's configuration directory. It does not become cluster control state merely because hosts can sync other data. Secrets in these files remain part of that host's configuration. | `allowlist.js` / `allowlist.json`, `model_backends.js` / `model_backends.json`, `network.js` / `network.json`, `platforms.js` / `platforms.json`, `sync.js` / `sync.json`, `keyring.js` / `keyring.json`, `mcp.js` / `mcp.json`, `memory.js` / `memory.json` |
| **Replicated control state** | Stored outside the configuration-file set and replicated to hosts. | [`persona`](#persona) |
| **Per-thread or client-local concept** | Selected or derived for a thread, turn, or client rather than defined as replicated cluster control state. | Per-thread backend cache windows and per-call model effort |

Unless a field description explicitly says otherwise, a file entry configures the host that
reads it. For example, the precedence-selected model backends config lists backends that the host can serve locally,
and fetch-specific headers apply on the host that performs the fetch.

## Duration fields

Every `*_timeout_ms` / `*_threshold_ms` field accepts either a millisecond
number or an ISO 8601 duration string, and both resolve to the same value:

```json
{ "inference_timeout_ms": 300000 }
{ "inference_timeout_ms": "PT5M" }
```

`PT30S`, `PT5M`, `PT1H30M`, and `PT0.5S` all parse. Existing numeric configs are
unaffected — the string is a spelling of the number, not a separate mode.

Durations carrying days or larger (`P1D`, `P2W`, `P1M`) are rejected: a day is
23, 24, or 25 hours across a DST boundary, so converting one needs a calendar
reference the config layer has no way to supply. Write `PT24H` when you mean 24
hours. Negative durations and sub-millisecond precision are rejected too.

Fields documented as `int >= 0` keep `0` as their disabled sentinel; `PT0S`
works there as well.

## Configuration files

| File | Required | Purpose |
|------|----------|---------|
| [`allowlist.js` / `allowlist.json`](#allowlistjs--allowlistjson) | Yes | Who may talk to the agent |
| [`model_backends.js` / `model_backends.json`](#model_backendsjs) | Yes | LLM backends, routing, pricing, caching |
| [`network.js` / `network.json`](#networkjs--networkjson) | No | Outbound HTTP policy for sandbox and just-bash execution |
| [`platforms.js` / `platforms.json`](#platformsjs--platformsjson) | No | Platform connectors (Discord, etc.) |
| [`sync.js` / `sync.json`](#syncjs--syncjson) | No | Hub URL, relay, WebSocket sync tuning |
| [`keyring.js` / `keyring.json`](#keyringjs--keyringjson) | No | Per-host identity keys (auto-populated) |
| [`mcp.js` / `mcp.json`](#mcpjs--mcpjson) | No | MCP server connections |
| [`memory.js` / `memory.json`](#memoryjs--memoryjson) | No | Pinned-memory caps |

---

## JavaScript alternatives

Every operator config supports a JavaScript alternative: `allowlist.js`, `model_backends.js`, `network.js`, `platforms.js`, `sync.js`, `keyring.js`, `mcp.js`, and `memory.js`. When both forms exist, Bound selects `.js`; it never falls back to JSON after a selected JavaScript file fails to evaluate or validate. This keeps a broken override visible and makes startup/reload transactional: the previous loaded configuration remains active on a hot reload.

A JavaScript file is an ESM-like module that `export default`s one object. Comments and helper declarations (for example a shared pricing function assigned to a `const`) may precede the export. Bound evaluates it in a bounded QuickJS runtime, expands `${NAME}` and `${NAME:-default}` strings, then applies the same strict Zod schema as JSON. JavaScript is configuration, not a general plugin surface: `model_backends.js` alone may contain `backend.price(turn)` callbacks; all other config values must be data.

## `allowlist.js` / `allowlist.json`

Maps Bound users to identities on supported platforms.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `default_web_user` | string (non-empty) | — | The user id assumed for unauthenticated web-UI sessions. **Must** be a key in `users`. |
| `users` | map&lt;id, user&gt; | — | At least one user required. Key is the user id; value is the user entry below. |

**User entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `display_name` | string (non-empty) | — | Human-readable name. |
| `platforms` | map&lt;string, string&gt; | absent | Identifies this Bound user on each platform, e.g. `{ "discord": "<discord-user-id>" }`. This is independent of connector-local `platforms.json` filtering. |

> `discord_id` was removed. Use `platforms.discord` instead; the old key fails validation.

---

## `model_backends.js`

Bound first loads `model_backends.js` when it exists; otherwise it loads the legacy `model_backends.json`. The JavaScript form is an ESM-like module that `export default`s the LLM backends and routing configuration and runs in Bound's bounded QuickJS evaluator. Only the JavaScript form permits a backend `price(turn)` callback; JSON remains strict static configuration. Both forms reject undeclared fields through the same strict schema.

The LLM backends and how inference routes across them. An **empty `backends` array is
valid** for a hub-only node that relays all inference to spokes; in that case `default`
must be `""`.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `backends` | array&lt;backend&gt; | — | The backends this host can serve locally. May be empty (hub-only). |
| `default` | string | `""` | Backend `id` used when a turn names no model. Must reference a real backend, or be `""` when `backends` is empty. |
| `daily_budget_usd` | number ≥ 0 | absent | Optional soft daily spend ceiling. |

**Backend entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `id` | string (non-empty) | — | Logical alias you route to (e.g. `"opus"`). Distinct from `model`. |
| `provider` | enum | — | One of `ollama`, `bedrock`, `bedrock-mantle`, `anthropic`, `openai-compatible`, `cerebras`, `zai`, `opencode-go`, `umans`. |
| `model` | string (non-empty) | — | Provider-specific identifier (model name or Bedrock ARN). For `bedrock-mantle`, the Mantle model id for the selected `provider_mode` (for example, `openai.gpt-5.4` or `anthropic.claude-sonnet-5`). **Omitted for `umans`** (the model lineup is fetched at runtime — see below). |
| `provider_mode` | enum `anthropic`\|`openai_responses` | — | Required for `bedrock-mantle`. Selects the Mantle protocol surface: Anthropic Messages (`/anthropic/v1/messages`) or OpenAI Responses (`/openai/v1/responses`). |
| `base_url` | url | absent | **Required** for `ollama` and `openai-compatible`. Optional override for `bedrock-mantle` (default is derived from `region` and `provider_mode`) and `umans` (default `https://api.code.umans.ai`). |
| `api_key` | string | absent | **Required** for `cerebras`, `anthropic`, `zai`, `opencode-go`, `umans`. Unused by `bedrock-mantle` (auth is AWS SigV4, not a bearer token). |
| `region` | string | absent | AWS region (Bedrock, and **required** for `bedrock-mantle` — the mantle endpoint host is region-scoped). |
| `profile` | string | absent | AWS profile name (Bedrock and `bedrock-mantle`; falls back to the ambient credential chain when absent). |
| `context_window` | int > 0 | — | Token budget bound for context assembly. **Omitted for `umans`** (fetched per-model). |
| `tier` | int 1–5 | — | Capability/cost tier; used by tier-based model hints. **Omitted and rejected for `umans`.** |
| `price_per_m_input` | number ≥ 0 | `0` | USD per million non-cached input tokens. |
| `price_per_m_output` | number ≥ 0 | `0` | USD per million output tokens. |
| `price_per_m_cache_write` | number ≥ 0 | absent | USD per million cache-write tokens. |
| `price_per_m_cache_read` | number ≥ 0 | absent | USD per million cache-read tokens. |
| `price` | function | absent | Optional `price(turn)` callback returning this turn’s USD cost. It runs in the bounded evaluator and receives the turn's usage and static prices. Candidate evaluation and validation errors reject startup or reload; an error in a runtime-only branch falls back to static pricing. When `price` is set, the static `price_per_m_*` fields may be omitted entirely — they default to `0` and only matter as the fallback when the callback fails. |
| `capabilities` | capabilities override | absent | Force capability flags (see below). |
| `thinking` | thinking config | absent | Extended-thinking / reasoning config (see below). |
| `effort` | string (non-empty) | absent | Provider-validated reasoning depth. Common Anthropic and Bedrock Converse values are `low`, `medium`, `high`, `xhigh`, and `max`; other providers may support different values. |
| `max_output_tokens` | int > 0 | absent | Per-backend output-token cap, applied as the lower of this value and the default limit. |
| `cache_ttl` | enum `5m`\|`1h` | absent (`5m`) | Prompt-cache TTL hint. Unsupported `1h` hints fall back to `5m`. |
| `cache_warming` | cache-warming block | absent | Per-backend cache warming (see below). Absent disables warming for this backend. |
| `connect_timeout_ms` | int > 0 | absent (off) | Deadline for receiving response headers. It applies on the host making the request and is not forwarded over the relay; streaming after headers uses separate timeout handling. |
| `additional_headers` | map (string→string) | absent | Extra upstream HTTP headers for `openai-compatible`, `cerebras`, and `zai`. They apply on the host making the request and may override a same-named provider header, including `Authorization`. |

**Capabilities override** (`capabilities`) — all fields optional booleans except
`max_context`; set only to override the driver's autodetected defaults:
`streaming`, `tool_use`, `system_prompt`, `prompt_caching`, `vision` (bool),
`max_context` (int > 0).

**Thinking config** (`thinking`) — either the literal `true` (legacy shorthand), or an
object:

| Field | Type | Meaning |
|-------|------|---------|
| `type` | `enabled`\|`adaptive`\|`tool` | `enabled` + `budget_tokens` is the legacy fixed-budget shape (removed on Opus 4.7); `adaptive` lets the model decide, with depth set by the backend's `effort`. `tool` disables the provider's native reasoning and exposes Bound's optional `think({ thought })` scratchpad tool instead. |
| `budget_tokens` | int > 0 | Legacy fixed thinking budget. Rejected (400) on Opus 4.7; incompatible with `adaptive` and `tool`. |
| `display` | `omitted`\|`summarized` | Opt into visible reasoning text on Opus 4.7 (default `omitted`); incompatible with `enabled` and `tool`. |

`tool` mode cannot set `effort`. It emits `Thinking complete - please continue your work.` after a `think` call and does not require the model to invoke that tool.

**Cache-warming block** (`cache_warming`) — opt-in periodic "warm poke" that
keeps the prompt cache hot on active threads so the next real message lands on a
cache-read instead of a cache-write. Off by default.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `false` | Master toggle. |
| `max_pokes` | int ≥ 0 | `3` | Maximum pokes per thread since its last real activity. `0` disables warming on this backend even with `enabled: true`. |

The poke *window* is not configured — it is derived per-thread from that thread's backend
`cache_ttl` (a poke fires only when the cache would otherwise lapse before the next scan).

### Price callback

Put dynamic pricing beside the backend it prices. For example, cache reads can receive a different rate:

```js
export default {
  backends: [
    {
      id: "example",
      provider: "openai-compatible",
      model: "example-model",
      base_url: "https://api.example.com/v1",
      context_window: 128000,
      tier: 3,
      price(turn) {
        return (turn.usage.inputTokens * 2 + turn.usage.outputTokens * 8) / 1_000_000;
      },
    },
  ],
  default: "example",
};
```

### umans.ai

A minimal `umans` backend entry contains `provider`, `id`, and `api_key`. The top-level
`default` field is a sibling of `backends` and names the entry's `id`; it is not a backend
entry field.

```js
export default {
  backends: [{ provider: "umans", id: "umans", api_key: "sk-…" }],
  default: "umans",
};
```

Do not set `model`, `tier`, `context_window`, `capabilities`, or nondefault pricing fields
on a `umans` entry; they are rejected. Other generic optional backend fields may be
accepted by the schema. Set up with `bound init --umans` (reads `UMANS_API_KEY`).

---

## `network.js` / `network.json`

Outbound HTTP policy for sandbox and just-bash egress. It does not control Bound's own
provider, sync, platform, or MCP clients. When this file is absent, those clients are not
globally denied.

| Field | Type | Meaning |
|-------|------|---------|
| `allowedUrlPrefixes` | array&lt;string&gt; | URL prefixes the sandbox may fetch. |
| `allowedMethods` | array&lt;string&gt; | HTTP methods permitted. |
| `transform` | array&lt;{ url, headers }&gt; | Optional per-URL header injection (e.g. auth headers). `headers` is a string→string map. |

---

## `platforms.js` / `platforms.json`

Platform connectors. Each is an in-process MCP server; only the leader host runs active
subscriptions, with failover to standbys.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `connectors` | array&lt;connector&gt; | — | The configured connectors. |

**Connector entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `platform` | string (non-empty) | — | Platform name, e.g. `discord`. |
| `token` | string | absent | Bot token / credential. |
| `signing_secret` | string | absent | Webhook signing secret. |
| `allowed_users` | array&lt;string&gt; | `[]` | Connector-local platform user filter, independent of `allowlist.json` identity mapping. For Discord, this filters DMs and interactions; it is not documented as guild-channel author gating. |
| `leadership` | enum | `auto` | `auto`, `leader`, `standby`, or `all` — this host's role in leader election. |
| `failover_threshold_ms` | int > 0 | `30000` | How long a leader may be silent before a standby takes over. |

---

## `sync.js` / `sync.json`

Multi-host sync. Absent means single-host.

| Field | Type | Meaning |
|-------|------|---------|
| `hub` | string (non-empty) | Reachable WebSocket URL of the hub this spoke syncs to. Absent on the hub itself. |
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
| `inference_timeout_ms` | duration | `300000` (5m) | Per-host inference-streaming inactivity timeout. Relay heartbeats reset it during extended thinking. |
| `first_token_timeout_ms` | duration | `60000` (1m) | Deadline for the first real model token from a relay host. Heartbeats prove liveness but do not satisfy it; expiry fails over to the next eligible host. |

**`ws` block:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `backfill_interval` | int ≥ 0 | `300` | Seconds between backfill reconciliation passes. |
| `backpressure_limit` | int > 0 | `2097152` | Buffered-bytes ceiling before applying backpressure. |
| `idle_timeout` | int > 0 | `120` | Seconds before an idle WS connection is closed. |
| `reconnect_max_interval` | int > 0 | `10` | Max seconds between reconnect attempts (backoff ceiling). |
| `receive_timeout_ms` | int ≥ 0 | `300000` (5m) | Receive-side liveness timeout. A spoke that gets no frame from the hub inside this window tears the connection down and reconnects — the changelog drain can stall while pings keep the socket alive. `0` disables. |
| `handshake_timeout_ms` | int ≥ 0 | `20000` (20s) | Handshake deadline. A socket that reaches neither `open` nor `close` inside this window is torn down and retried. A stalled upgrade fires no close event, so without this deadline the sync client stops attempting reconnects entirely and every remote host ages into `STALE` while the daemon keeps running. `0` disables. |

---

## `keyring.js` / `keyring.json`

Per-host identity keys for sync trust. During initial multi-host setup, add the hub's
reachable URL and public key to each spoke before connecting. Bound maintains known-host
entries after the topology is configured.

| Field | Type | Meaning |
|-------|------|---------|
| `hosts` | map&lt;host-name, { public_key, url }&gt; | Each known host's Ed25519 `public_key` (non-empty string) and `url` (sync endpoint). |

---

## `mcp.js` / `mcp.json`

MCP server connections. Tools from connected servers are auto-registered as agent
commands.

| Field | Type | Meaning |
|-------|------|---------|
| `servers` | array&lt;server&gt; | Discriminated on `transport`. |

**Common to every server:** `name` (non-empty string), `allow_tools` (optional
array&lt;string&gt; allowlist), `confirm` (optional array&lt;string&gt; of tools that require
confirmation).

**`transport: "stdio"`:** `command` (non-empty string), `args` (optional array&lt;string&gt;),
`env` (optional string→string map).

**`transport: "http"`:** `url` (url), `headers` (optional string→string map).

Unknown keys on one transport do not slip through via the other — each variant is strict
independently.

**MCP Apps.** A configured HTTP server that advertises the
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) `io.modelcontextprotocol/ui`
capability can render UI-bearing tool results inline in the web UI. There is no separate
MCP Apps configuration. SSE may carry a streamed HTTP response, but it is not a
`transport` value in `mcp.json`.

---

## `memory.js` / `memory.json`

Pinned-memory caps — a context-management control. Absent means the defaults below apply
(the enforcement code falls back to the same numbers).

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `pinned_count_cap` | int ≥ 1 | `10` | Max number of pinned memory entries. |
| `pinned_size_cap` | int ≥ 1 | `2000` | Max characters per pinned entry. |

---

## Replicated control state

### `persona`

`persona` is not a configuration file. It is a single replicated, cluster-wide Markdown
value included in the system prompt and capped at 64 KB. A fresh install has no persona.
Manage it with `boundctl set-persona`, the web UI's **Persona** view, or the corresponding
API; there is no `persona.md` seed.

## Removed configuration files

### `cron_schedules.json`

`cron_schedules.json` is not read or validated. Create recurring tasks at runtime through
the agent's `task` tool with the `schedule` action and a cron expression. The system-managed
agent heartbeat has no configuration-file surface.
