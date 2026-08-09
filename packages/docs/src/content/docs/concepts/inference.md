---
title: Inference and model routing
description: How Bound resolves models across hosts, relays inference, and manages prompt caching.
---

Bound resolves each requested model against the backends advertised by the cluster. It
prefers an eligible local backend, then considers remote hosts and configured fallbacks.

## Supported backends

| Provider | Auth | Notes |
| --- | --- | --- |
| Ollama | None | Local inference |
| Anthropic | `ANTHROPIC_API_KEY` | Claude models; prompt caching, extended thinking |
| AWS Bedrock | AWS SDK chain | Converse API; SigV4 auth |
| Bedrock Mantle | AWS SDK chain | Region-scoped; Anthropic Messages or OpenAI Responses protocol |
| Cerebras | `CEREBRAS_API_KEY` | OpenAI-compatible |
| z.AI | `ZAI_API_KEY` | GLM models |
| OpenCode Go | Provider-specific | OpenAI-compatible routing |
| umans.ai | `UMANS_API_KEY` | Self-configuring — model lineup fetched at runtime |
| OpenAI-compatible | Varies | Any endpoint speaking the OpenAI API |

Configure backends in `model_backends.json`. See the
[configuration reference](/bound/reference/configuration/#model_backendsjson) for every
field.

## Model selection

Each host advertises its available models and capabilities. The model selector combines
these advertisements into one cluster-wide inventory.

`"default"` and an omitted model both resolve to the default local backend. When a named
model exists only on another host, Bound relays the assembled context and streams the
response back to the loop host.

## Prompt caching

For providers that support prompt caching, Bound separates stable context from turn-varying
context and places provider cache breakpoints around the stable prefix.

Set `cache_ttl` to `5m` or `1h` on a backend. Unsupported extended TTL settings fall back
to the provider's standard behavior.

### Cache warming

Cache warming can refresh an active thread's prompt cache before it expires:

```json
{
  "cache_warming": {
    "enabled": true,
    "max_pokes": 3
  }
}
```

`max_pokes` limits refreshes since the thread's last real activity. Warming trades
additional requests for a higher chance that the next turn reads from cache.

## Reasoning controls

Backends can expose provider-specific reasoning controls:

- `effort` sets a provider-supported reasoning level.
- `thinking` selects adaptive reasoning or a legacy fixed budget where supported.

```json
{
  "thinking": { "type": "adaptive" },
  "effort": "xhigh"
}
```
