# RFC: Capability-Aware Model Resolution

**Supplements:** `2026-03-20-base.md` §4.6, §9.2, §12.3; `2026-03-25-service-channel.md` §5; `2026-03-26-inference-relay.md` AC2, AC6
**Date:** 2026-03-29
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Model Selection Treats Backends as Interchangeable

The current model resolution pipeline maps model identifiers to backends via string equality: a model ID either matches a locally-configured backend key or appears in a remote host's `models` JSON array. No intermediate validation examines whether the resolved backend can actually handle the request that triggered the resolution. A backend that cannot process images will accept a conversation containing images. A backend with a 4096-token context window will accept a conversation that requires 100K tokens. The mismatch surfaces as a provider-level error deep in the backend protocol layer — or worse, as silently degraded output — rather than as a clear resolution-time rejection with actionable alternatives.

The system already declares per-backend capabilities (`streaming`, `tool_use`, `system_prompt`, `prompt_caching`, `vision`, `max_context`) as part of the LLM backend protocol (§4.6). These declarations are populated by every provider and exposed for enumeration. They are simply never consulted during routing.

### 1.2 Content Types Cannot Represent Multimodal Input

The internal message content model defines two block types: `text` and `tool_use`. There is no representation for image content, audio content, document attachments, or any non-text user input. Platform connectors (Discord, and eventually others) accept multimodal input natively — Discord users can attach images to messages, and the platform connector must persist them. When these messages enter the context assembly pipeline, the content blocks are reduced to text only and everything else is discarded. The image data is silently dropped before it reaches any provider.

This is particularly dissonant because some providers (including `anthropic` and `bedrock`) report `vision: true` in their capability declarations (§4.6), advertising a capability the content type system cannot exercise. The gap will widen as platform connectors are added (per `2026-03-27-platform-connectors.md`) and as models increasingly accept multimodal input.

### 1.3 Capabilities Are Per-Provider, Not Per-Model

Each provider protocol (§4.6) returns a static capability declaration. The `anthropic` provider always reports `vision: true`; the `ollama` provider always reports `vision: false`. But capabilities vary by model within a provider:

- GPT-4V via the `openai-compatible` provider supports vision, but the provider reports `vision: false`.
- Llava via the `ollama` provider supports vision, but the provider reports `vision: false`.
- A text-only model hosted on the Anthropic API would incorrectly inherit `vision: true` from the provider declaration.
- Context window sizes vary dramatically within a single provider: Ollama-served models range from 2K to 128K, yet the provider defaults to a single configured value.

The per-provider declaration was a reasonable simplification for initial implementation, but it prevents the system from making correct routing decisions as the model pool grows.

### 1.4 No Cost or Quota Awareness

The model resolution pipeline has no concept of API quotas, rate limits, billing tiers, or cost asymmetry between backends. An operator running both a prepaid Anthropic subscription and pay-per-use Bedrock has no way to express "prefer Anthropic credits first." An operator with a free-tier API key hitting rate limits receives transient failures that retry the same exhausted endpoint rather than falling back to an alternative backend.

The base spec's `daily_budget_usd` (R-U35) and per-backend pricing fields (`price_per_m_*` in §12.3) provide cost tracking and autonomous-task throttling, but these are reactive controls. The routing layer itself is cost-blind — it cannot prefer cheaper backends for routine work or reserve expensive backends for complex tasks.

### 1.5 Remote Model Resolution Lacks Capability Metadata

When the model router falls back to remote hosts (via the relay), it queries the `hosts` table for rows whose `models` JSON array contains the requested model ID. This is a pure string match. No capability metadata is stored or transmitted for remote models. The requesting host cannot determine whether the remote model supports vision, tool use, or the context window size required for the current conversation — it can only confirm that a model with a matching name exists somewhere in the cluster.

### 1.6 Token Usage Asymmetry Across Providers

The base spec records per-turn token usage (R-U29) and uses context window limits for budget validation during context assembly (§9.2, Stage 7). This depends on accurate token counts from each backend. However, not all providers expose usage information in their streaming response format with equal fidelity. A backend that reports zero tokens consumed would corrupt downstream cost tracking, daily budget enforcement (R-U35), and advisory generation (R-U33).

### 1.7 Tool Call Identity Collisions

The internal streaming protocol (§4.6) uses unique identifiers to correlate `tool_use_start`, `tool_use_args`, and `tool_use_end` events within a single model turn. When a backend's native API does not provide unique tool call identifiers, the system must synthesize them. If a non-unique value is used (such as the function name), multiple calls to the same tool within a single turn produce identical identifiers. The context assembly pipeline's tool pair sanitizer (§9.2 Stage 3) tracks these identifiers across the conversation history; collisions cause incorrect pairing and orphaned tool results.

---

## 2. Proposal

### 2.1 Summary

Introduce a capability-aware model resolution layer between the model identifier namespace and the backend dispatch. Model resolution becomes a three-phase process: **identify** (map the model ID to a backend or remote host), **qualify** (verify the backend's capabilities satisfy the request's requirements), and **dispatch** (forward the request to the qualified backend). Requests that fail qualification receive a structured rejection listing the unmet capabilities and suggesting alternatives from the cluster-wide model pool.

Extend the content block type system to support multimodal input. Add per-model capability overrides to the backend configuration schema. Introduce usage extraction contracts for all providers. Define tool call identity requirements that prevent collisions regardless of the provider's native API.

### 2.2 What This Changes

The following base spec sections are affected:

| Section | Change |
|---|---|
| §4.6 (LLM Backend Protocol) | Extended with multimodal content blocks, per-model capability overrides, usage extraction contract (four-tier cache-aware), tool call identity requirements, and a new qualification phase in the resolution pipeline |
| Streaming Protocol Extension (new, supplements §4.6) | New `done` chunk schema with `cache_write_tokens` and `cache_read_tokens` fields, `null` semantics for unavailable metrics, provider-specific extraction table |
| §9.2 (Context Assembly) | Content block pipeline handles image/document blocks; replaces multimodal blocks with text annotations when the target backend lacks vision, preserving prefix cache stability |
| §12.3 (model_backends.json) | Schema gains per-model `capabilities` overrides; existing `tier` field (already in schema) is used as-is for advisory cost classification |
| R-U11 (Model selection) | Extended with capability-aware validation |
| R-U2 (Model metadata) | Extended with capability snapshot |
| inference-relay.AC2 | Remote hosts advertise capability metadata alongside model IDs |

### 2.3 Design Principles

**Capabilities gate routing for the current request; historical context degrades gracefully.** When the current inference request requires a capability the resolved backend lacks (e.g., the user just sent an image to a non-vision backend), the system rejects the request with a clear error and suggests alternatives — it does not silently strip the content and proceed. However, when the conversation *history* contains multimodal content from earlier turns but the current request is text-only, the system may replace historical multimodal blocks with text annotations in the assembled context, allowing the user to continue on a non-vision backend without losing the entire thread. The replacement is performed in-place to preserve the prompt's prefix cache stability (§5.5).

**Per-model overrides, per-provider defaults.** Provider protocol implementations (§4.6) continue to provide baseline capability declarations. Per-model overrides in `model_backends.json` refine these declarations for specific models. The override merges with (not replaces) the provider default, so only the fields that differ need to be specified.

**Cost awareness is advisory, not prescriptive.** The system surfaces cost information to the agent and operator but does not enforce cost-based routing automatically. The operator controls cost boundaries via `daily_budget_usd` (R-U35) and per-backend pricing (§12.3). Automatic cost-optimized routing (e.g., "use the cheapest vision-capable backend") is deferred to v2 alongside model-trust heuristics (R-O2).

**Fail loud at resolution, not at the provider.** A capability mismatch detected at resolution time produces a structured error with the unmet requirements, the resolved backend's actual capabilities, and a list of alternative backends (local and remote) that satisfy the requirements. This is actionable. A provider-level error (400 from the API, garbled output from a model that cannot handle the input) is not.

---

## 3. Requirements (EARS Format)

Requirements in this section use the prefix `R-MR` (Model Robustness) to distinguish them from base spec requirements. Numbering is independent.

### 3.1 Ubiquitous

**R-MR1.** The system shall support a content block type for image data, carrying at minimum: the image media type, a size-bounded payload (inline base64 or a reference to a synced file), and an optional text description. This block type shall be a peer of text and tool_use blocks in the internal message schema.

**R-MR2.** The system shall support a content block type for document attachments (PDF, plaintext files), carrying at minimum: the document media type, a reference to the document content, a page/size summary, and a pre-extracted text representation. The text representation shall be produced during ingestion (R-MR14) so that context assembly has a pre-computed textual fallback without needing to perform extraction on-the-fly. This block type shall be a peer of text and tool_use blocks in the internal message schema. Capability gating for document blocks (i.e., whether a given backend can process native document input) is deferred; all backends shall receive document blocks as their pre-extracted text representation during context assembly.

**R-MR3.** The system shall derive a capability requirement set from each inference request prior to backend dispatch. The requirement set shall include, at minimum: whether the request contains image content blocks, whether the request includes tool definitions, whether the request includes a system prompt, and whether the request uses prompt caching directives. (Document content blocks — R-MR2 — are not capability-gated in this RFC; they are converted to text for all backends.)

**R-MR4.** The system shall verify that the resolved backend's declared capabilities satisfy the request's derived capability requirements before dispatching the request. A mismatch shall produce a structured error identifying each unmet capability, the resolved backend's actual capabilities, and a list of alternative backends (local and cluster-wide) whose capabilities satisfy the request. The error shall distinguish between two failure modes: (a) **capability mismatch** — no backend in the cluster declares the required capabilities, and (b) **transient unavailability** — backends with the required capabilities exist but are all currently rate-limited (R-MR16) or unreachable. In case (b), the error shall include the earliest expected recovery time (the shortest remaining rate-limit window) so the user or agent can decide whether to wait or switch models.

**R-MR5.** The backend configuration schema (`model_backends.json`) shall support per-model capability overrides. Overrides shall merge with the provider's baseline capability declaration (§4.6), with per-model values taking precedence. At minimum, the following capabilities shall be overridable: `vision`, `tool_use`, `system_prompt`, `prompt_caching`, and `max_context`.

**R-MR6.** The system shall extract token usage information from each provider's response stream and report it in the terminal `done` chunk of the streaming protocol. The extended `done` chunk (defined in this RFC's Streaming Protocol Extension, supplementing §4.6) shall include four token categories matching the metrics schema (§9.7): `input_tokens` (uncached input), `output_tokens`, `cache_write_tokens` (tokens written to prompt cache this turn), and `cache_read_tokens` (tokens served from prompt cache). Where the provider's streaming format includes a usage event with cache-specific fields (e.g., Anthropic's `cache_creation_input_tokens` and `cache_read_input_tokens`), the system shall parse and report those values. Where the provider does not distinguish cache tokens from regular input tokens (e.g., OpenAI's automatic prefix caching, which does not surface cache hit/miss counts in the response), the system shall report all input tokens as `input_tokens` with `cache_write_tokens` and `cache_read_tokens` as `null`, marking the cache fields as `unavailable` in the usage record. (`null` means the provider does not report this field, per §4.4 — distinct from `0`, which would mean the provider confirmed no cache activity.) Where the provider does not report token usage at all (e.g., some subscription-plan endpoints that omit usage from API responses), the system shall fall back to character-ratio estimation for all four fields and mark the entire usage record as `estimated` per R-MR26.

**R-MR7.** The system shall assign a unique identifier to each tool call emitted during a single model turn. Where the provider's native API supplies unique tool call identifiers, the system shall propagate them. Where the provider does not supply unique identifiers, the system shall synthesize them using a deterministic scheme that guarantees uniqueness within a turn (e.g., `{provider}-{model}-{turn_timestamp}-{index}`).

**R-MR8.** The system shall persist multimodal content blocks in the messages table. Image blocks shall be stored in a form that supports both inline retrieval (for context assembly) and size-efficient storage (for large images, a reference to a synced file rather than inline base64). The storage representation shall round-trip without loss: a persisted image block, when retrieved and re-serialized for a vision-capable backend, shall produce an input the backend accepts. File-referenced content relies on the normal sync protocol for cross-host replication; the system does not eagerly fetch referenced files on demand. R-MR27 governs the behavior when a file reference cannot be resolved at assembly time.

**R-MR9.** Each host's `models` advertisement (in the `hosts` table and sync protocol) shall include per-model capability metadata alongside the model identifier. At minimum: `vision`, `tool_use`, `max_context`. Remote model resolution shall use this metadata to filter eligible hosts, not just the model name.

**R-MR10.** The system shall surface the existing `tier` field (already defined in `model_backends.json` schema as an integer 1–5) in the orientation context (§9.2) and in the `hostinfo` command output, enabling the agent and operator to make informed model selection decisions. Lower tier numbers indicate lower cost. Automatic tier-based routing is not required.

### 3.2 Event-Driven

**R-MR11.** When the context assembly pipeline replaces historical image content blocks with text placeholders due to backend capability limitations (R-MR15), the system shall emit an advisory (per §9.7) recommending a vision-capable backend and listing available alternatives. Where the current backend supports prompt caching (§9.2) and a model switch would invalidate the cached prefix, the advisory should note the cache-rebuild cost. The advisory ensures the operator is informed of the capability gap, even though the current turn may proceed without the historical images. To prevent advisory accumulation, the system shall emit at most one such advisory per thread per backend: once an advisory has been emitted for a given thread and backend combination, subsequent replacements in the same thread on the same backend shall not produce additional advisories.

**R-MR12.** When a backend returns an HTTP 429 (rate limit) or 529 (overloaded) response, the system shall record the rate-limit event with the backend identifier and retry-after duration. The model resolution layer shall treat the rate-limited backend as temporarily ineligible for the duration of the retry-after window. When selecting a fallback, the system shall prefer backends in the following order: (a) another backend serving the same underlying model (matching the `model` field in `model_backends.json`), (b) a backend serving a different model that satisfies the request's capability requirements. If no eligible fallback exists, the system shall return a transient-unavailability error (per R-MR4) with the earliest expected recovery time, rather than blocking until the rate-limit window expires. An automatic fallback constitutes a model switch and shall insert a system message per R-U11, annotated as an automatic rate-limit fallback rather than a user-initiated change.

**R-MR13.** When a `model-hint` command is issued, the system shall validate the hint against the cluster-wide model pool including capability metadata. The validation shall confirm both that the model exists (on any reachable host) and that it supports the capabilities used in the current thread's recent history (e.g., if the thread contains image blocks, the hinted model must support vision). A hint that fails validation shall be rejected with a diagnostic message. Where the model resolution infrastructure is unavailable (e.g., during bootstrap or in degraded single-host configurations), the system shall accept the hint with a logged warning indicating that capability validation was skipped.

**R-MR14.** When a new platform connector delivers a message containing multimodal content (image attachments, document uploads), the system shall normalize the content into the internal block representation (R-MR1, R-MR2) during ingestion. Platform-specific encoding details (Discord CDN URLs, Telegram file IDs) shall not leak into the persisted message.

### 3.3 State-Driven

**R-MR15.** While assembling context for a backend that does not declare `vision: true`, the context assembly pipeline shall replace image content blocks in *historical* messages with text content blocks containing an annotation, in-place within the original message's content block array (preserving the message's position and the surrounding prefix for cache stability per §5.5). (Image blocks in the *current* request are handled by the qualification phase — R-MR4 — which rejects dispatch entirely.) The replacement shall be logged. Where the replaced image block carries a `description` field (R-MR1), the annotation text shall include that description, giving the model textual context about the image's content even though the image data itself is unavailable.

**R-MR16.** While a backend is in a rate-limited state (R-MR12), the model resolution layer shall skip it during candidate enumeration. The backend shall re-enter the eligible pool after the rate-limit window expires.

**R-MR17.** While multiple backends are configured with the same model identifier (e.g., the same model accessible via both Anthropic API and Bedrock), the system shall prefer the backend with the lowest `tier` value. If tier values are equal, the system shall prefer local backends over remote backends per the existing resolution order.

### 3.4 Optional / Deferred

**R-MR18.** Where per-model capability metadata is not configured (no overrides in `model_backends.json`), the system shall fall back to the provider's baseline capability declaration (§4.6). This preserves backward compatibility with existing configurations that omit per-model overrides.

**R-MR19.** Where a backend supports vision but the operator wishes to disable it for cost or policy reasons, the per-model capability override (R-MR5) shall allow setting `vision: false` to suppress image content routing to that backend, even though the underlying provider reports `vision: true`.

**R-MR20.** Automatic cost-optimized routing *across different models* — selecting the cheapest backend that satisfies a request's capability requirements from the full model pool — is deferred to v2 alongside model-trust heuristics (R-O2). The `tier` field (R-MR10) and per-backend pricing (§12.3) provide the data model; the cross-model routing logic is deferred. Same-model tiebreaking (R-MR17), where the system chooses between multiple backends offering the identical model, is in scope for v1 as a deterministic disambiguation rule rather than an optimization strategy.

**R-MR21.** Where the provider's streaming protocol supports real-time token counting (e.g., partial usage events mid-stream), the system may expose running token counts to the context assembly pipeline for more accurate budget validation. This is an optimization over the current character-ratio estimation and is not required for initial implementation.

**R-MR22.** Where a backend configuration specifies an explicit tokenizer identifier (e.g., `cl100k_base`, `claude`), the context assembly pipeline may use it for more accurate token estimation during budget validation (§9.2 Stage 7). Where no tokenizer is specified, the system shall continue using the existing character-ratio approximation.

### 3.5 Unwanted Behavior

**R-MR23.** If a conversation contains image content blocks and no vision-capable backend is available in the cluster (locally or remotely), the system shall not silently discard the images. The system shall return a clear error to the user indicating that no vision-capable backend is configured, and suggest adding one. For threads originating from platform connectors (Discord, etc.), the orchestrator shall deliver this error through the platform's send mechanism — the error is an orchestrator-generated message, not an agent response, and does not require a successful agent loop or LLM call.

**R-MR24.** If a tool call event is emitted with an identifier that duplicates a previous tool call identifier within the same model turn, the system shall detect the collision and reassign a unique identifier before the event enters the context assembly pipeline. The reassignment shall be logged as a warning.

**R-MR25.** If the resolved backend reports a `max_context` smaller than the assembled context's estimated token count, the system shall not silently truncate. Where the model was selected by default or by agent hint (not explicitly by the user via the web UI model selector per R-U11), the system shall first attempt to resolve an alternative backend with a larger context window. Where the user explicitly selected the model, automatic re-resolution shall not occur — the system proceeds directly to truncation. If no alternative is available (or re-resolution was suppressed), the system shall truncate per the existing budget validation rules (§9.2 Stage 7) and insert a system annotation noting the forced truncation and the amount of context lost.

**R-MR26.** If a backend reports zero token usage on a response that clearly produced output (non-empty text or tool call content), the system shall log a warning and mark the entire usage record as `estimated`. Downstream cost tracking (R-U29) and daily budget enforcement (R-U35) shall use the character-ratio estimate as a fallback rather than recording zero consumption. Token usage records shall distinguish three states per field: `reported` (value came from the provider's response), `unavailable` (provider does not expose this field, e.g., cache breakdown on a prefix-caching provider), and `estimated` (value was computed from character-ratio approximation because the provider returned no usage data at all). The `unavailable` state for cache fields is distinct from a reported zero — it means the system cannot determine cache performance, not that no caching occurred.

**R-MR27.** If a multimodal content block references a synced file via `file_ref` (R-MR8) and that file cannot be resolved at context assembly time (deleted, not yet synced to the assembling host, or corrupt), the system shall replace the block in-place with a text content block indicating that the referenced image or document was unavailable (preserving prefix cache stability per §5.5). The system shall not fail the entire context assembly or agent loop due to an unresolvable file reference.

---

## 4. Data Model Changes

### 4.1 Content Block Type Extension

The internal content block union gains two new variants:

| Block type | Required fields | Optional fields | Notes |
|---|---|---|---|
| `image` | `media_type`, `source` | `description`, `size_bytes` | `source` is either `{ type: "base64", data: string }` or `{ type: "file_ref", path: string }` |
| `document` | `media_type`, `source`, `text_representation` | `title`, `page_count`, `size_bytes` | Same `source` union as `image`. `text_representation` is the pre-extracted text content produced during ingestion. |

The `file_ref` source type references a path in the synced `files` table. Large images and documents should use file references to avoid bloating the messages table. The threshold for switching from inline to file-ref is an operator-configurable value (recommended default: 1 MB).

### 4.2 Backend Configuration Schema Extension

The `model_backends.json` schema gains the following fields per backend entry:

| Field | Type | Default | Notes |
|---|---|---|---|
| `capabilities` | `Partial<BackendCapabilities>` | `{}` | Per-model overrides. Merged with provider defaults per R-MR5. |
| `tier` | `integer (1–5)` | *(required, already in schema)* | Advisory cost classification. Lower = cheaper. Surfaced in orientation and hostinfo. Already validated by existing schema; no schema change needed. |

Example:

```json
{
  "backends": [
    {
      "id": "ollama-llava",
      "provider": "ollama",
      "model": "llava:13b",
      "tier": 1,
      "capabilities": {
        "vision": true,
        "max_context": 32768
      }
    },
    {
      "id": "openai-gpt4",
      "provider": "openai-compatible",
      "model": "gpt-4o",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "...",
      "tier": 4,
      "capabilities": {
        "vision": true,
        "max_context": 128000
      }
    }
  ],
  "default": "ollama-llava"
}
```

### 4.3 Host Model Advertisement Extension

The `hosts.models` column (currently a JSON array of model ID strings) shall be extended to a JSON array of objects:

```json
[
  {
    "id": "ollama-llava",
    "tier": 1,
    "capabilities": {
      "vision": true,
      "tool_use": true,
      "max_context": 32768
    }
  }
]
```

For backward compatibility, the parser shall accept both the legacy string-array format and the new object-array format. A string entry (e.g., `"ollama-llava"`) is treated as `{ "id": "ollama-llava" }` with no capability metadata. When remote resolution encounters a host with no capability metadata for a requested model, the following interpretation applies:

- **Capability-gated requests** (the request's R-MR3 requirement set is non-empty — e.g., vision required): The host is treated as **unverified** for the required capability. The system shall prefer hosts with explicit capability metadata that confirms the requirement. If no verified host is available but unverified hosts exist, the system may select an unverified host with a logged warning noting that capability verification was not possible. This avoids both false negatives (skipping a valid host because it didn't advertise) and silent failures (routing to a host that can't handle the request).
- **Unconstrained requests** (the request's requirement set is empty — text-only, no special features): The host is eligible, no warning needed. This preserves full backward compatibility for the common case.

### 4.4 Streaming Protocol Extension (supplements §4.6)

The `done` chunk in the streaming protocol (§4.6) shall be extended to carry four-tier token usage aligned with the metrics schema (§9.7):

| Field | Type | Notes |
|---|---|---|
| `input_tokens` | `integer` | Uncached input tokens (regular input cost) |
| `output_tokens` | `integer` | Output tokens |
| `cache_write_tokens` | `integer \| null` | Tokens written to prompt cache this turn. `null` = provider does not report this field. |
| `cache_read_tokens` | `integer \| null` | Tokens served from prompt cache. `null` = provider does not report this field. |

The `null` semantic is critical: it distinguishes "provider does not expose cache metrics" (`null`) from "provider confirms no cache activity occurred" (`0`). The metrics layer (§9.7) maps `null` to the `unavailable` state and `0` to a reported zero. This distinction matters for cost tracking — a `null` cache read means the `cost_cache_read` column should also be `null` (unknown cost), not `0.00` (zero cost).

For backward compatibility, providers that only report two-field usage (input + output) shall emit `cache_write_tokens: null, cache_read_tokens: null` in the `done` chunk.

#### Provider-specific extraction

| Provider | Cache fields available | Notes |
|---|---|---|
| `anthropic` (API) | Yes: `cache_creation_input_tokens`, `cache_read_input_tokens` | Available on pay-per-token API plans. Map directly to `cache_write_tokens` and `cache_read_tokens`. |
| `anthropic` (subscription) | Varies | Subscription endpoints may omit per-request usage entirely, or may report totals without cache breakdown. System falls back to estimation (R-MR26). |
| `bedrock` | Yes: `cacheReadInputTokenCount`, `cacheWriteInputTokenCount` | Available in the `ConverseStream` metadata usage field when prompt caching is active. Map directly to `cache_read_tokens` and `cache_write_tokens`. When prompt caching is not enabled for the request, these fields are absent — report `null`. |
| `openai-compatible` | Varies | The OpenAI API returns `usage.prompt_tokens` and `usage.completion_tokens` in non-streaming responses, and optionally `usage.prompt_tokens_details.cached_tokens` when prefix caching is active. Streaming responses may omit usage entirely. Extract when available; `null` otherwise. |
| `ollama` | No | Reports `prompt_eval_count` and `eval_count` only. `cache_write_tokens: null, cache_read_tokens: null`. |

The provider-specific extraction behavior above reflects provider API capabilities as of this RFC's date. Provider APIs evolve — extraction logic should be updated as providers add or change cache reporting in their streaming APIs. The system's `null`-based fallback (report as `unavailable` when cache fields are absent) ensures graceful degradation if extraction logic lags behind a provider update.

#### Subscription vs API plan awareness

Providers offer both API-key access (pay-per-token, full usage reporting) and subscription access (flat monthly fee, limited or absent usage reporting). The system does not need to know which billing model is active — it simply extracts whatever usage the provider's response contains. The three-state model in R-MR26 (`reported` / `unavailable` / `estimated`) absorbs this distinction naturally:

- **API plans** typically return all four token fields → all `reported`.
- **Subscription plans** that return usage without cache breakdown → input/output `reported`, cache fields `unavailable`.
- **Subscription plans** that return no usage at all → all four fields `estimated` via character-ratio approximation.

Cost columns in the metrics schema (§9.7) are computed from the `price_per_m_*` fields in `model_backends.json` (§12.3). When usage is `estimated`, cost is also estimated. When usage is `unavailable`, cost is `null` (unknown). Operators who need cost tracking should use API-plan backends; the system does not prevent subscription-plan backends from working, it just cannot report their costs accurately.

---

## 5. Behavioral Descriptions

### 5.1 Extended Resolution Pipeline

The current resolution pipeline is two-phase (identify → dispatch). The extended pipeline is three-phase:

**Phase 1: Identify.** Unchanged. Map the model ID (or default) to a local backend or set of remote eligible hosts. Same-model tiebreaking (R-MR17) applies here: when multiple backends offer the identical model, the system prefers the lowest `tier` value, then local over remote. This is a namespace lookup with deterministic disambiguation, not a cost optimization.

**Phase 2: Qualify.** New. Derive the capability requirement set from the current request (R-MR3) — this covers capability flags (vision, tool use, system prompt, prompt caching) but not token budget, which cannot be known until after context assembly. Compare the flags against the resolved backend's effective capabilities (provider baseline merged with per-model overrides per R-MR5). If the backend satisfies all requirements, proceed to dispatch. If not, enumerate alternative backends (local first, then remote) that satisfy the requirements. If an alternative is found, re-resolve to that backend (with a context annotation noting the automatic re-resolution). If no alternative satisfies the requirements, return a structured error (R-MR4). Automatic re-resolution is per-turn: it does not persistently change the thread's model selection. On the next turn, resolution starts again from the thread's configured or default model. If a thread repeatedly triggers re-resolution, the advisory system (R-MR11) informs the operator that a persistent model switch would be more appropriate.

**Phase 3: Dispatch.** Forward the request to the qualified backend. Context assembly (§9.2) runs against the now-known target backend, applying capability-aware in-place content replacement (R-MR15). Token budget validation (§9.2 Stage 7) runs post-assembly against the target backend's `max_context`; if the budget is exceeded, R-MR25 governs the response.

The qualification phase is stateless and deterministic: given the same request capabilities and backend declarations, it always produces the same routing decision. It does not consider load, latency, or cost — those are advisory signals for the operator and agent, not routing inputs (R-MR20).

### 5.2 Multimodal Content Lifecycle

1. **Ingestion.** A platform connector receives a message with an image attachment. It downloads the image, determines its media type, and normalizes it into an `image` content block (R-MR14). Images exceeding the inline threshold are written to the `files` table and referenced via `file_ref`.

2. **Persistence.** The message (including the image block) is written to the `messages` table. The content column stores the serialized content block array. File-referenced images are persisted separately in the `files` table and replicated via normal sync.

3. **Context Assembly.** During context assembly (which runs within Phase 3, after the target backend is qualified), the pipeline encounters image blocks in the conversation history. It checks the target backend's effective capabilities. If `vision: true`, image blocks are included in the assembled context and converted to the provider's native image format during dispatch. If `vision: false`, image blocks in the conversation history are replaced in-place with text annotations per R-MR15, preserving the surrounding message structure and prefix cache stability (§5.5). An advisory is emitted per R-MR11. (Note: if the *current* request contained image blocks and the backend lacks vision, the qualification phase — R-MR4 — would have rejected the request before reaching context assembly.)

4. **Provider Conversion.** Each provider's message conversion layer (§4.6) handles image blocks according to that provider's API contract — converting the internal image block representation to the provider-native image format. Providers whose capability declarations include `vision: true` shall accept and convert image blocks. Providers whose declarations do not include `vision: true` shall never receive image blocks (guaranteed by the qualification phase).

### 5.3 Rate-Limit Backoff and Fallback

When a provider returns an HTTP 429 or 529 response:

1. The backend protocol layer (§4.6) raises a structured error with the status code and, if present, the `Retry-After` header value.
2. The system marks the backend as rate-limited for the specified duration (or a default of 60 seconds if no `Retry-After` is provided).
3. On the next resolution attempt within the rate-limit window, the qualify phase skips the rate-limited backend.
4. If no alternative backend satisfies the request's capability requirements, the system returns a transient-unavailability error immediately (per R-MR4 case b) — it does not block-wait for the rate-limit window to expire. The error includes the earliest recovery time, allowing the user or agent to retry after the window passes. Autonomous tasks (§10) should reschedule for after the recovery time rather than spinning.
5. When the rate-limit window expires, the backend re-enters the eligible pool.

This is strictly per-host state. A rate limit on host A's Anthropic backend does not affect host B's Anthropic backend, even if they use the same API key. Cross-host rate-limit coordination is deferred.

### 5.4 Tool Call Identity Guarantee

The backend protocol (§4.6) shall produce tool call identifiers that are:

- **Unique within a turn.** No two tool calls in the same model response share an identifier.
- **Stable across persistence.** The identifier used in `tool_use_start` matches the identifier stored in the `tool_call` message's content blocks and referenced by subsequent `tool_result` messages.
- **Deterministic when synthesized.** If the provider's native API does not supply unique identifiers, the system shall synthesize them using a scheme that guarantees uniqueness within a turn. The synthesis scheme is an implementation detail, but it must prevent collisions when the same tool is called multiple times in a single response.

The context assembly pipeline's tool pair sanitizer (§9.2 Stage 3) relies on these properties. A violation produces orphaned tool results or incorrect pairing, which triggers the existing synthetic tool_call injection — a costly fallback that this requirement aims to make unnecessary.

### 5.5 Prompt Cache Interactions

The base spec's prompt structure (§9.2) is designed for maximum prefix cache reuse: stable content first, volatile content last, with explicit cache breakpoints between layers. The conversation history (layer 3) is "prefix-stable" — new messages are always appended at the end, so the cached prefix grows monotonically. §9.3 goes to considerable lengths to preserve this ordering during tool-use sequences. Several behaviors introduced by this RFC interact with cache stability and must be handled carefully.

**Image block replacement (R-MR15).** The naive approach — removing image blocks from the conversation history and injecting a separate system annotation — would shift every subsequent message's position, invalidating the cached prefix from the first excluded image onward. To preserve cache stability, the system shall instead perform **in-place replacement**: within the original message's content block array, substitute the image block with a text block containing the annotation (including the image description if available). This preserves the message's position in the history, the message count, and the prefix up to and including the message before the substituted block. The prefix change is limited to the single content block that was replaced, rather than cascading through the entire suffix.

**File reference resolution failure (R-MR27).** The same in-place replacement strategy applies: an unresolvable `file_ref` block is replaced with a text placeholder at the same position within the same message, rather than being removed entirely.

**Model switching.** Any change in the target provider — whether initiated by the user (R-U11), the agent (`model-hint`), automatic re-resolution (R-MR4), or rate-limit fallback (R-MR12) — invalidates the prompt cache on the previous provider. This is unavoidable when the new provider is on different infrastructure. The cost implications are significant for providers with explicit caching (e.g., Anthropic, where cache writes cost 25% more than regular input while cache reads save 90%): the first turn after a switch pays the full cache-write premium with no reuse benefit. The system does not attempt to prevent model switches to preserve cache (that would conflict with the user's right to choose models per R-U11), but R-MR11's advisory for capability-driven switches should note the cache cost when applicable.

**Remote inference via relay.** When inference is relayed to a remote host, the remote host builds its own cache state from the transmitted prompt. If the same conversation was previously processed locally, no cache exists on the remote host — the first relayed turn is a full cache miss. Subsequent relayed turns to the same host benefit from the remote cache if the prompt prefix is stable. Switching back to local inference after remote turns similarly starts with a cache miss locally. This is a natural consequence of the relay architecture and is not mitigated by this RFC.

---

## 6. Interaction with Existing Specifications

### 6.1 Base Spec (2026-03-20)

- **R-U2** (model metadata per message): Extended. The message record should also capture a snapshot of the backend's effective `max_context` at the time of the response, enabling retrospective analysis of whether context was truncated.
- **R-U11** (model selection): Extended by R-MR4 and R-MR13. The model selector in the web UI should indicate per-backend capabilities (e.g., a vision icon next to vision-capable backends) so users can make informed selections.
- **R-U29** (metrics): Extended by R-MR6 and R-MR26. The `turns` table's four token columns (`tokens_input`, `tokens_output`, `tokens_cache_write`, `tokens_cache_read`) are now populated via the extended `done` chunk (§4.4). Token usage records distinguish three states: `reported`, `unavailable`, and `estimated`. Cost columns are `null` when usage is `unavailable`, estimated when usage is `estimated`, and computed from `price_per_m_*` when usage is `reported`.
- **R-U35** (daily budget): Depends on R-MR6. Accurate budget enforcement requires accurate token counts from all providers.
- **R-O1** (backend unavailability): Subsumed by R-MR12 and R-MR4. Rate-limited backends are a specific case of unavailability; the capability-aware resolution layer provides structured alternatives.
- **§9.2 / §9.3** (prompt caching and message ordering): R-MR15's in-place replacement strategy and R-MR27's file-ref fallback are specifically designed to preserve the prefix cache stability that §9.2 and §9.3 establish. Model switches (R-MR12, R-MR4 re-resolution) unavoidably invalidate provider-side cache state; §5.5 documents these interactions. The `cache_breakpoints` parameter (§4.6) continues to function unchanged — breakpoints are computed by the context assembly pipeline against the final assembled message sequence, after any image-to-text replacements.

### 6.2 Service Channel Spec (2026-03-25)

- **§5 (Inference Relay)**: Extended by R-MR9. Remote model advertisements carry capability metadata, enabling the requesting host to qualify a remote backend before committing to a relay round-trip.

### 6.3 Inference Relay Design (2026-03-26)

- **Cluster-wide model resolution** (inference-relay.AC2): Extended by R-MR9 and R-MR13. The relay's model-by-host resolution mechanism should filter by capability metadata in addition to model name. The resolution result includes capability metadata for remote models, not just host identity. A host advertising a model without vision should not be selected when the request requires vision.
- **Loop delegation heuristics** (inference-relay.AC6, §5.6 of the inference relay design): The delegation decision should consider capability match. Delegating to a host whose model lacks a required capability would produce a remote qualification failure — wasted relay overhead.

---

## 7. Migration Path

### 7.1 Backward Compatibility

All changes in this RFC are additive. Existing configurations without per-model capability overrides continue to work: the system falls back to provider-level defaults (R-MR18). Existing `hosts.models` string arrays are parsed as legacy format with no capability metadata. The qualification phase passes trivially when no capability requirements are derived (i.e., text-only conversations with no special features).

**model-hint behavioral change.** The base spec's `model-hint` command (§6.4, R-U11) currently accepts hints without validation when the model resolution infrastructure is unavailable. R-MR13 introduces capability-aware validation that could reject hints accepted under the prior behavior. To preserve backward compatibility, R-MR13 includes a fallback: when the resolution infrastructure is unavailable, hints are accepted with a logged warning. This ensures bootstrap and degraded-mode scenarios continue to work. When the resolution infrastructure IS available, the stricter validation applies — this is a deliberate tightening that may reject hints that would previously have been accepted and then failed at dispatch time.

### 7.2 Phased Adoption

**Phase A: Content type extension and usage extraction.** Add image and document block types to the content schema. Extend the streaming protocol's `done` chunk from two-field to four-field usage reporting (§4.4), including `null` semantics for unavailable cache metrics. Update all providers to extract real token usage including cache-specific fields where available. Fix tool call identity collisions. These are internal changes with no configuration impact.

**Phase B: Per-model capability overrides and qualification.** Add the `capabilities` field to `model_backends.json` (the `tier` field already exists). Implement the qualification phase in model resolution. Update context assembly to handle multimodal blocks. These require operator awareness but not immediate configuration changes.

**Phase C: Remote capability metadata.** Extend the host model advertisement format. Update the relay's remote resolution to filter by capabilities. This requires all cluster hosts to be updated before the extended format is fully effective.

### 7.3 Testing Strategy

- **Unit tests**: Qualification phase with various capability/requirement combinations. Content block serialization round-trips. Tool call identity uniqueness under all providers. Token usage extraction for each provider's streaming format.
- **Integration tests**: End-to-end multimodal conversation: image ingested via platform connector, persisted, assembled into context, dispatched to a vision-capable backend. Rate-limit fallback: inject a 429, verify the system re-resolves to an alternative backend.
- **Bedrock compatibility**: Multimodal content blocks must survive the context assembly pipeline's tool pair sanitizer (§9.2 Stage 3) without triggering the structural validation errors that stage is designed to prevent (tool pair adjacency violations, consecutive same-role messages, blank text content in assistant messages).
