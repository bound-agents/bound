# RFC: Dynamic Model Catalog and Metadata Resolution

**Supplements:** `2026-03-29-model-robustness.md`, `2026-11-21-model-routing.md`  
**Date:** 2026-11-21  
**Status:** Draft

---

## 1. Problem Statement

Bound currently requires operators to hand-author per-model metadata — context windows, capabilities, output limits, pricing, and tier numbers — in every host's `model_backends` configuration, except for self-configuring providers (such as Umans) whose APIs publish complete model metadata directly. Maintaining static per-model entries across multiple hosts is high-friction and drifts as providers ship new models, change pricing, or adjust per-account entitlements.

The naive alternative — shipping a hardcoded model catalog inside the `bound` binary — is equally unmaintainable. It lags behind provider releases, cannot represent user-specific entitlements or private/local models, and forces Bound releases for routine model-lineup changes.

At the same time, unified cross-host routing (`2026-11-21-model-routing.md`) needs four things that individual sparse provider configs do not supply on their own:

1. **Complete per-route metadata** (capabilities, context window, max output tokens, pricing) without requiring manual duplication across hosts;
2. **Logical model identity** that groups equivalent provider-specific model IDs across providers and hosts without a hardcoded lookup table;
3. **Driver-declared fallback capabilities** (whether a provider supports server-side default fallback, publishes allowed fallback targets, or mints fallback credit tokens); and
4. **Cluster-level model roles** (`default`, `heavy`, `fast`) for auxiliary-agent and Yard model selection without per-model tier numbers.

This RFC defines a dynamic, zero-hardcoded-model-list catalog built from **live provider APIs first**, enriched by **`models.dev` as a cached fallback**, normalized structurally into logical models, and refined by synced cluster overrides.

---

## 2. Goals, Scope, and Non-Goals

### 2.1 Goals

These goals bind every requirement in this RFC and its companion. Where an existing configuration value or code path was chosen for a reason that conflicts with them, the conflict is raised with the operator as a decision; it is not resolved silently in either direction.

- **Minimal configuration.** An operator configures only what no provider API or registry can supply: credentials, endpoints, and deliberate overrides. Any value a provider API or `models.dev` publishes is derived, not copied into config.
- **No hardcoded model lists.** Behavior never branches on model ID strings. Capabilities, limits, prices, and fallback eligibility come from provider APIs, `models.dev`, or driver-level declarations.
- **No invented constants.** Every threshold, limit, and policy traces to a provider, the registry, or measured history. A value with no such source is a design question, not a default.
- **Maintained sources over hand-maintained copies.** When local config and an upstream source disagree on a published fact, the upstream source is authoritative unless the operator sets an explicit override.
- **Internal identifiers stay internal.** Grouping keys, `RouteId`s, and other identifiers that exist for matching or addressing are never presented to users as model names.

### 2.2 In scope

This RFC defines:

- the layered metadata resolution pipeline (local config overrides → live provider APIs → `models.dev` fallback);
- provider discovery contracts and driver-level fallback-capability declarations;
- `models.dev` ingestion, caching, offline behavior, and matching rules;
- structural ID normalization for grouping provider-specific model IDs into logical models, plus synced operator alias overrides;
- cluster-level fallback defaults and named model roles replacing `tier`; and
- the operator surfaces for inspecting resolved metadata and resolving unassigned models.

### 2.3 Non-goals

- This RFC does **not** hardcode a static list of model IDs, capabilities, prices, or fallback pairs in the Bound binary.
- This RFC does **not** define route ranking, thread stickiness, health/backoff, or refusal retry mechanics; those live in `2026-11-21-model-routing.md`.
- This RFC does **not** replicate provider credentials or per-host entitlements; discovery runs on each host using its own local credentials and publishes only non-secret route metadata.
- This RFC does **not** make `models.dev` a hard runtime dependency. A host must start and serve models whose required metadata is supplied by provider APIs or local config even when `models.dev` is unreachable.

---

## 3. Layered Metadata Resolution

Every concrete backend on a host resolves its effective `ModelMetadata` by merging three sources in strict precedence order (highest precedence wins per field):

| Precedence | Source | Authority over |
|---|---|---|
| **1 (highest)** | **Local `model_backends` config** | Operator-explicit overrides (`context_window`, `max_output_tokens`, `capabilities`, `price`, `logical_model`, `thinking`, `effort`, `cache_ttl`, `safety_settings`) |
| **2** | **Live provider API discovery** | User-specific entitlements, live model lineup, provider-published capabilities, context/output limits, pricing, and `allowed_fallback_models` |
| **3 (fallback)** | **`models.dev` registry cache** | Missing fields left unset by both local config and provider APIs (capabilities, context/output limits, pricing, vendor, modality) |

### 3.1 Effective metadata shape

```ts
type ModelMetadata = {
  provider_model_id: string;
  logical_model: string | null;
  vendor: string | null;
  capabilities: {
    streaming: boolean;
    tool_use: boolean;
    system_prompt: boolean;
    prompt_caching: boolean;
    vision: boolean;
    extended_thinking: boolean;
    // Structured reasoning metadata derived from provider discovery or the
    // registry's `reasoning` / `reasoning_options`. `supported` is the reasoning
    // boolean; `toggle` means an on/off reasoning switch is advertised;
    // `effort_values` is the published effort ladder in source order; `adaptive`
    // means the provider advertises model-controlled adaptive thinking (only some
    // provider catalogs publish it). A driver derives a backend's reasoning
    // request from these fields plus its own protocol rules when the backend sets
    // no explicit `thinking`, never from a model-ID test.
    reasoning?: {
      supported: boolean;
      toggle?: boolean;
      effort_values?: string[];
      adaptive?: boolean;
    };
    max_context?: number;
  };
  max_output_tokens?: number;
  pricing?: {
    input_per_m?: number;
    output_per_m?: number;
    cache_read_per_m?: number;
    cache_write_5m_per_m?: number;
    cache_write_1h_per_m?: number;
    // Context-based price tiers, ascending by `threshold` (the context size a
    // request must exceed for the tier rate to apply). The base rates above
    // apply at or below the lowest threshold. `threshold` is the registry's
    // `cost.tiers[].tier.size`; the legacy `cost.context_over_200k` duplicate of
    // the single context tier is not represented separately.
    tiers?: {
      threshold: number;
      input_per_m?: number;
      output_per_m?: number;
      cache_read_per_m?: number;
      cache_write_5m_per_m?: number;
      cache_write_1h_per_m?: number;
    }[];
  };
  allowed_fallback_models?: string[]; // provider-published, when supported
  field_sources: Record<string, "config" | "provider" | "models_dev" | "driver_default">;
};
```

Recording `field_sources` makes every resolved value inspectable in the UI and CLI without guessing where a context window or price came from.

Resolved `pricing` carries any context-based tiers the source publishes. Cost calculation selects the tier whose `threshold` the turn's request size (input + cache-read + cache-write tokens) strictly exceeds; the base rates apply at or below the lowest threshold. Local config `price` / `price_per_m_*` are operator overrides over this resolved pricing: a `price(turn)` callback is authoritative, an explicitly-set `price_per_m_*` (including a deliberate `0`) overrides the corresponding resolved field, and an unset field falls through to the provider- or `models.dev`-published rate. A model no layer can price records its turn cost as unknown rather than a misleading `0`.

### 3.3 Prompt caching: request, observe, price

Bound does not model per-provider cache semantics ahead of time. An aggregating provider (GitHub Copilot, Bedrock Mantle, request routers) inherits each upstream's semantics per model and wire protocol, and may choose the upstream per request; an "OpenAI-compatible" endpoint shares a request shape, not cache behavior. Any static per-provider model of TTLs, write billing, or reporting is wrong somewhere. Caching instead follows three steps per request.

**Request.** When the route's wire protocol defines a cache-lifetime field, the driver sends the configured `cache_ttl` in it: Anthropic Messages `cache_control.ttl`, Bedrock Converse `cachePoint.ttl`, OpenAI Responses `prompt_cache_options.ttl`. A protocol without such a field gets none. When a provider rejects a request specifically because of a cache field (an invalid-value or unsupported-parameter error naming that field), the driver retries once: with the provider-listed supported value when the error lists one, otherwise without the field. It remembers the outcome in local route state, and the rejection is never a route failure. Explicit cache breakpoints use the same rule. This recovery exists so a turn never fails over a cache field; it is not a source of capability metadata, because many providers ignore unknown fields silently.

**Observe.** Drivers normalize usage to cache-read tokens, cache-write tokens, and, when the provider reports one, a per-lifetime write split (`{ ttl, tokens }[]`). Reported splits include Anthropic Messages `usage.cache_creation.ephemeral_*_input_tokens` (also returned through Copilot and Mantle) and Bedrock Converse `usage.cacheDetails[].ttl`. A provider-reported charge is captured when the response carries one.

**Price.** A turn's cache writes are priced from what was reported, in this order:

1. a provider-reported charge for the turn;
2. a published per-lifetime write price multiplied by the reported split;
3. a published write price multiplied by unsplit write tokens, or by split tokens whose lifetime has no published price, recorded with pricing source `estimate`;
4. unknown.

Per-lifetime write prices come from provider discovery (for example Copilot's `cache_write_1h_price`), from `models.dev` `cache_write` (which describes the protocol's default lifetime), or from a local `price_per_m_cache_write_1h` override. Bound never derives a per-lifetime price from a vendor multiplier: whether a reseller inherits its upstream's multipliers is a fact about that reseller, not a protocol rule.

**Effective cache window.** Thread stickiness (`2026-11-21-model-routing.md` §5.3) uses a route's effective cache window: the longest gap between consecutive turns on that route after which the later turn still reported cache-read tokens, measured from `turns` on the serving host. A route without such history uses the lifetime it last requested.

### 3.2 Completeness gate

Consistent with `2026-11-21-model-routing.md` (R-RT2), a backend is only eligible for routing once its resolved `capabilities.max_context` is known from at least one of the three sources. A model absent from provider metadata and `models.dev` with no local `context_window` override stays unready and surfaces a clear configuration gap rather than dispatching turns on a guessed window.

A `max_output_tokens` resolved from provider metadata or `models.dev` is capped at 25% of the resolved `capabilities.max_context`. Context management reserves the output limit out of the window when it sizes the prompt and assumes that reservation is small relative to the window; some providers publish an output limit equal to the whole window. A `max_output_tokens` set in local config is never capped.

---

## 4. Provider API Discovery and Driver Capabilities

### 4.1 Live provider discovery

Provider drivers implement an optional discovery hook (`discoverModels()`) that queries the provider's native inventory endpoint using the host's local credentials:

- **Self-configuring providers** (Umans, GitHub Copilot): publish the account's entitled lineup, capabilities, context/output limits, and pricing directly.
- **Direct vendor APIs** (Anthropic `/v1/models`, OpenAI `/v1/models`, Bedrock `ListFoundationModels` / `ListInferenceProfiles`, Ollama `/api/tags` + `/api/show`, OpenAI-compatible `/v1/models`): supply live model availability and whatever metadata fields each API exposes. When Anthropic `/v1/models` is queried with the fallback beta header, the driver captures `allowed_fallback_models` per model.
- **Per-account entitlements:** because discovery runs locally on each host with that host's credentials, seat-specific or plan-specific entitlements (such as Copilot Free vs. Enterprise, or region-scoped Bedrock profiles) are respected automatically and never overridden by `models.dev`.

### 4.2 Driver-level fallback capabilities

Refusal-fallback capabilities are declared as a **driver-level property** (`FallbackSupport`), not as a hardcoded model table:

```ts
type DriverFallbackSupport = {
  /** Provider accepts a server-side automatic fallback directive (e.g. Anthropic API `fallbacks: "default"`). */
  server_side_auto: boolean;
  /** Provider publishes per-model `allowed_fallback_models` via its models API. */
  publishes_allowed_targets: boolean;
  /** Provider can mint and redeem prompt-cache fallback credit tokens on refusal (e.g. Anthropic API, Bedrock Runtime, Bedrock Mantle). */
  supports_fallback_credit: boolean;
};
```

Each driver declares its static protocol capabilities:

| Driver | `server_side_auto` | `publishes_allowed_targets` | `supports_fallback_credit` |
|---|---|---|---|
| `anthropic` | `true` | `true` | `true` |
| `bedrock` / `bedrock-mantle` | `false` | `false` | `true` |
| `openai-compatible` / `chatgpt-oauth` / `github-copilot` / `opencode-go` / `umans` | `false` | `false` | `false` |

Routing (`2026-11-21-model-routing.md`, `R-RT17`–`R-RT18`) reads `DriverFallbackSupport` to decide whether a model in `auto` fallback mode delegates to the provider's server-side default or walks Bound's cluster default fallback list.

---

## 5. `models.dev` Fallback Registry

`models.dev` serves strictly as a **gap-filling metadata fallback** — never as an entitlement list and never overriding live provider APIs or local config.

### 5.1 Fetch, caching, and offline resilience

- Each host fetches the `models.dev` catalog JSON (`https://models.dev/api.json`, configurable URL or disable flag in host config for air-gapped environments) on startup and refreshes it periodically in the background (default: every 24 hours, respecting HTTP `ETag` / `If-None-Match`).
- The last successfully fetched snapshot is cached locally on disk (outside synced tables; it is public upstream metadata, not cluster state).
- If `models.dev` is unreachable at startup or refresh, the host falls back to its cached snapshot; if no cache exists, the host proceeds using local config and provider APIs alone without failing startup.

### 5.2 Provider-to-registry matching

To look up a backend in `models.dev`, Bound maps the backend's `provider` to its `models.dev` provider namespace and normalizes `provider_model_id` using the single structural normalization rule set defined in §6.1.

If a model is present in `models.dev`, only fields missing from both local config and live provider discovery are populated from it. If a model is absent from `models.dev` (brand-new releases, private fine-tunes, custom local models), resolution still succeeds whenever provider APIs or local config supply the required fields.

---

## 6. Logical Model Normalization and Grouping

Because Bound maintains no hardcoded model-ID table, grouping equivalent models across providers relies on **structural normalization** plus **synced operator overrides**.

### 6.1 Resolution precedence and normalization rules

For each discovered or configured backend, Bound determines its `logical_model` in order:

1. **Cluster-synced alias override** — an explicit operator mapping for `provider_key = ${provider}:${provider_model_id}` in the synced `model_aliases` table (`2026-11-21-model-routing.md`, `R-RT6`), including an explicit `null` to keep a backend ungrouped. `model_aliases` is cluster-global and last-writer-wins per `provider_key`; an operator who wants a host-local grouping uses local config `logical_model` instead.
2. **Local config `logical_model`** — an explicit logical model ID declared on the backend entry (or the static `id` for manually named backends).
3. **Structural normalization** — one deterministic pattern rule set (shared with `models.dev` lookup in §5.2) applied to `(provider, provider_model_id)`, deriving the canonical key from naming patterns rather than an enumerated model list:
   - strip region/routing prefixes (`us.`, `eu.`, `ap.`, `global.`);
   - strip vendor prefixes: dashed vendor prefixes (`copilot-`, `bedrock-`), the enumerated dotted vendor prefixes outside Bedrock namespaces (`anthropic.`, `openai.`, `google.`), and — inside the Bedrock-style namespaces (`bedrock`, `bedrock-mantle`, and the `models.dev` `amazon-bedrock` namespace) — a `<vendor>.<model>` segment detected **structurally**: a leading dotted segment whose head carries no digit is a vendor segment and is dropped, so `moonshotai.`, `zai.`, `deepseek.`, `amazon.`, and any future Bedrock vendor collapse to the same family key as the direct provider, while a family-version head (`gpt-5.4`, `glm-5.2`, `kimi-k2.5`) is left intact because its head carries a digit;
   - strip deployment revision suffixes (`-v1:0`, `:0`, dated snapshot suffixes when a family key is present);
   - normalize punctuation separators (`.` vs `-` in version numbers) into one canonical form.

A **provider-local pseudo-model** — a provider's own session-router token that selects a concrete model per request rather than naming one (GitHub Copilot `auto`) — never normalizes to a bare cross-provider key. It is scoped to a provider-qualified key (`${provider}:${token}`, e.g. `github-copilot:auto`) so it can never pool with another provider's identically-named token, and is treated as an unrecognized namespace (§6.2) so it never auto-groups.

### 6.2 Confidence predicate and unassigned backends

Structural normalization is considered **confident** if and only if both conditions hold:

1. the backend belongs to a recognized hosted/discovered provider namespace (not an arbitrary local/custom `openai-compatible` tag lacking vendor qualification); and
2. the normalized canonical key matches either a `models.dev` canonical model entry or an already-confirmed logical model in the cluster (from static config or `model_aliases`).

- When confident, the backend attaches to that logical model automatically and is marked as automatic in Settings › Models so the operator can inspect or split it in one click.
- Otherwise (opaque gateway aliases, bespoke local tags, or colliding unqualified names), the backend is advertised with `logical_model: null`. It does not silently pool with other models and appears under **Unassigned backends** in Settings › Models with suggested matches for one-click assignment.

---

## 7. Cluster Fallback Defaults and Model Roles

Removing `tier` and hardcoded model lists leaves two cluster-wide concepts that operators configure directly over their own logical models in synced storage (`2026-11-21-model-routing.md`, `R-RT6`):

### 7.1 Cluster default fallback list and per-model overrides

Per-model fallback policies live in synced `model_routing_rules.fallback_policy` (one LWW row per `LogicalModelId`), and the cluster-wide default list lives in `cluster_config['routing.default_fallback_models']`:

```ts
type ModelFallbackPolicy =
  | { mode: "auto" }
  | { mode: "never" }
  | { mode: "custom"; models: LogicalModelId[] };
```

Absence of a `fallback_policy` row for a logical model means `{ mode: "auto" }`.

Resolution for a logical model `M` on refusal:

1. **`mode: "never"`** — no model substitution; surface the refusal directly.
2. **`mode: "custom"`** — walk `models` in the operator's exact declared order (filtering out `M` itself and any model failing the turn's required capabilities).
3. **`mode: "auto"` (default)**:
   - If the active route's driver declares `server_side_auto: true`, delegate to the provider's server-side default fallback (`fallbacks: "default"`).
   - Otherwise, walk the provider's `allowed_fallback_models` (when `publishes_allowed_targets: true` and mapped to available logical models), followed by `routing.default_fallback_models` filtered by the turn's `CapabilityRequirements`.
   - When the active route's driver declares `supports_fallback_credit: true` and a `fallback_credit_token` is present, same-endpoint co-located targets from the resolved list are attempted inside the driver first (`2026-11-21-model-routing.md`, `R-RT18`), stepping down cleanly if the provider rejects the target as credit-ineligible.

### 7.2 Named cluster roles

To replace `tier` as the capability signal for auxiliary agents, Yard `infer()` model selection, and system defaults without classifying every model in a catalog, `cluster_config['routing.model_roles']` stores a small set of named roles:

```ts
type ClusterModelRoles = {
  default: LogicalModelId;
  heavy?: LogicalModelId;
  fast?: LogicalModelId;
};
```

`ClusterModelRoles.default` is the authoritative cluster-wide default for omitted or `"default"` model requests; per-host `model_backends.default` is optional and acts only as a local bootstrap fallback when `ClusterModelRoles.default` is unset. Auxiliary-agent guidance and Yard recipes reference these roles (and inspect each logical model's live resolved pricing and `max_context`) rather than per-model `tier` integers.

### 7.3 Provider and model removal

When a provider is removed from a host or a logical model is no longer advertised anywhere in the cluster (`2026-11-21-model-routing.md`, `R-RT22`–`R-RT24`):

- **Synced `model_aliases`:** entries for removed providers or `provider_model_id`s are left dormant rather than cascade-deleted so temporary provider outages or config reverts do not discard operator mappings. Settings › Models marks unreferenced mappings as stale and allows manual pruning.
- **Fallback lists (`routing.default_fallback_models` and `model_routing_rules.fallback_policy`):** missing logical models are skipped at runtime when walking the fallback chain and flagged as stale in Settings › Models for operator cleanup.
- **Cluster roles (`default`, `heavy`, `fast`) and auxiliary agent definitions (`agents.model_hint`):** if a role or auxiliary agent points at a decommissioned logical model, Bound raises an operator advisory and flags the dangling reference in Settings › Models rather than silently reassigning it. Auxiliary agents targeting a cluster role follow the role's current assignment.
- **Re-introduction:** if a previously decommissioned logical model is re-advertised, unpruned dormant `model_aliases` and fallback-list entries become active again, stale markers clear in Settings › Models, and open dangling-reference advisories for cluster roles or auxiliary agents auto-resolve.
- **Cluster roles (`default`, `heavy`, `fast`), auxiliary agent definitions (`agents.model_hint`), and live scheduled tasks (`tasks.model_hint`):** if a role, auxiliary agent, or live task (`pending`/`claimed`/`running`) points at a decommissioned logical model, Bound raises an operator advisory and flags the dangling reference in Settings › Models rather than silently reassigning it. Auxiliary agents and tasks targeting a cluster role follow the role's current assignment. Scheduled tasks matter because heartbeats are never poison-pill parked — a dead heartbeat `model_hint` re-arms and fails silently forever, so the advisory is the operator's only signal.
- **Re-introduction:** if a previously decommissioned logical model is re-advertised, unpruned dormant `model_aliases` and fallback-list entries become active again, stale markers clear in Settings › Models, and open dangling-reference advisories for cluster roles, auxiliary agents, or scheduled tasks auto-resolve.

---

## 8. Requirements

### 8.1 Layered metadata and zero hardcoded lists

**R-MC1.** Bound shall not ship a hardcoded list of model IDs, per-model capabilities, per-model pricing, or per-model fallback pairs in its binary.

**R-MC2.** Effective metadata for every backend shall resolve by merging three layers in strict precedence order: (1) local `model_backends` config overrides, (2) live provider API discovery, and (3) cached `models.dev` fallback metadata. Every resolved field shall track its source (`config | provider | models_dev | driver_default`) for operator inspection.

**R-MC3.** Live provider discovery shall run locally on each host using that host's own credentials. `models.dev` shall never grant model availability or override a host's live provider entitlements.

**R-MC4.** A backend whose merged metadata lacks `capabilities.max_context` across all three layers shall remain unready, shall not be advertised as routable, and shall surface a clear configuration error rather than substituting a guessed default.

### 8.2 `models.dev` registry cache

**R-MC14.** Drivers shall send the configured `cache_ttl` in the route protocol's own cache-lifetime field when one exists, shall recover from a rejection of a cache field by one retry with the provider-listed value or without the field, shall remember that outcome in local route state, and shall never count it as a route failure. Cache capability shall not branch on model ID strings.

**R-MC15.** Turn cost shall price cache writes from a provider-reported charge, else published per-lifetime prices times the reported write split, else a published write price times unreported or unpriced write tokens recorded as `estimate`, else unknown. No per-lifetime price shall be derived from a vendor multiplier.

**R-MC16.** A route's effective cache window shall be measured from `turns` as the longest inter-turn gap followed by a cache read on that route, falling back to the last requested lifetime when no such history exists.

**R-MC5.** Each host shall fetch and cache `models.dev` metadata locally on disk with conditional HTTP refresh (`ETag` / `If-None-Match`) on a configurable interval (default 24 hours). The cache shall be local-only and shall not sync through `change_log`.

**R-MC6.** `models.dev` fetch failures shall never block daemon startup or model serving. An unreachable registry shall fall back to the local disk cache, or to local config and provider APIs alone when no cache exists. Operators shall be able to disable `models.dev` fetching or point it at a custom URL in host config.

### 8.3 Driver capabilities and normalization

**R-MC7.** Each LLM driver shall declare a static `DriverFallbackSupport` descriptor (`server_side_auto`, `publishes_allowed_targets`, `supports_fallback_credit`). Routing and refusal-fallback logic shall branch on this descriptor rather than provider-name conditionals or hardcoded model tables.

**R-MC8.** One shared structural normalization rule set shall be used for both `models.dev` matching and logical-model grouping, deriving canonical keys from provider naming patterns without enumerating specific model names. Synced `model_aliases` (cluster-global LWW per `provider_key`) shall take precedence over both local config `logical_model` and structural normalization.

**R-MC9.** Automatic structural grouping shall occur only when the confidence predicate (§6.2) holds (recognized provider namespace AND canonical key matches `models.dev` or a confirmed cluster logical model). Unqualified or unmatched auto-registered backends shall be advertised with `logical_model: null`, excluded from automatic pooling, and surfaced under Unassigned backends in Settings › Models.

### 8.4 Fallback defaults and cluster roles

**R-MC10.** Per-model fallback policies (`auto | never | custom`) shall live in synced `model_routing_rules` (one LWW row per `LogicalModelId`), while `routing.default_fallback_models` and `routing.model_roles` (`default`, `heavy`, `fast`) shall live in synced `cluster_config`, obeying Invariants #1, #2, and #20. `ClusterModelRoles.default` shall take precedence over optional local `model_backends.default`.

**R-MC11.** In `auto` fallback mode, a driver with `server_side_auto: true` shall use the provider's server-side default fallback; a driver with `server_side_auto: false` shall fall back through provider-published `allowed_fallback_models` (when available) and then `routing.default_fallback_models` filtered by the turn's required capabilities. Per-model `custom` or `never` policies shall override `auto` behavior for that logical model.

**R-MC12.** Auxiliary-agent and Yard model selection metadata shall expose resolved `max_context`, resolved pricing, and named cluster role assignments (`default`, `heavy`, `fast`) in place of `tier`.

**R-MC13.** Removing a provider or logical model shall not cascade-delete synced `model_aliases`, `routing.default_fallback_models`, or `model_routing_rules.fallback_policy`: runtime fallback traversal shall skip missing logical models, unreferenced entries shall be surfaced as stale for manual cleanup, and dangling cluster role or auxiliary-agent model references shall raise an operator advisory rather than silently reassigning. When a previously removed model or provider is re-advertised, unpruned dormant entries shall reactivate automatically and open dangling-reference advisories shall auto-resolve.

---

## 9. Operator Surfaces

- **Settings › Models — Metadata inspector:** expanding any route displays its resolved `max_context`, `max_output_tokens`, capabilities, pricing, and the provenance badge (`config`, `provider`, `models.dev`, `default`) for each field, plus the `models.dev` cache status and a manual refresh trigger.
- **Settings › Models — Unassigned and automatic mappings:** lists ungrouped auto-registered backends with one-click assignment to an existing or new logical model, and lists automatic structural matches with one-click split/override.
- **Settings › Models — Fallback defaults and roles:** provides one ordered list for `default_fallback_models`, per-model fallback overrides (`Automatic` | `Custom list` | `Never substitute`), and dropdowns for the named cluster roles (`default`, `heavy`, `fast`), flagging stale or dangling references for one-click cleanup.

---

## 10. Acceptance Criteria

- **Zero hardcoded model list:** no source module in Bound enumerates specific model IDs to supply capabilities, pricing, or fallback targets.
- **Precedence order:** a test verifying all three layers confirms local config overrides live provider metadata, live provider metadata overrides `models.dev`, and `models.dev` fills only unset fields, with accurate `field_sources`.
- **Entitlement preservation:** a model present in `models.dev` but absent from a host's live provider discovery (e.g., Copilot Free vs. Enterprise) is not advertised as available on that host.
- **Offline resilience:** starting a host with `models.dev` unreachable succeeds using cached disk metadata, and succeeds with no cache when provider APIs or local config supply `max_context`; a model lacking `max_context` across all layers stays unready.
- **Structural normalization:** provider-specific IDs following standard region/vendor/revision patterns (including synthetic future model names not present in any registry) normalize to the same logical model; synced `alias_mappings` override both normalization and local config.
- **Driver-level fallback dispatch:** in `auto` mode, a driver with `server_side_auto: true` delegates to the provider's default fallback, while a driver with `server_side_auto: false` walks the cluster's `default_fallback_models`; per-model `custom` and `never` overrides supersede `auto` on both driver types.
- **Roles replace `tier`:** auxiliary-agent and Yard model selection operates on named cluster roles and resolved metadata with no `tier` field in config, router state, or host advertisements.
- **Provider and model removal and re-introduction:** removing a provider leaves synced `alias_mappings` dormant and pruneable; removing a logical model skips it in fallback chains without error and raises an advisory for any dangling cluster role or auxiliary-agent reference; re-advertising the model reactivates unpruned entries and auto-resolves dangling-reference advisories.
