# Inference Backends

LLM driver shims and model routing — the `@bound/llm` package.

---

## @bound/llm

The LLM package provides a unified streaming interface over multiple model providers. All drivers implement the same `LLMBackend` interface, and a `ModelRouter` selects the appropriate driver at call time.

### Core Types

**Source:** `packages/llm/src/types.ts`

#### LLMBackend

```typescript
interface LLMBackend {
  chat(params: ChatParams): AsyncIterable<StreamChunk>;
  capabilities(): BackendCapabilities;
}
```

Every driver is an `LLMBackend`. `chat` returns an async iterable so callers can process tokens as they arrive without buffering the entire response.

#### ChatParams

```typescript
interface ChatParams {
  model?: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  system_suffix?: string;
  cache_breakpoints?: number[];
  cache_ttl?: "5m" | "1h";
  thinking?: { type: "enabled"; budget_tokens: number };
  signal?: AbortSignal;
}
```

`model` is optional; if omitted, the driver uses the model from its constructor config. `system_suffix` carries varying system context placed AFTER the cached system prefix — when `cache_breakpoints` is set, it is sent as a separate uncached system block so it does not bust the prompt cache; otherwise it is appended to `system`. `cache_breakpoints` is an array of message indices at which to insert Anthropic prompt caching markers — ignored by drivers that do not support prompt caching. `cache_ttl` selects the cache-tier requested at the breakpoint; it is forwarded by `ai-sdk-bridge.toModelMessages` as `ttl` on the `cachePoint` (Bedrock) or `cache_control` (Anthropic) attribute. Bedrock `"1h"` is supported only on Claude Opus 4.5+, Sonnet 4.5+, and Haiku 4.5+; setting `"1h"` on an unsupported model falls back to default. `thinking` enables extended thinking (Anthropic / Bedrock produce reasoning content blocks; other backends silently ignore it). `signal` is an optional `AbortSignal`; all four drivers accept it and will abort the in-progress stream when it fires.

#### LLMMessage

```typescript
type LLMMessage = {
  role: "user" | "assistant" | "system" | "tool_call" | "tool_result";
  content: string | ContentBlock[];
  tool_use_id?: string;   // set on tool_result messages
  model_id?: string;
  host_origin?: string;
};
```

`tool_call` and `tool_result` are Bound-internal roles that each driver translates into its provider's native representation before sending the request.

The shared bridge `packages/llm/src/ai-sdk-bridge.ts` (`toModelMessages`, `mapChunks`) is the single hand-off point from the Bound message shape to the AI SDK / provider message shapes. It exports `sanitizeToolUseId(id)` — `[a-zA-Z0-9_-]` charset rewrite followed by `slice(0, MAX_TOOL_USE_ID_LENGTH)` (64) — and re-uses `sanitizeToolName(name)` from `stream-utils.ts` (`[a-zA-Z0-9_-]{1,64}` with `unknown` empty fallback). Both are deterministic and idempotent so pairing between a `tool_use` and its `tool_result` is preserved across rewrites. The safe charset+length envelope is a strict subset of every supported provider's accepted shape, so the rewrite is lossless on the wire and avoids per-provider branching.

Sanitization runs at two layers, both belt-and-suspenders for different reasons:

1. **Streaming boundary** (`mapChunks`): `tool-input-start` / `-delta` / `-end` events sanitize id and name before yielding the matching `StreamChunk`s, so fresh tool calls land in the DB already wire-legal. A warn log fires only when length truncation occurred (`sanitized.length < input.length`); charset-only diffs stay silent because they're expected steady state for AI SDK fallback ids.
2. **Read boundary** (`toModelMessages`): same sanitization re-applied at all four tool_use sites — assistant `tool_call`-role tool_use parts, inline assistant content tool_use parts, `tool_result.tool_use_id`, and the `toolNameById` lookup index (keys + values, so tool_result resolution returns the sanitized name). On freshly-sanitized data this is an idempotent no-op; the real value is recovery — already-poisoned historical rows self-heal on next assembly without manual DB surgery.

Two pathologies have been observed in production driving these layers:
- **Charset (Kimi/Moonshot fallback ids)**: `tool_use.id` values persist in the `messages` table and survive provider switches. A thread that accumulated ids under the OpenAI-compatible path (where the AI SDK synthesizes ids of the shape `functions.<name>:<index>` when the upstream emits no explicit id) must remain routable to a stricter provider (Anthropic enforces `^[a-zA-Z0-9_-]+$` and rejects the entire request otherwise).
- **Length+charset (Kimi/Moonshot template-token leakage, thread `81bd5e8d` 2026-05-21)**: the same path occasionally streams Moonshot's own `<|tool_call_argument_begin|>` template token mid-stream as plain text, which the AI SDK collapses into a 200+ char synthesized `tool_use.id` and `tool_use.name`. The next turn fails with 6 simultaneous Bedrock validation errors (`length less than or equal to 64`, `must satisfy regular expression pattern`) on both the `toolUse` and the matching `toolResult`. The read-boundary layer recovers such threads without manual intervention.

When adding a new id-bearing or name-bearing field at the bridge boundary, route it through `sanitizeToolUseId` / `sanitizeToolName`.

#### ContentBlock

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "image"; source: ImageSource; description?: string }
  | { type: "document"; source: ImageSource; text_representation: string; title?: string };
```

#### ImageSource

```typescript
type ImageSource =
  | { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
  | { type: "file_ref"; file_id: string };
```

`base64` is used for inline images under 1 MB. `file_ref` is used when an image is stored in the `files` table (at or above 1 MB), referencing it by its file ID rather than embedding the data directly. The context assembly pipeline substitutes unsupported blocks when `ContextParams.targetCapabilities` is set: image blocks become `[Image: description]` text annotations for non-vision backends, and document blocks always become their `text_representation` regardless of backend.

#### StreamChunk

All drivers emit the same discriminated union:

```typescript
type StreamChunk =
  | { type: "text";           content: string }
  | { type: "thinking";       content: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_args";  id: string; partial_json: string }
  | { type: "tool_use_end";   id: string }
  | { type: "done"; usage: {
      input_tokens: number;
      output_tokens: number;
      cache_write_tokens: number | null;
      cache_read_tokens: number | null;
      estimated: boolean;
    }}
  | { type: "error"; error: string };
```

A complete tool call sequence is: `tool_use_start` -> one or more `tool_use_args` -> `tool_use_end`. The stream always terminates with `done`.

`cache_write_tokens` and `cache_read_tokens` are only populated by the AnthropicDriver and BedrockDriver when prompt caching is active; other drivers set them to `null`. `estimated: true` indicates the values were estimated rather than returned directly by the API.

#### BackendCapabilities

```typescript
interface BackendCapabilities {
  streaming: boolean;
  tool_use: boolean;
  system_prompt: boolean;
  prompt_caching: boolean;
  vision: boolean;
  extended_thinking: boolean;
  max_context: number;
}
```

Used by callers to determine which features are available before constructing a request.

#### LLMError

```typescript
class LLMError extends Error {
  constructor(
    message: string,
    public provider: string,
    public statusCode?: number,
    public originalError?: Error,
    public retryAfterMs?: number,
  )
}
```

All drivers throw `LLMError` on connection failures and non-2xx HTTP responses. `retryAfterMs` is populated by `checkHttpError` in `error-utils.ts`, which parses the `Retry-After` header on 429 and 529 responses (converting seconds to milliseconds, defaulting to 60 000 ms if the header is absent or non-numeric). The agent loop passes this value to `modelRouter.markRateLimited()` when retrying with a different backend.

---

### OllamaDriver

**Source:** `packages/llm/src/ollama-driver.ts`

Targets a locally running Ollama instance. Streams responses over NDJSON: the response body is read line-by-line, and each line is parsed as a separate JSON object.

```typescript
const driver = new OllamaDriver({
  baseUrl: "http://localhost:11434",  // default if using createModelRouter
  model: "llama3.2",
  contextWindow: 4096,
});
```

**Protocol details:**
- POST to `<baseUrl>/api/chat` with `stream: true`.
- Each line in the response body is a complete `OllamaStreamResponse` JSON object.
- The final object has `done: true` and carries `prompt_eval_count` / `eval_count` for token usage.
- Tool calls arrive in a single non-streaming chunk on the `message.tool_calls` array; the driver synthesises the `tool_use_start` / `tool_use_args` / `tool_use_end` sequence from them.

**Capabilities:** streaming, tool use, system prompt, extended thinking. No prompt caching or vision.

---

### AnthropicDriver

**Source:** `packages/llm/src/anthropic-driver.ts`

Targets the Anthropic Messages API at `https://api.anthropic.com/v1/messages`. Streams responses over SSE (Server-Sent Events).

```typescript
const driver = new AnthropicDriver({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-4-5",
  contextWindow: 200000,
});
```

**Protocol details:**
- POST to `https://api.anthropic.com/v1/messages` with `stream: true`.
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`.
- Each SSE line prefixed with `data: ` carries an `AnthropicStreamEvent`. Relevant event types:
  - `content_block_start` with `content_block.type === "tool_use"` — emits `tool_use_start`.
  - `content_block_delta` with `delta.type === "text_delta"` — emits `text`.
  - `content_block_delta` with `delta.type === "input_json_delta"` — accumulates partial tool arguments.
  - `content_block_stop` — if a tool was in progress, emits `tool_use_args` with the accumulated JSON, then `tool_use_end`.
  - `message_stop` — emits `done`.

**Prompt caching:** When `cache_breakpoints` is set in `ChatParams`, the driver attaches `cache_control: { type: "ephemeral" }` to the messages at those indices before sending the request. This instructs Anthropic's API to cache the KV state up to those points.

**Capabilities:** streaming, tool use, system prompt, prompt caching, vision, extended thinking.

---

### BedrockDriver

**Source:** `packages/llm/src/bedrock-driver.ts`

Targets the AWS Bedrock Converse Stream API. Uses the `@aws-sdk/client-bedrock-runtime` SDK's `ConverseStreamCommand`, so the standard AWS credential chain (env vars, shared config, instance profile, etc.) applies. An optional `profile` config selects a named credentials profile.

```typescript
const driver = new BedrockDriver({
  region: "us-east-1",
  model: "anthropic.claude-opus-4-5-20251101-v1:0",
  contextWindow: 200000,
});
```

**Protocol details:**
- Uses `BedrockRuntimeClient.send(new ConverseStreamCommand(...))`; the SDK handles SigV4 signing, endpoint construction, and event-stream framing. The driver iterates the SDK's async event iterator directly.
- Events are delivered as discriminated objects with camelCase keys: `contentBlockStart` (may carry `start.toolUse`), `contentBlockDelta` (`delta.text`, `delta.toolUse.input`, or `delta.thinking.text`), `contentBlockStop`, and `metadata`.
- Token usage is reported on the `metadata` event, including `cacheWriteInputTokens` / `cacheReadInputTokens` when prompt caching is active.
- Tool ids and names are sanitised at the shared AI SDK bridge (see "Shared bridge" above for both layers and the recovery semantics) — not in the driver itself.

**Capabilities:** streaming, tool use, system prompt, prompt caching, vision, extended thinking.

---

### OpenAICompatibleDriver

**Source:** `packages/llm/src/openai-driver.ts`

Targets any endpoint that speaks the OpenAI Chat Completions API. Suitable for OpenAI itself, Azure OpenAI, vLLM, and other compatible servers.

```typescript
const driver = new OpenAICompatibleDriver({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
  contextWindow: 128000,
});
```

**Protocol details:**
- POST to `<baseUrl>/chat/completions` with `stream: true` and `Authorization: Bearer <apiKey>`.
- Streams SSE. The sentinel `data: [DONE]` terminates the stream.
- Tool calls stream incrementally: each chunk may carry a `tool_calls` array with a `function.arguments` fragment. The driver maintains a per-index state map and emits `tool_use_start` on the first chunk for a given tool index, `tool_use_args` for each argument fragment, and `tool_use_end` when the stream finishes (detected via `finish_reason`).

**Capabilities:** streaming, tool use, system prompt, extended thinking. No prompt caching or vision.

---

### ModelRouter

**Source:** `packages/llm/src/model-router.ts`

`ModelRouter` holds a registry of named backends and routes `chat` calls to the right one. It is constructed from a `ModelBackendsConfig` using `createModelRouter`.

#### Configuration

```typescript
interface BackendConfig {
  id: string;
  provider: string;  // "anthropic" | "bedrock" | "bedrock-mantle" | "openai-compatible" | "cerebras" | "zai" | "opencode-go"
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  [key: string]: unknown;  // provider-specific fields (apiKey, region, profile, tier,
                           //   pricePerMInput, thinking, and an optional
                           //   `capabilities: Partial<BackendCapabilities>` that merges
                           //   over driver-reported capabilities)
}

interface ModelBackendsConfig {
  backends: BackendConfig[];
  default: string;  // must match one of the ids in backends
}
```

Provider-specific extra fields:

| Provider | Required extra fields | Optional extra fields |
|---|---|---|
| `anthropic` | `apiKey` | `contextWindow` (default 200 000) |
| `bedrock` | `region` | `profile`, `contextWindow` (default 200 000) |
| `openai-compatible` | `apiKey` | `baseUrl` (default `http://localhost:8000`), `contextWindow` (default 8 192) |
| `cerebras` | `apiKey` | `baseUrl` (default `https://api.cerebras.ai/v1`), `contextWindow` (default 128 000) |
| `zai` | `apiKey` | `baseUrl` (default `https://api.z.ai/api/coding/paas/v4`), `contextWindow` (default 128 000) |

`cerebras` and `zai` are thin wrappers that delegate to `OpenAICompatibleDriver` with provider-specific defaults.

#### createModelRouter

`createModelRouter(config)` instantiates all configured backends and returns a `ModelRouter`. When multiple entries share the same `id`, they are wrapped in a `PooledBackend` that fails over between sub-backends on rate-limit (429), payment-required (402), and server-error (5xx) responses, using exponential backoff per sub-entry. As a special case, an empty `backends` array produces a hub-only router with no local backends (inference is proxied to spokes); otherwise, `createModelRouter` throws `LLMError` if the default backend ID is not present in the backends list.

```typescript
import { createModelRouter } from "@bound/llm";

const router = createModelRouter({
  backends: [
    {
      id: "primary",
      provider: "anthropic",
      model: "claude-opus-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    {
      id: "local",
      provider: "openai-compatible",
      model: "llama3.2",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
    },
  ],
  default: "primary",
});
```

#### ModelRouter methods

| Method | Description |
|---|---|
| `getBackend(modelId?)` | Returns the backend registered under `modelId`, or the default backend if `modelId` is omitted. Throws if the ID is not found. |
| `tryGetBackend(modelId)` | Returns the backend registered under `modelId`, or `null` if not found (non-throwing variant). |
| `getDefault()` | Returns the default backend directly. |
| `getDefaultId()` | Returns the default backend ID string. |
| `listBackends()` | Returns `BackendInfo[]` — an array of `{ id, capabilities }` for every registered backend, using effective capabilities (driver baseline merged with config override). |
| `listEligible(requirements?)` | Returns backends that are not currently rate-limited, optionally filtered by `CapabilityRequirements`. Sorted by registration order. |
| `markRateLimited(id, retryAfterMs)` | Marks a backend as rate-limited for `retryAfterMs` milliseconds. The backend is excluded from `listEligible()` until the window expires. |
| `isRateLimited(id)` | Returns `true` if the backend is currently rate-limited. Automatically clears expired entries. |
| `getEarliestCapableRecovery(requirements?)` | Returns the earliest expiry timestamp (ms) among rate-limited backends that satisfy `requirements`, or `null` if none exists. Used by `resolveModel()` to populate `earliestRecovery` on transient-unavailable errors. |
| `getEffectiveCapabilities(id)` | Returns the merged capabilities (driver-reported baseline plus any config `capabilities` override) for the given backend ID, or `null` if not found. |

#### Streaming a response

```typescript
const backend = router.getDefault();

const stream = backend.chat({
  model: "claude-opus-4-5",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Explain monads in one paragraph." }],
  max_tokens: 512,
});

for await (const chunk of stream) {
  switch (chunk.type) {
    case "text":
      process.stdout.write(chunk.content);
      break;
    case "tool_use_start":
      console.log(`Tool call started: ${chunk.name} (${chunk.id})`);
      break;
    case "tool_use_args":
      // Accumulate chunk.partial_json for the tool with chunk.id
      break;
    case "tool_use_end":
      console.log(`Tool call complete: ${chunk.id}`);
      break;
    case "done":
      console.log(`\nTokens used — in: ${chunk.usage.input_tokens}, out: ${chunk.usage.output_tokens}`);
      break;
    case "error":
      console.error(`Stream error: ${chunk.error}`);
      break;
  }
}
```

To use a non-default backend by ID:

```typescript
const localBackend = router.getBackend("local");
```

To inspect available backends and their capabilities before selecting one:

```typescript
for (const { id, capabilities } of router.listBackends()) {
  console.log(id, capabilities);
}
```
