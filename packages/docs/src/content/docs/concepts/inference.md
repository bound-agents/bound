---
title: Inference & Model Routing
description: Supported LLM backends, model selection, prompt caching, and extended thinking.
---

Bound supports multiple LLM providers and routes inference cluster-wide to the right backend automatically. If the primary backend is unavailable or lacks a required capability (vision, tool use), it falls back to eligible alternatives.

## Supported backends

| Provider | Auth | Notes |
| --- | --- | --- |
| Ollama | None (local) | Easiest to start; no API key |
| Anthropic | `ANTHROPIC_API_KEY` | Claude models; prompt caching, extended thinking |
| AWS Bedrock | AWS SDK chain | Converse API; SigV4 auth |
| Bedrock Mantle | AWS SDK chain | Region-scoped; Anthropic Messages or OpenAI Responses protocol |
| Cerebras | `CEREBRAS_API_KEY` | OpenAI-compatible |
| z.AI | `ZAI_API_KEY` | GLM models |
| OpenCode Go | Provider-specific | OpenAI-compatible routing |
| umans.ai | `UMANS_API_KEY` | Self-configuring — model lineup fetched at runtime |
| OpenAI-compatible | Varies | Any endpoint speaking the OpenAI API |

Configure backends in `model_backends.json`. See the [Configuration Reference](/bound/reference/configuration/) for all fields.

## Model selection

Each host advertises its available models to the cluster. The web UI's model selector shows all cluster models, annotated with which host holds them. Resolution is cluster-wide: pick a model, and if it lives on another host, inference streams over the relay transport — no per-host configuration on your end.

You can set a default model per thread, or let the cluster default handle it. The agent can also switch models mid-task on its own — useful when a cheap model hits something it should hand to a stronger one.

## Prompt caching

For providers that support it (Anthropic, Bedrock), Bound automatically places prompt cache breakpoints to maximize cache hits across turns. The system prompt is cached so it doesn't need to be re-processed on every message.

Cache TTL can be set per-backend: `5m` (default) or `1h` (extended; supported on Claude Opus/Sonnet/Haiku 4.5+ on Bedrock).

### Cache warming

You can opt in to periodic cache-warming pokes that keep the prompt cache hot on active threads, so the next real message lands on a cache-read instead of a cache-write:

```json
{
  "cache_warming": {
    "enabled": true,
    "max_pokes": 3
  }
}
```

`max_pokes` controls how many warm pokes fire per thread since its last real activity. The economic break-even depends on your backend's cache-write vs cache-read price ratio — cheap-read backends tolerate more pokes.

## Extended thinking

Anthropic and Bedrock drivers support extended thinking / reasoning. Configure per-backend:

- `effort` — reasoning depth. Canonical Anthropic set: `low`, `medium`, `high`, `xhigh`, `max`. Other providers advertise their own levels.
- `thinking` — `adaptive` (model decides, depth set by `effort`) or legacy fixed budget.

```json
{
  "thinking": { "type": "adaptive" },
  "effort": "xhigh"
}
```
