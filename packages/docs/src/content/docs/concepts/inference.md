---
title: Inference & Model Routing
description: LLM driver shims, the model router, capability-aware routing, and cluster-wide inference relay.
---

The `@bound/llm` package provides a unified streaming interface over multiple model providers. All drivers implement the same `LLMBackend` interface, and a `ModelRouter` selects the appropriate driver at call time.

## Drivers

Each driver is an `LLMBackend` with a `chat()` method that returns an `AsyncIterable<StreamChunk>` — callers process tokens as they arrive without buffering the entire response.

| Driver | Provider | Notes |
| --- | --- | --- |
| Bedrock | AWS Bedrock | Converse API; SigV4 auth; supports prompt caching, extended thinking |
| Bedrock Mantle | AWS Bedrock (Mantle) | Region-scoped endpoint; Anthropic Messages or OpenAI Responses protocol surface |
| OpenAI-compatible | Any OpenAI-compatible endpoint | Cerebras, z.AI, custom endpoints |
| Anthropic | Anthropic direct | Claude models; prompt caching, extended thinking |
| Ollama | Ollama (local) | No API key; easiest to start |
| OpenCode Go | OpenCode Go | OpenAI-compatible with provider-specific routing |
| umans | umans.ai | Self-configuring — model lineup fetched at runtime |

## Model resolution

`resolveModel()` is a three-phase pipeline:

1. **Identify** — resolve the requested model id (or `default`/`undefined` → default backend) against local and remote backends
2. **Qualify** — check capabilities (vision, tool_use, streaming, system_prompt, prompt_caching). If the primary backend lacks required capabilities, re-route to eligible alternatives
3. **Dispatch** — return `{ kind: "local" }`, `{ kind: "remote" }`, or `{ kind: "error" }` with reason (`capability-mismatch`, `transient-unavailable`)

Each host advertises its available models in `hosts.models` as `HostModelEntry[]` objects with `id`, `tier`, and `capabilities`. The web UI's `ModelSelector` shows all cluster models with relay/offline annotations.

## Inference relay

When a model resolves to `{ kind: "remote" }`, inference streams over the relay transport:

1. The requesting host writes an `inference` relay message with the full context
2. The target host receives it, calls the LLM backend locally
3. The target streams `stream_chunk` responses back (with monotonic `seq` for reordering)
4. The agent loop enters `RELAY_STREAM` state, polling `relay_inbox` for chunks
5. On `stream_end`, the loop proceeds to `PARSE_RESPONSE`

Failover retries on the next eligible host after `sync.relay.inference_timeout_ms` (default 300s).

## Prompt caching

Drivers that support prompt caching (Anthropic, Bedrock) accept `cache_breakpoints` — an array of message indices at which to insert cache markers. The context pipeline places breakpoints to maximize cache hits:

- The system prompt (stable prefix) gets a breakpoint so it's cached across turns
- The volatile stable subsection rides inside the system prompt to benefit from the same cache

`cache_ttl` selects the cache tier: `5m` (default) or `1h` (extended TTL; Bedrock Claude Opus/Sonnet/Haiku 4.5+ only; silently falls back where unsupported).

### Cache warming

Opt-in periodic warm pokes keep the prompt cache hot on active threads. Controlled per-backend via the `cache_warming` config block:

```json
{
  "cache_warming": {
    "enabled": true,
    "max_pokes": 3
  }
}
```

`max_pokes` is the load-bearing economic control — break-even scales with the cache-write/read price ratio, so cheap-read backends tolerate more pokes. The poke window is derived per-thread from the backend's `cache_ttl`.

## Extended thinking

Anthropic and Bedrock drivers support extended thinking / reasoning:

- `thinking: { type: "adaptive" }` — let the model decide, with depth set by the backend's `effort`
- `thinking: { type: "enabled", budget_tokens: N }` — legacy fixed budget (removed on Opus 4.7)
- `effort` — free-form reasoning depth string, provider-validated. Canonical Anthropic set: `low`, `medium`, `high`, `xhigh`, `max`

## Tool-use ID sanitization

Tool-use IDs and names persist in the `messages` table and survive provider switches. A thread that accumulated IDs under one provider must remain routable to a stricter one (Anthropic enforces `^[a-zA-Z0-9_-]+$`).

The bridge sanitizes at two layers:

1. **Streaming boundary** — sanitize IDs and names as they arrive from the provider, so fresh tool calls land in the DB already wire-legal
2. **Read boundary** — re-apply sanitization at context assembly, so already-poisoned historical rows self-heal without manual DB surgery

Both are deterministic and idempotent, preserving tool_use/tool_result pairing across rewrites.
