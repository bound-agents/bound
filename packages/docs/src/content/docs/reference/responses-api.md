---
title: Responses API
description: Request, response, stream, error, and model-resolution behavior for Bound's stateless inference endpoint.
---

`POST /v1/responses` is Bound's stateless, OpenAI Responses-compatible inference endpoint.
Use it when a client supplies model input and manages conversation and tool state itself.

## Responses API compared with the agent interface

The Responses API provides model inference without the stateful context and tool execution
of Bound's agent interface.

| Capability | Bound agent interface | `POST /v1/responses` |
| --- | --- | --- |
| Execution path | Runs the Bound agent loop | Calls the model router directly |
| Context | Loads agent context, including persona, memory, skills, and history | Uses only the request's `instructions` and `input` |
| Conversation state | Managed by the agent interface | Not stored; the caller sends the complete conversation |
| Tool lifecycle | The agent can execute tools | The caller provides tool definitions, executes returned calls, and sends results in a later request |
| Model routing | Can use cluster models | Can resolve any cluster model, including one served by another host |

## Request

Send JSON to `POST /v1/responses`:

```bash
curl http://localhost:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "input": "What is the cant deficiency on a 500系 at 300 km/h?",
    "stream": false
  }'
```

### Request fields

The endpoint accepts the subset of the Responses schema that maps to Bound model input.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `model` | string | router default | Model id to resolve. `"default"` and omitted both use the default local backend. A model held by another host relays over the cluster transport. |
| `input` | string \| item[] | — | A string is one user turn. An item array carries the complete conversation. |
| `instructions` | string | — | Maps to the system prompt. |
| `tools` | tool[] | — | Responses-flat function tools: `{ type: "function", name, description?, parameters }`. |
| `tool_choice` | string \| object | `"auto"` | Forwarded to the driver when tools are present. Echoed on the response for strict software development kit (SDK) parsers. |
| `parallel_tool_calls` | boolean | `true` | Echoed on the response; not yet forwarded to the driver. |
| `reasoning.effort` | string | per-model | Maps to effort (`low`, `medium`, `high`, `xhigh`, or `max` for Anthropic). |
| `max_output_tokens` | number | per-model | Caps output length. Clamped to the model's own maximum-output ceiling. |
| `temperature` | number | per-model | Sampling temperature. |
| `top_p` | number | per-model | Nucleus sampling. |
| `stream` | boolean | `false` | `true` returns a server-sent event (SSE) stream; `false` returns one JSON response. |

### Input items

`input` is either a string or an array of items. Message items carry `role` and `content`.
Tool calls, tool results, and reasoning are standalone item types without `role`.

| Item type | Fields | Meaning |
|-----------|--------|---------|
| Message | `role`, `content` | A conversation message with the supplied role |
| `function_call` | `type`, `call_id`, `name`, `arguments` | A function the model asks the caller to run |
| `function_call_output` | `type`, `call_id`, `output` | The caller-provided result for the matching function call |
| `reasoning` | `type`, `summary`, `encrypted_content` | A reasoning item from an earlier response, replayed as part of the conversation. The endpoint attaches it to the assistant turn that follows it. |

Replay `reasoning` items exactly as an earlier response returned them. For models that return
`encrypted_content`, the replayed item restores the model's prior reasoning state across
stateless requests; dropping the items degrades multi-step tool use. A reasoning item
followed by a user or developer message, or by nothing, is dropped.

Message `content` is either a string or a parts array. The endpoint handles these part types:

| Part type | Handling |
|-----------|----------|
| `input_text` / `output_text` / `text` | Used as text content |
| `input_image` with inline `data:` URL | Used as image content |
| `input_file` with inline `data:` URL | Used as document content |
| `input_image` / `input_file` with `file_id` / `file_url` / HTTP `image_url` | The external file reference is not retrieved. A text placeholder is included instead because the endpoint has no file store. |

### Tool lifecycle

The endpoint sends tool definitions and tool choice to the model, but it does not execute a
returned function call. The caller owns the lifecycle:

1. Send the conversation and `tools`.
2. Read returned `function_call` items and execute the named functions outside Bound's agent
   loop.
3. Send the complete conversation again, including each returned `reasoning` item, each
   `function_call`, and its matching `function_call_output` identified by `call_id`.

The endpoint does not retain earlier calls, outputs, or reasoning between requests.

### Ignored and rejected fields

Unrecognized fields are ignored for compatibility with clients that send a richer Responses
schema. Ignored fields do not add behavior or server-side state.

Two recognized stateful fields are explicitly rejected rather than ignored:
`previous_response_id` and `conversation`. A request containing either field returns `400`.
Bound does not store Responses API conversations, so send the complete conversation in
`input` on every request.

## Response

### Non-streaming response

Omit `stream` or set it to `false`. The endpoint collects the model stream internally and
returns one OpenAI-compatible `Response` object. The response includes model output and
usage information, and its output entries can contain reasoning, text, or function calls in
model order. Reasoning entries carry the model's summary text and, for models that produce
it, `encrypted_content` for replay in a later request. Other parts of the broader Responses
schema are not supported unless this page lists them.

The response echoes `tool_choice` and `parallel_tool_calls` for strict SDK parsers. Echoing
`parallel_tool_calls` does not mean that the value was forwarded to the model driver.

### Streaming response

Set `stream` to `true` to receive an SSE stream. Each event uses this envelope:

```text
event: <type>
data: <JSON containing a monotonic sequence_number>
```

The following sequence illustrates the event boundaries. Delta events can repeat, and a
response can contain multiple reasoning, text, or function-call output items.

```text
response.created → response.in_progress
  → (reasoning) output_item.added(reasoning)
               → response.reasoning_summary_text.delta (repeats as needed)
               → response.reasoning_summary_text.done
               → output_item.done
  → (text)     output_item.added → content_part.added
               → response.output_text.delta (repeats as needed)
               → response.output_text.done
               → content_part.done → output_item.done
  → (tool call) output_item.added(function_call)
               → response.function_call_arguments.delta (repeats as needed)
               → response.function_call_arguments.done
               → output_item.done
  → response.completed   (or response.failed on error)
```

The endpoint sends a heartbeat every 5 seconds while it waits for the first model token.

## Errors

| Condition | Result |
| --- | --- |
| Request contains `previous_response_id` or `conversation` | `400` |
| Requested model is unknown | `404` |
| Requested model is unavailable | `503` |
| Streaming fails after the SSE response starts | Terminal `response.failed` event |

Unrecognized request fields are ignored, not errors.

## Model resolution

The endpoint uses the same `resolveModel()` path as the agent loop. It checks local backends
first. If another host serves the requested model, inference streams over the relay
transport. Local and relayed inference have the same response shape, so the client cannot
tell from the response which host served the request.

For `model`, `"default"` and omission both select the default local backend. The [Errors](#errors)
table lists failures for unknown or unavailable models.

## Client configuration

The default web server listens only on loopback. Bound accepts and ignores a bearer token so
clients that require an API-key value can connect. That ignored value is a compatibility
placeholder, not authentication: Bound does not validate it or use it to authorize the
request. Do not treat a dummy API key as access control. See
[Security boundaries](/bound/concepts/security-boundaries/) before exposing the endpoint
beyond its default network boundary.

### OpenAI Python SDK

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

### Polytoken

Configure a custom OpenAI-compatible provider that uses the Responses protocol:

```yaml
providers:
  bound-responses:
    kind:
      type: custom_open_ai_compatible
      name: openai
    url: http://localhost:3001
    auth:
      type: no_auth
    protocol: openai_responses
```

Then point model entries at the `bound-responses` provider.
