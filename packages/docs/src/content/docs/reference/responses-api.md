---
title: Responses API
description: OpenAI Responses-API-compatible inference endpoint for driving any cluster model over HTTP.
---

Bound exposes a `POST /v1/responses` endpoint on the web server (port 3001) that speaks the OpenAI Responses wire format. Any application that can talk to OpenAI — SDKs, LangChain's Responses adapter, `curl` — can point at a bound host instead and drive any model the cluster can resolve, local or relayed.

It's a thin translation shim over `resolveModel()` + `backend.chat()`. It does **not** go through context assembly, tool execution, or the agent loop — there's no persona, no memory, no skills, no tool dispatch. You send messages, you get a model response back.

## Quick start

```bash
curl http://localhost:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "input": "What is the cant deficiency on a 500系 at 300 km/h?",
    "stream": false
  }'
```

No API key required. The endpoint is localhost-only (gated by the same Host-header DNS-rebinding middleware as every other route). If your client sends a bearer token, it's accepted and silently ignored — so OpenAI SDKs that mandate an API key work without configuration.

## Request

The endpoint accepts a subset of the Responses schema that maps onto Bound's inputs. Unrecognized fields are ignored (forward-compatible with richer clients).

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `model` | string | router default | Model id to resolve. `"default"` and omitted both fall to the default local backend. Remote cluster models relay transparently. |
| `input` | string \| item[] | — | A bare string is a single user turn. An array of items carries the full conversation (see below). |
| `instructions` | string | — | Maps to the system prompt. |
| `tools` | tool[] | — | Responses-flat function tools (`{ type: "function", name, description?, parameters }`). |
| `tool_choice` | string \| object | `"auto"` | Forwarded to the driver when tools are present. Echoed back on the response for strict SDK parsers. |
| `parallel_tool_calls` | boolean | `true` | Echoed back; not yet forwarded to the driver. |
| `reasoning.effort` | string | per-model | Maps to effort (`low`, `medium`, `high`, `xhigh`, `max` for Anthropic). |
| `max_output_tokens` | number | per-model | Caps output length. Clamped to the model's own max-output ceiling. |
| `temperature` | number | per-model | Sampling temperature. |
| `top_p` | number | per-model | Nucleus sampling. |
| `stream` | boolean | `false` | `true` → SSE event stream; `false` → single JSON response. |

### Input items

`input` is either a string or an array of items. Message items carry `role` and `content`; tool calls and results are standalone item types with no `role`.

| Item type | Fields | Maps to |
|-----------|--------|---------|
| Message | `role`, `content` | Bound `LLMMessage` with the mapped role |
| `function_call` | `type`, `call_id`, `name`, `arguments` | Bound `tool_call` message (assistant tool use) |
| `function_call_output` | `type`, `call_id`, `output` | Bound `tool_result` message (tool result) |

Message `content` is either a string or a parts array. Supported part types:

| Part type | Handling |
|-----------|----------|
| `input_text` / `output_text` / `text` | → text content block |
| `input_image` with inline `data:` URL | → image content block |
| `input_file` with inline `data:` URL | → document content block |
| `input_image` / `input_file` with `file_id` / `file_url` / http `image_url` | Dropped with a text placeholder (endpoint is stateless, no files store) |

### Stateless by design

There's no server-side response store. `previous_response_id` and `conversation` are rejected with a `400` — send the full conversation history in `input` instead. This is the default pattern for stateless clients like Codex and OpenCode.

## Streaming

Set `"stream": true` to get an SSE event stream. Each event is `event: <type>` + `data: <json>` with a monotonic `sequence_number`.

```
response.created → response.in_progress
  → (text)     output_item.added → content_part.added
               → response.output_text.delta (×N)
               → response.output_text.done
               → content_part.done → output_item.done
  → (tool call) output_item.added(function_call)
               → response.function_call_arguments.delta (×N)
               → response.function_call_arguments.done
               → output_item.done
  → response.completed   (or response.failed on error)
```

A 5-second SSE heartbeat keeps the connection alive during long time-to-first-token gaps (e.g. large context windows on Opus). The HTTP server's `idleTimeout` is set to 255 seconds (Bun's hard cap) to accommodate extended generation.

## Non-streaming

Omit `stream` or set it to `false`. The endpoint collects the full stream internally and returns a single `Response` object with a populated `output` array and `usage`.

## Model resolution

The endpoint uses the same `resolveModel()` as the agent loop. Local backends are checked first; if the requested model lives on another host, inference streams over the relay transport transparently. Unknown models return `404`; unavailable models return `503`.

## Pointing a client at it

Most OpenAI-compatible clients work by setting a base URL and a dummy API key:

**OpenAI Python SDK:**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="unused",
)

response = client.responses.create(
    model="opus",
    input="Hello!",
)
print(response.output_text)
```

**Polytoken config (`custom_open_ai_compatible` provider):**
```yaml
providers:
  bound-responses:
    kind:
      type: custom_open_ai_compatible
      name: openai
    url: http://localhost:3001
    auth:
      type: none
```

Then point model entries at the `bound-responses` provider.
