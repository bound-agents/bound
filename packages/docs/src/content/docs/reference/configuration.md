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
| **Host-local file** | Read from one host's configuration directory. Values and secrets stay on that host. | `allowlist.js` / `allowlist.json`, `model_backends.js` / `model_backends.json`, `network.js` / `network.json`, `platforms.js` / `platforms.json`, `sync.js` / `sync.json`, `keyring.js` / `keyring.json`, `mcp.js` / `mcp.json`, `memory.js` / `memory.json` |
| **Replicated control state** | Stored outside the configuration-file set and replicated to hosts. | [`persona`](#persona) |
| **Per-thread or client-local concept** | Selected or derived for a single thread, turn, or client. | Per-thread backend cache windows and per-call model effort |

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
unaffected: the string is a spelling of the number and resolves to the same value.

Durations carrying days or larger (`P1D`, `P2W`, `P1M`) are rejected: a day is
23, 24, or 25 hours across a DST boundary, so converting one needs a calendar
reference the config layer has no way to supply. Write `PT24H` for 24
hours. Negative durations and sub-millisecond precision are rejected too.

Fields documented as `int >= 0` keep `0` as their disabled sentinel; `PT0S`
works there as well.

## Configuration files

| File | Required | Purpose |
|------|----------|---------|
| [`allowlist.js` / `allowlist.json`](#allowlistjs--allowlistjson) | Yes | Who may talk to the agent |
| [`model_backends.js` / `model_backends.json`](#model_backendsjs--model_backendsjson) | Yes | LLM backends, routing, pricing, caching |
| [`network.js` / `network.json`](#networkjs--networkjson) | No | Outbound HTTP policy for sandbox and `just-bash` execution |
| [`platforms.js` / `platforms.json`](#platformsjs--platformsjson) | No | Platform connectors (Discord, etc.) |
| [`sync.js` / `sync.json`](#syncjs--syncjson) | No | Hub URL, relay, WebSocket sync tuning |
| [`keyring.js` / `keyring.json`](#keyringjs--keyringjson) | No | Per-host identity keys (auto-populated) |
| [`mcp.js` / `mcp.json`](#mcpjs--mcpjson) | No | MCP server connections |
| [`memory.js` / `memory.json`](#memoryjs--memoryjson) | No | Pinned-memory caps |

---

## JavaScript alternatives

Every operator config supports a JavaScript alternative: `allowlist.js`, `model_backends.js`, `network.js`, `platforms.js`, `sync.js`, `keyring.js`, `mcp.js`, and `memory.js`. When both forms exist, Bound selects `.js`; it never falls back to JSON after a selected JavaScript file fails to evaluate or validate. This keeps a broken override visible and makes startup/reload transactional: the previous loaded configuration remains active on a hot reload.

A JavaScript file is an ESM-like module that `export default`s one object. Comments and helper declarations (for example a shared pricing function assigned to a `const`) may precede the export. Bound evaluates it in a bounded QuickJS runtime, expands `${NAME}` and `${NAME:-default}` strings, then applies the same strict Zod schema as JSON. JavaScript serves as configuration within a constrained surface: `model_backends.js` alone may contain `backend.price(turn)` callbacks; all other config values must be data.

## `allowlist.js` / `allowlist.json`

Maps Bound users to identities on supported platforms.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `default_web_user` | string (non-empty) | — | The user ID assumed for unauthenticated web-UI sessions. Must be a key in `users`. |
| `users` | map&lt;id, user&gt; | — | At least one user required. Key is the user ID; value is the user entry below. |

**User entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `display_name` | string (non-empty) | — | Human-readable name. |
| `platforms` | map&lt;string, string&gt; | absent | Identifies this Bound user on each platform, e.g. `{ "discord": "<discord-user-id>" }`. This is independent of connector-local `platforms.json` filtering. |

---

## `model_backends.js` / `model_backends.json`

Bound loads `model_backends.js` when it exists; otherwise it loads `model_backends.json`. The JavaScript form is an ESM-like module that `export default`s the LLM backends and routing configuration and runs in Bound's bounded QuickJS evaluator. Only the JavaScript form permits a backend `price(turn)` callback; JSON remains strict static configuration. Both forms reject undeclared fields through the same strict schema.

An empty `backends` array is valid for a hub-only node that relays all inference to spokes; in that case `default` must be `""`.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `backends` | array&lt;backend&gt; | — | The backends this host can serve locally. May be empty (hub-only). |
| `default` | string | `""` | Backend `id` used when a turn names no model. Must reference a real backend, or be `""` when `backends` is empty. |
| `daily_budget_usd` | number ≥ 0 | absent | Optional soft daily spend ceiling. |
| `models_dev` | models.dev block | absent | `models.dev` fallback-registry settings (see below). Absent means fetch the public catalog every 24h. |
| `defaults` | defaults block | absent | Top-level operator-preference defaults applied to every backend that does not set the same field (see below). |

**Backend entry:**

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `id` | string (non-empty) | — | Logical alias the router resolves (e.g. `"opus"`). Distinct from `model`. |
| `provider` | enum | — | One of `ollama`, `bedrock`, `bedrock-mantle`, `anthropic`, `openai-compatible`, `cerebras`, `zai`, `opencode-go`, `umans`, `chatgpt-oauth`, `github-copilot`. |
| `model` | string (non-empty) | — | Provider-specific identifier (model name or Bedrock ARN). For `bedrock-mantle`, the Mantle model ID for the selected `provider_mode` (for example, `openai.gpt-5.4` or `anthropic.claude-sonnet-5`). Omitted for `umans` (the model lineup is fetched at runtime — see below). |
| `provider_mode` | enum `anthropic`\|`openai_responses` | — | Required for `bedrock-mantle`. Selects the Mantle protocol surface: Anthropic Messages (`/anthropic/v1/messages`) or OpenAI Responses (`/openai/v1/responses`). |
| `base_url` | url | absent | Required for `ollama` and `openai-compatible`. Optional override for `bedrock-mantle` (default is derived from `region` and `provider_mode`) and `umans` (default `https://api.code.umans.ai`). |
| `api_key` | string | absent | Required for `cerebras`, `anthropic`, `zai`, `opencode-go`, `umans`. Unused by `bedrock-mantle` (auth is AWS SigV4), `chatgpt-oauth`, and `github-copilot` (subscription OAuth tokens are used instead). |
| `token_store_path` | string | `config/chatgpt-auth.json` (`chatgpt-oauth`), `config/copilot-auth.json` (`github-copilot`) | Absolute path to the persisted OAuth token bundle. For `chatgpt-oauth`, create it with `bound login --chatgpt`; for `github-copilot`, with `bound login --copilot`. Both still require `model` and `context_window`. |
| `region` | string | absent | AWS region (Bedrock, and required for `bedrock-mantle` — the Mantle endpoint host is region-scoped). |
| `profile` | string | absent | AWS profile name (Bedrock and `bedrock-mantle`; falls back to the ambient credential chain when absent). |
| `context_window` | int > 0 | — | Optional override of the model's context-window budget. Normally resolved automatically — from the provider's discovery API, then `models.dev` — so you only set it to cap the window below what those sources report, or for a model neither source knows. Omitted for `umans` (fetched per-model). A backend whose window resolves from no source stays unready (see below). |
| `logical_model` | string | absent | Operator-declared logical model this backend joins. Takes precedence over structural normalization but is overridden by a synced `model_aliases` entry. Absent → the logical model is resolved by normalization, or left unassigned when confidence is low. |
| `price_per_m_input` | number ≥ 0 | derived | USD per million non-cached input tokens. Optional override. Normally resolved from the provider's pricing API, then `models.dev` — including context-tiered rates. Set it only to override those sources; a deliberate `0` (free local model) overrides them, while omitting it falls through to the derived price. |
| `price_per_m_output` | number ≥ 0 | derived | USD per million output tokens. Optional override, same precedence as `price_per_m_input`. |
| `price_per_m_cache_write` | number ≥ 0 | derived | USD per million cache-write tokens at the protocol's default cache lifetime (5m for Anthropic Messages and Bedrock Converse, 30m for OpenAI Responses). It is also the fallback rate for write tokens whose lifetime has no published price. Optional override; resolved from provider pricing or `models.dev` when unset. |
| `price_per_m_cache_write_1h` | number ≥ 0 | derived | USD per million 1h-lifetime cache-write tokens. Optional override. When set, the 1h portion of a turn's reported write split bills at this rate and the rest at `price_per_m_cache_write`; when unset, 1h writes fall back to `price_per_m_cache_write`. The provider must report a per-lifetime write split for a lifetime-matched price to apply. When it does not, the whole cache-write total bills at the default-lifetime rate and the turn's pricing source is recorded as `estimate`. |
| `price_per_m_cache_read` | number ≥ 0 | derived | USD per million cache-read tokens. Optional override; resolved from provider pricing or `models.dev` when unset. |
| `price` | function | absent | Optional `price(turn)` callback returning this turn's USD cost. Highest-precedence pricing source: it overrides the static `price_per_m_*` fields, provider pricing, and `models.dev`. It runs in the bounded evaluator and receives the turn's usage and static prices. Candidate evaluation and validation errors reject startup or reload; an error in a runtime-only branch falls back to the static/derived pricing. |
| `capabilities` | capabilities override | absent | Force capability flags (see below). |
| `thinking` | thinking config | absent | Extended-thinking / reasoning config (see below). |
| `effort` | string (non-empty) | absent | Provider-validated reasoning depth. Common Anthropic and Bedrock Converse values are `low`, `medium`, `high`, `xhigh`, and `max`; other providers may support different values. An `effort` a model does not list is clamped to the nearest value it does, using the resolved reasoning ladder; with no resolved ladder the value is forwarded for the driver to accept or drop. Inherited from the top-level `defaults.effort` when unset here. |
| `max_output_tokens` | int > 0 | absent | Optional override of the per-backend output-token cap, applied as the lower of this value and the default limit. Normally resolved automatically from the provider's discovery API, then `models.dev`; set it to cap output below what those sources report, or for a model neither source knows. A resolved (non-override) value larger than 25% of the resolved context window is capped at 25%, because context management reserves the output limit out of the window; an explicit override here is always respected. |
| `system_prompt_suffix` | string | absent | Text appended to the system prompt only when this backend serves the turn. |
| `cache_ttl` | enum `5m`\|`1h` | absent (`5m`) | Prompt-cache TTL hint. Unsupported `1h` hints fall back to `5m`. |
| `cache_warming` | cache-warming block | absent | Per-backend cache warming (see below). Absent disables warming for this backend. |
| `connect_timeout_ms` | int > 0 | absent (off) | Deadline for receiving response headers. It applies on the host making the request and is not forwarded over the relay; streaming after headers uses separate timeout handling. |
| `additional_headers` | map (string→string) | absent | Extra upstream HTTP headers for `openai-compatible`, `cerebras`, and `zai`. They apply on the host making the request and may override a same-named provider header, including `Authorization`. |

**Capabilities override** (`capabilities`) — all fields optional booleans except
`max_context`; set only to override what the catalog resolves from provider
discovery and `models.dev`: `streaming`, `tool_use`, `system_prompt`,
`prompt_caching`, `vision` (bool), `max_context` (int > 0). There is no hardcoded
per-driver `max_context` default: a backend whose `max_context` is set by none of
local config (`context_window` or this override), provider discovery, or
`models.dev` stays **unready** — it is not advertised and not routable, and the
host logs the configuration gap naming the field to set — rather than dispatching
a turn on a guessed window. Set `context_window` for any model absent from both
your provider's discovery API and `models.dev`.

**Thinking config** (`thinking`) — either the literal `true` (legacy shorthand), or an
object:

| Field | Type | Meaning |
|-------|------|---------|
| `type` | `enabled`\|`adaptive`\|`tool` | `enabled` + `budget_tokens` is the legacy fixed-budget shape (removed on Opus 4.7); `adaptive` lets the model decide, with depth set by the backend's `effort`. `tool` disables the provider's native reasoning and exposes Bound's optional `think({ thought })` scratchpad tool instead. When `thinking` is absent entirely, Bound derives the reasoning request from the model's resolved reasoning metadata: no reasoning support → none; a toggle or effort ladder → enabled; a provider-advertised adaptive capability → adaptive. |
| `budget_tokens` | int > 0 | Legacy fixed thinking budget. Rejected (400) on Opus 4.7; incompatible with `adaptive` and `tool`. |
| `display` | `omitted`\|`summarized` | Opt into visible reasoning text on Opus 4.7 (default `omitted`); incompatible with `enabled` and `tool`. |

`tool` mode cannot set `effort`. It emits `Thinking complete - please continue your work.` after a `think` call and does not require the model to invoke that tool.

**Cache-warming block** (`cache_warming`) — opt-in periodic poke that
keeps the prompt cache hot on active threads so the next real message lands on a
cache-read instead of a cache-write. Off by default.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `false` | Master toggle. |
| `max_pokes` | int ≥ 0 | `3` | Maximum pokes per thread since its last real activity. `0` disables warming on this backend even with `enabled: true`. |

The poke window is not configured — it is derived per-thread from that thread's backend
`cache_ttl` (a poke fires only when the cache would otherwise lapse before the next scan).

**models.dev block** (`models_dev`) — settings for the `models.dev` fallback
registry, the gap-filling metadata source that fills capability, context-window,
and pricing fields a backend's local config and live provider discovery leave
unset. It never grants model availability: a model present in `models.dev` but
absent from a host's own provider discovery is never served by that host. The
snapshot is cached on local disk only and never synced. Absent → fetch the public
catalog every 24 hours.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `enabled` | bool | `true` | Master toggle. Set `false` in air-gapped environments to skip all network fetches; a pre-seeded disk cache is still used. |
| `url` | url | `https://models.dev/api.json` | Catalog endpoint. Point at a private mirror when the public host is unreachable. |
| `refresh_interval_ms` | duration | `24h` | Background refresh cadence. Refreshes send `If-None-Match` with the cached `ETag`; a `304` keeps the existing snapshot. |

A failed fetch never blocks startup: the host falls back to its cached snapshot,
or to local config and provider APIs alone when no cache exists. A backend whose
`max_context` is unresolved across all three layers (local config, provider
discovery, `models.dev`) stays unready rather than running on a guessed window.

**Defaults block** (`defaults`) — top-level operator-preference defaults applied to
every backend that does not set the same field itself. A per-backend value always wins.
This lets an operator state a cluster-wide preference once instead of copying it onto each
entry.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `effort` | string (non-empty) | absent | Default reasoning depth for backends that set no `effort`. Clamped per-model to the nearest listed value, same as a per-backend `effort`. |
| `cache_ttl` | enum `5m`\|`1h` | absent | Default prompt-cache TTL hint for backends that set no `cache_ttl`. |

`thinking` is deliberately not a `defaults` field: the `thinking` shapes are
provider-specific (adaptive reasoning is Anthropic-only; a generic `enabled` would be wrong
for a model that only offers an effort ladder or a toggle), so a single cluster-wide
`thinking` default is not meaningfully generic. A backend that sets no `thinking` instead
has one derived per-model from the resolved reasoning metadata (see below).

### Price callback

Put dynamic pricing beside the backend it prices. A callback is evaluated in Bound's isolated pricing runtime, but it retains lexical access to constants and helpers declared in the same `model_backends.js` module. For example, cache reads can receive a different rate:

```js
export default {
  backends: [
    {
      id: "example",
      provider: "openai-compatible",
      model: "example-model",
      base_url: "https://api.example.com/v1",
      context_window: 128000,
      price(turn) {
        return (turn.usage.inputTokens * 2 + turn.usage.outputTokens * 8) / 1_000_000;
      },
    },
  ],
  default: "example",
};
```

The `turn` argument carries `turn.usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `cacheWrite1hTokens` — the 1h-TTL subset of `cacheWriteTokens`, `0` when the provider did not report a split) and `turn.pricesPerM` (the static `input` / `output` / `cacheRead` / `cacheWrite` rates, plus `cacheWrite1h`, which falls back to `cacheWrite` when `price_per_m_cache_write_1h` is unset). A callback that ignores the 1h fields computes exactly what it did before they existed.

The callback may return either a plain number (this turn's total USD) or an object `{ input, output, cacheRead, cacheWrite }` carrying the four per-component costs in USD — the total is their sum. Each part must be a finite non-negative number; a missing or invalid part rejects at startup/reload. Returning the object form makes the web UI's per-model cost chart show exact per-component costs for the turn instead of a token-weighted estimate; returning a plain number leaves that turn without a component split (the chart estimates it). Fold any 1h cache-write cost into `cacheWrite`.

```js
      price(turn) {
        return {
          input: (turn.usage.inputTokens * turn.pricesPerM.input) / 1_000_000,
          output: (turn.usage.outputTokens * turn.pricesPerM.output) / 1_000_000,
          cacheRead: (turn.usage.cacheReadTokens * turn.pricesPerM.cacheRead) / 1_000_000,
          cacheWrite: (turn.usage.cacheWriteTokens * turn.pricesPerM.cacheWrite) / 1_000_000,
        };
      },
```

### umans.ai

A minimal `umans` backend entry contains `provider`, `id`, and `api_key`. The top-level
`default` field is a sibling of `backends` and names the entry's `id`; it is not a backend
entry field.

```js
export default {
  backends: [{ provider: "umans", id: "umans", api_key: "sk-..." }],
  default: "umans",
};
```

Do not set `model`, `context_window`, `capabilities`, or nondefault pricing fields
on a `umans` entry; they are rejected. Other generic optional backend fields may be
accepted by the schema. Set up with `bound init --umans` (reads `UMANS_API_KEY`).

### GitHub Copilot

A `github-copilot` backend drives a Copilot model through Bound's own GitHub App, authenticated
by the device-flow token `bound login --copilot` writes to `config/copilot-auth.json` (no
`api_key`). The Copilot API fronts several model families; Bound reads each model's capabilities
from the live catalog and routes it to the matching wire surface automatically. The `model` is
the Copilot model ID, or the literal `auto` to let Copilot pick a model per request.

```js
export default {
  backends: [
    {
      id: "copilot-claude",
      provider: "github-copilot",
      model: "claude-sonnet-4.5",
      context_window: 200000,
    },
    {
      id: "copilot-auto",
      provider: "github-copilot",
      model: "auto",
      context_window: 128000,
    },
  ],
  default: "copilot-claude",
};
```

Plan caveats: on a Free plan only zero-priced models (for example `gpt-4.1`, `gpt-4o`,
`gpt-5.4-nano`) and the `auto` selector are callable directly; naming a premium model there
fails with an `unavailable for this plan` error. A paid Copilot plan unlocks the rest.
The API endpoint is plan-specific and discovered (and host-validated against `githubcopilot.com`)
from the account lookup — it is never set in config.

`effort` is honored on every route — Anthropic Messages (Claude), OpenAI Responses (GPT-5+, Grok,
mai-code), and chat completions (Gemini and the rest). The requested value is validated against the
reasoning levels the model advertises in the live catalog: an advertised value passes through,
`max` collapses to the highest level the model lists when `max` itself is absent, and a value the
model does not advertise is dropped rather than sent. A `thinking: { type: "disabled" }` config maps
to `none` when the model offers it. On the Responses route an active effort also runs the turn under
`store: false` with encrypted reasoning content so replayed reasoning rides inline.

Pricing is read from Copilot's own catalog: a `github-copilot` turn's cost is computed from the
resolved model's `billing.token_prices` (for `model: "auto"`, the model Copilot actually selected),
so the backend entry does not need manual per-token prices. The catalog's `long_context` rates apply
automatically once a turn's prompt exceeds the model's `max_prompt_tokens`, and a `1h`-TTL
cache-write price bills the 1h subset of cache writes separately when the catalog carries one.

The Auto pool's discount applies only to `model: "auto"` turns, and a time-boxed promo discount
applies only before its end date. Setting any `price_per_m_*` field or a `price(turn)` callback on
the backend overrides the catalog entirely; absent both, a turn with no catalog pricing records `0`.

---

## `network.js` / `network.json`

Outbound HTTP policy for sandbox and `just-bash` egress only. Bound's own provider, sync,
platform, and MCP clients are unaffected.

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
| `allowed_users` | array&lt;string&gt; | `[]` | Connector-local platform user filter, independent of `allowlist.json` identity mapping. For Discord, this filters DMs and interactions. |
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

Each transport variant validates its own schema strictly.

**OAuth for `http` servers.** An `http` server may carry an optional `auth` block of
`type: "oauth"` for the OAuth 2.1 authorization-code flow with PKCE. Its absence leaves the
server on the static-`headers` bearer path. When a token has been obtained, it supplies the
`Authorization` header and outranks a configured `headers` entry, so a configured header
serves as a fallback until a token exists.

| Field | Type | Meaning |
|-------|------|---------|
| `type` | `"oauth"` | Selects the OAuth path. |
| `scopes` | optional array&lt;string&gt; | Requested scope set. The authorization server is authoritative on the granted scope. |
| `client_id` | optional string | A pre-registered client id, or a Client-ID-Metadata-Document https URL. Non-secret; it may appear in synced challenge rows. Omit it to register a public client dynamically at resolution time. |
| `client_secret` | optional string | A confidential-client secret. Declare it only in the owning host's config. It never syncs and never crosses the relay. |

A server that returns `401` or steps up scope with `403 insufficient_scope` raises a
challenge instead of failing permanently. Resolve it with `bound login --challenge <id>` or
`bound login --mcp <server>`, or from the web UI consent card. See the
[MCP servers guide](/bound/guides/mcp-servers/#authenticate-with-oauth) for the procedure.
Bound stores OAuth tokens in a per-host `config/mcp-auth.json` file.

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

`persona` is a single replicated, cluster-wide Markdown value included in the system prompt
and capped at 64 KB. A fresh install has no persona. Manage it with `boundctl set-persona`,
the web UI's **Persona** view, or the corresponding API.

### `routing.model_roles`

`routing.model_roles` is a replicated, cluster-wide JSON object naming the logical models
that fill cluster roles: `{ "default": "<logical-model>", "heavy"?: "...", "fast"?: "..." }`.
A turn that requests no model, or the literal `"default"`, resolves to `routing.model_roles.default`
first. The per-host [`model_backends` `default`](#model_backendsjs--model_backendsjson) is only
a bootstrap fallback used when the cluster role is unset or names a model the host cannot serve
locally. Because the role is replicated, every host agrees on what `"default"` means.

### `routing.default_fallback_models`

`routing.default_fallback_models` is a replicated, cluster-wide JSON array of logical model IDs
(`["...", "..."]`) giving the ordered cluster-default list to try when a model refusal calls for
a different model and no per-model fallback override applies. It names models, never routes:
route-level failover for the same model is automatic and separate (see
[Inference and model routing](/bound/concepts/inference/#route-failures-and-model-refusals)).
