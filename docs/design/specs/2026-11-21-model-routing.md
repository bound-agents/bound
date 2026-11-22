# RFC: Unified Model Routing, Route Health, and Refusal Fallback

**Supplements:** `2026-03-29-model-robustness.md`, `2026-06-29-unified-delegation.md`, `2026-08-31-durable-work-consolidation.md`  
**Companion:** `2026-11-21-model-catalog.md` (dynamic model catalog, metadata resolution, structural normalization, driver fallback capabilities, and cluster roles)  
**Date:** 2026-11-21  
**Status:** Draft

---

## 1. Problem Statement

Bound's model routing collapses three independent concerns into a single flat identifier lookup: which logical model a turn requests, which `(host, provider)` route serves it, and how a thread recovers when a route or model fails. That collapse produces five structural failures in multi-host, multi-provider clusters:

1. **Local backends unconditionally shadow remote backends.** Resolution short-circuits on any locally configured backend matching the model ID before evaluating remote hosts. An operator cannot prefer pay-per-use API pricing on a remote host over a local subscription, and a rate-limited or buggy local provider strands the turn even when a healthy remote host serves the same model.
2. **Auto-registered provider models cannot pool across providers.** Pooling keys on exact string equality of local backend IDs. Providers that discover and register models dynamically emit provider-specific names that cannot be grouped with the same logical model on another provider or host.
3. **`tier` conflates route priority with model equivalence.** Within one model, `tier` ranks pooled and remote routes; across models, `tier` defines substitute equivalence classes. Changing a host's `tier` to prefer one provider over another silently alters cross-model fallback semantics.
4. **Stateless selection and freshness tie-breaking thrash caches and provider-bound state.** Remote tie-breaking by heartbeat freshness flips consecutive turns between hosts and providers, invalidating prompt caches and breaking provider-bound state such as encrypted reasoning blocks. Short, thread-unaware circuit-breaker cooldowns snap active threads back onto flapping routes, paying repeated cache-write penalties.
5. **Model refusals are conflated with route errors or abandoned mid-stream.** Safety-filter stops (`stop_reason: "refusal"`, `content_filter`, Gemini safety blocks) arrive as HTTP 200 on some APIs and HTTP 400 on others. Generic 400 failover retries the same model on another route without resolving the refusal, while 200 refusals persist incomplete output as ordinary assistant messages and halt the turn. Naive loop-level retries onto another model forfeit provider fallback credits and pay full prompt-cache rewrites.

This RFC separates logical model identity from concrete routes, replaces `tier` with cluster-wide routing preferences and the dynamic model catalog (`2026-11-21-model-catalog.md`), introduces thread-sticky routing with automatic half-open recovery, and splits route failover from driver-level model refusal fallback.

---

## 2. Scope and Non-Goals

### 2.1 In scope

This RFC defines:

- the separation of **logical models** from concrete **routes** (building on the dynamic catalog and structural normalization in `2026-11-21-model-catalog.md`);
- the removal of `tier` in favor of cluster-synced per-model route ordering, fallback defaults, and named cluster roles;
- unified local-and-remote candidate ranking, thread-sticky routing, and hard route pins for debugging;
- system-owned route health with automatic half-open recovery and user-owned manual route drains;
- the classification split between **route failures** and **model refusals**, including driver-level refusal fallback, provider fallback-credit redemption, and per-attempt cost accounting; and
- the operator web UI model for model selection, provenance, notifications, and routing preferences.

### 2.2 Non-goals

- This RFC does **not** move the agent loop. The loop always runs on the trigger host and relays only inference and tool calls (`2026-06-29-unified-delegation.md`, R-UD1).
- This RFC does **not** alter `durable_work` transport semantics (`2026-08-31-durable-work-consolidation.md`) or add direct spoke-to-spoke transport.
- This RFC does **not** replicate provider credentials, API keys, or OAuth tokens across hosts. Credentials remain strictly local per host.
- This RFC does **not** use synthetic probe requests (pings) to test route health.

---

## 3. Core Model: Logical Models, Routes, and Identity

### 3.1 Logical models vs. routes

A **logical model** (for example, `gpt-5.6-sol`, `opus-4.8`, `fable-5`) is the model identity referenced by threads, scheduled tasks, auxiliary agents, Yard `infer()` calls, and the user-facing model picker.

A **route** is a single concrete serving endpoint in the cluster, uniquely identified by:

```ts
type RouteId = `${siteId}:${provider}:${backendId}`;
```

`RouteId` is the routing, health, pinning, and per-turn provenance identity. It is distinct from `reasoning_origin` (`${siteId}:${provider}[:${detail}]`), which is the provider mint-provenance stamp carried on encrypted reasoning blocks (where `detail` disambiguates provider deployments such as Bedrock Mantle `region:mode`, not `backendId`). A host's `ModelRouter` owns both properties on each local route entry: `RouteId` governs addressing, ranking, health, and stickiness; `reasoning_origin` governs encrypted-reasoning keep/drop compatibility at the driver boundary.

`PooledBackend` is removed. `ModelRouter` is a flat registry of local routes rather than a local pooling layer; same-model pooling is subsumed by unified candidate ranking (§5.1) and per-entry cooldowns are subsumed by per-`RouteId` route health (§6.1).

Each host advertises its ready local routes in its synced `hosts` record. Each advertised route carries:

- `route_id` (`site_id`, `provider`, `backend_id`),
- `logical_model` (canonical logical model ID, or `null` if unassigned),
- `provider_model_id` (raw upstream/auto-registered ID),
- `capabilities` (effective `BackendCapabilities`, including required `max_context`),
- `max_output_tokens`, `cache_ttl`, and `thinking_mode` metadata.

Not-ready self-configuring backends are excluded from route advertisements and candidate selection until their warmup completes.

### 3.2 Canonical mapping and dynamic catalog integration

Each host resolves a backend's effective metadata (`capabilities`, `max_context`, `max_output_tokens`, `pricing`, `allowed_fallback_models`) and its `logical_model` through the dynamic catalog defined in `2026-11-21-model-catalog.md` (`R-MC1`–`R-MC9`: local config overrides → live provider API discovery → `models.dev` fallback, with structural normalization and synced `model_aliases`). Bound ships no hardcoded list of model IDs, prices, or fallback pairs.

An auto-registered backend that does not match an alias override, local `logical_model`, or confident structural normalization (`R-MC8`–`R-MC9`) remains **unassigned**: it is advertised with `logical_model: null`, excluded from automatic pooling, and surfaced in Settings › Models for operator mapping.

### 3.3 Removal of `tier`

`tier` is removed from local backend configuration schemas, router state, and host model advertisements. Its two former responsibilities are separated:

| Former `tier` role | Replacement | Owner |
|---|---|---|
| Within-model route priority | Per-model route order (drag-ordered in Settings › Models) | Synced `model_routing_rules` table (§4.2) |
| Cross-model substitution & selection guidance | Driver-declared fallback support, cluster default fallback list + per-model overrides, and named cluster roles (`default`, `heavy`, `fast`) | `2026-11-21-model-catalog.md` (`R-MC7`, `R-MC10`–`R-MC12`) |

---

## 4. Configuration and Synced Preferences

Route supply is local; route preference is cluster-wide. Every host in the cluster evaluates the same ranking over the same advertised inventory so a thread does not oscillate between providers when different hosts observe it.

### 4.1 Per-host local configuration (`model_backends`)

Each host's local `model_backends.js` / `model_backends.json` remains closed-schema (Invariant #13) and owns only host-local supply:

- credentials, endpoints, OAuth token store paths, and pricing callbacks;
- driver-specific request controls (`thinking`, `effort`, `max_output_tokens`, `cache_ttl`, `cache_warming`, `system_prompt_suffix`);
- optional `logical_model` to bind a backend explicitly to a logical model ID (also serves as a host-local override when cluster-global `model_aliases` does not apply);
- optional `safety_settings` for providers with configurable content-filter thresholds (Gemini);
- optional `default` (bootstrap fallback only when synced `ClusterModelRoles.default` is unset; see `2026-11-21-model-catalog.md`, `R-MC10`).

`tier` is not part of the validated schema. To prevent startup failures on existing configs, the loader strips any `tier` key before strict validation and logs a one-line warning naming its replacements.

### 4.2 Cluster-synced routing preferences

Because LWW replication resolves conflicts at whole-row `modified_at` granularity, independently-editable routing preferences are stored in dedicated STRICT synced LWW tables (obeying Invariants #1, #2, and #20, with no foreign keys, registered in synced schema introspection and snapshot ordering) rather than a single JSON blob in `cluster_config`:

| Table | Primary Key | Columns (plus `deleted`, `modified_at`) | Purpose |
|---|---|---|---|
| `model_routing_rules` | `logical_model` | `route_order` (JSON `RouteId[]`, nullable), `fallback_policy` (JSON `ModelFallbackPolicy`, nullable) | Per-model route priority and refusal-fallback override |
| `route_drains` | `route_id` | `drained_at` (TEXT), `reason` (TEXT, nullable) | Manual operator drains per route |
| `model_aliases` | `provider_key` (`${provider}:${provider_model_id}`) | `logical_model` (TEXT, nullable) | Cluster-global alias overrides (`null` keeps ungrouped) |

Two small cluster-wide singletons live in `cluster_config`:

- `routing.default_fallback_models`: JSON `LogicalModelId[]` (ordered cluster default fallback list)
- `routing.model_roles`: JSON `ClusterModelRoles` (`{ default, heavy?, fast? }`)

Concurrent edits to different logical models, routes, or aliases merge cleanly under row-level LWW; `route_order` and `fallback_policy` co-reside on one `model_routing_rules` row, so concurrent edits to both fields of the same logical model resolve at row granularity (last full-row write wins). No secrets appear in synced preferences.

---

## 5. Unified Route Ranking, Stickiness, and Pinning

### 5.1 Unified candidate pool

When a turn requests a logical model `M` (omitted or `"default"` resolves to synced `ClusterModelRoles.default`, falling back to local `model_backends.default` only when the cluster role is unset) with derived `CapabilityRequirements`, resolution collects **all** ready routes for `M` across the local host and all non-stale remote hosts (5-minute heartbeat staleness threshold) into one candidate list. Local routes are not given an unconditional short-circuit.

Filtering removes any route that:

1. is manually **drained** in `route_drains`;
2. is currently **unhealthy** (within its backoff window) and not eligible for a half-open trial;
3. is **not ready** (self-configuring provider still warming up);
4. fails the turn's `CapabilityRequirements` (`vision`, `tool_use`, `system_prompt`, `prompt_caching`) or advertises no `max_context`.

### 5.2 Deterministic ranking

Remaining candidates are sorted deterministically without consulting heartbeat freshness (`modified_at` / `online_at`):

1. **Per-model route order** (`model_routing_rules.route_order` for `logical_model`), if present: listed `RouteId`s in declared order, followed by any unlisted eligible routes.
2. **Locality tie-breaker**: local host before remote host (for routes not explicitly ordered).
3. **Stable identity tie-breaker**: lexicographical order of `RouteId`.

Heartbeat freshness gates liveness only (stale vs. live); it never breaks ties between live routes.

### 5.3 Thread-sticky routing and cache-aware hysteresis

Thread stickiness reuses the existing synced `turns` table — no separate stickiness table is required, avoiding `threads.modified_at` churn while preserving cross-host continuity when consecutive turns trigger on different hosts. `turns` gains two nullable columns:

- `route_id TEXT`: the `RouteId` that served the turn;
- `substituted_from TEXT`: the originally requested logical model when a refusal fallback substituted another model.

On the next turn for a thread, resolution reads the thread's latest ok row from `turns` (`status IS NULL OR status = 'ok'`, per the turns status convention where legacy `NULL` means ok) projecting `(model_id, route_id, substituted_from, created_at)`. If the turn targets the same logical model (or inherits a sticky refusal substitution unless the operator explicitly cleared it):

- Look up `route_id` in the current eligible candidate pool and compute `sticky_until = created_at + max(route.cache_ttl_ms, 5m)` from the route's advertised `cache_ttl`. (If `route_id` is no longer advertised or eligible, it is skipped immediately.)
- If `now < sticky_until` and `route_id` is eligible (live, healthy, not drained, meets turn requirements), the router selects `route_id` directly — even if a higher-ranked route `R0` has since recovered.
- If `route_id` is ineligible (failed, drained, offline, or lacks a new turn capability such as `vision`), the router selects the next eligible route from the ranked list; the resulting `turns` row updates stickiness automatically.
- If `now >= sticky_until` (the cache window has gone cold) or the thread has no prior `ok` turn, the router selects from the ranked list starting at route `#1`.

Stickiness protects both prompt-cache warmth and provider-bound state (such as encrypted reasoning). Recovering routes regain traffic naturally through new and cold-cache threads without flapping warm threads.

### 5.4 Hard route pinning (debugging)

A thread, scheduled task, or auxiliary invocation may specify a hard pin to a single `RouteId` alongside its logical model. When a hard pin is active:

- candidate selection considers **only** the pinned `RouteId`;
- route failover and model substitution are both disabled;
- any route error or model refusal surfaces verbatim to the caller.

---

## 6. Route Health, Recovery, Drains, and Removal

Route availability separates system-managed health from operator-managed drains.

### 6.1 System-owned health and half-open recovery

Route health is tracked per `RouteId` **locally per host** (not synced through `change_log`, avoiding ephemeral failure chatter consistent with Invariant #3), updated from observed local and relayed dispatch outcomes:

```ts
type RouteHealthState =
  | { status: "healthy" }
  | { status: "backoff"; consecutive_failures: number; next_trial_at: number; last_error_kind: string }
  | { status: "half_open"; trial_in_flight: boolean; consecutive_failures: number };
```

- **Tripping backoff**: any classified **route failure** (§7.1) moves the route to `backoff`. Backoff duration is `min(30s * 2^(failures - 1), 4h)` — or the exact `Retry-After` duration when the provider supplies one on `429`.
- **Automatic transition to half-open**: once `now >= next_trial_at`, the route enters `half_open`.
- **Trial by real traffic (per-host concurrency)**: each host allows at most one concurrent trial turn against a `half_open` route, drawn from a **new** or **cold-cache** thread (never pulling a warm sticky thread off its working route). No synthetic health pings are sent. Because route health is local per host, a recovering remote route may receive up to one trial per live host in the cluster.
  - If the trial succeeds, the route returns to `healthy` and `consecutive_failures` resets after 10 minutes of sustained success.
  - If the trial fails, `consecutive_failures` increments, the route re-enters `backoff` (capped at 4 hours), and the trial turn fails over immediately to the next ranked route for the same model.
- **Error-specific handling**:
  - `429` with `Retry-After`: wait the exact header duration.
  - Auth expiry (`401`): attempt token refresh first. Only a failed refresh places the route in backoff and raises an operator advisory, because re-login requires human action.
  - Sustained driver-bug `400`s: back off normally and emit a single operator advisory once failures persist across multiple trials, while continuing to auto-recover via half-open trials once a fix is deployed.

### 6.2 User-owned drains

An operator may toggle **Drain** on any `RouteId` in synced `route_drains`. A drained route is excluded from all normal candidate lists and half-open trials until the operator explicitly re-enables it. Automatic health transitions never set or clear a user drain.

### 6.3 Route and model removal lifecycle

Removing a single route or an entire provider from a host immediately removes its `RouteId`(s) from that host's `hosts.models` advertisement on reload or lineup refresh. Behavior depends on whether other routes for the logical model remain in the cluster:

- **One route or provider removed (other routes still exist):**
  - Normal threads sticky to the removed `RouteId` treat it as ineligible on the next turn and move seamlessly to the next ranked route for the same logical model, stripping route-bound state at the boundary (§7.1).
  - Hard-pinned threads, tasks, or auxiliary invocations (§5.4) fail loudly with a clear `"pinned route no longer exists"` error rather than silently unpinning.
  - Local `RouteHealthState` for the removed `RouteId` is discarded on router rebuild.
  - Synced `model_routing_rules.route_order` and `route_drains` entries referencing the removed `RouteId` are **retained as dormant no-ops** rather than auto-deleted, so a temporary provider lineup drop, offline host, or reverted config edit never destroys operator preferences. Settings › Models marks unadvertised entries as stale and offers one-click removal.
- **Last route for a logical model removed:**
  - Resolution preserves the distinction between **offline** and **decommissioned**: if any non-deleted `hosts` row (even a stale/offline one) still advertises the logical model in `hosts.models`, resolution returns `transient-unavailable` (retryable; grey dot in the picker). Only when **no** non-deleted host row in the cluster advertises the logical model is it treated as permanently decommissioned (`unknown-model`). Reaching `unknown-model` after a host dies permanently relies on cluster host-liveness row eviction (soft-deleting dead `hosts` rows); until eviction occurs, the model conservatively remains `transient-unavailable`.
  - A decommissioned logical model disappears from the model picker for new threads and tasks.
  - Existing threads whose `model_hint` targets a decommissioned model remain readable and surface an inline notice on the next user turn prompting the operator to pick another model; Bound does not silently substitute an unrelated model.
  - Scheduled tasks targeting a literal decommissioned model ID enter poison-pill parking with an operator advisory (unless the task targets a cluster role such as `default` or `fast`, or explicitly opts into fallback).
  - Historical provenance (`messages`, `turns`, `cost_breakdown`) is immutable and continues to render the model ID and `RouteId` that originally served each turn.
- **Re-introduction after `unknown-model`:**
  - When any host subsequently advertises a ready route for a previously decommissioned logical model, it immediately reappears in the model picker and existing threads whose `model_hint` targets it resume working on the next turn.
  - Dormant synced preferences (`model_routing_rules`, `route_drains`) that were not manually pruned resume taking effect automatically; a hard-pinned thread or task resumes only if the exact same `RouteId` returns.
  - Scheduled tasks that entered poison-pill parking while the model was `unknown-model` remain parked rather than auto-unparking (avoiding surprise catch-up bursts after long absences); their advisory surfaces the model's return so the operator can resume them explicitly.

---

## 7. Failure Classification: Route Failure vs. Model Refusal

Drivers classify every non-normal outcome before the router or loop acts on it. The two classes have disjoint recovery paths.

### 7.1 Route failures (same-model failover)

Route failures indicate that the **endpoint or pipe** failed, not that the model declined the prompt:

- transport/network/TLS/DNS errors and relay timeouts;
- `429` / `529` rate limits and overload;
- `5xx` server errors and `402` payment/quota exhaustion;
- `401` / `403` authentication failures;
- non-refusal `400` bad-request errors (including provider-driver bugs and rejected cross-provider encrypted reasoning after the driver's one-shot strip retry).

**Recovery:**

- **Pre-output failure:** mark the `RouteId` unhealthy (§6.1) and immediately fail over to the next ranked route for the **same** logical model — local or remote. Route failover is silent in the thread timeline unless failures are sustained (§9.2).
- **Mid-stream failure:** if partial text was already streamed before the pipe broke, preserve the existing salvage behavior: persist up to 2000 characters as a labeled `developer`-role message (`[Partial response - stream failed before completion]`) so work is not lost. When failing over to another route, strip route-bound state (such as mismatched `reasoning_origin` encrypted reasoning) at the boundary.

### 7.2 Model refusals (`model-declined`)

A model refusal indicates that the request reached the model and a safety/policy classifier declined it. Each driver normalizes its vendor's refusal signal into a single structured outcome **before** route-error handling runs:

```ts
type ModelDeclinedOutcome = {
  kind: "model-declined";
  vendor: "anthropic" | "openai" | "google" | "other";
  category: string | null;       // e.g. "cyber", "bio", "frontier_llm", "reasoning_extraction", "general_harms", "SAFETY", "PROHIBITED_CONTENT"
  raw_reason: string;            // provider-native finish_reason / stop_reason / error code
  explanation?: string;          // display-only text, never parsed for control flow
  substitutable: boolean;        // false for prompt-fixable categories such as "reasoning_extraction"
  credit?: {
    token: string;
    has_prefill_claim?: boolean; // undefined when omitted by Bedrock; triggers step-down shape
    endpoint: string;            // endpoint identity that minted the token
  };
};
```

Vendor driver normalization rules:

| Vendor / API | Wire refusal signals | `substitutable` |
|---|---|---|
| **Anthropic / Bedrock** | HTTP 200 with `stop_reason: "refusal"`, `stop_details.{category, explanation, fallback_credit_token, fallback_has_prefill_claim}` | `false` when `category === "reasoning_extraction"`; `true` otherwise |
| **OpenAI** (Chat Completions & Responses) | `message.refusal` / refusal content part; Chat `finish_reason: "content_filter"`; Responses `status: "incomplete"` with `incomplete_details.reason: "content_filter"` | `true` |
| **Google Gemini** (`generateContent` & Interactions API) | `promptFeedback.blockReason`; `finishReason` in `{SAFETY, PROHIBITED_CONTENT, RECITATION, SPII, BLOCKLIST, OTHER}` + `safetyRatings`; Interactions API HTTP `400` with `code` in `{safety, jailbreak, prohibited_content, blocklist}` | `true` |

A classified `model-declined` outcome:

- **never** triggers same-model route failover;
- **never** marks the route unhealthy (including Gemini Interactions API HTTP `400` blocks);
- **never** persists partial refused output as an ordinary assistant message. Any partial text streamed before the refusal is stored only on the discarded attempt record (§7.4), except when echoed inside a credited Anthropic continuation retry (§7.3).

### 7.3 Driver-level model fallback and fallback-credit redemption

When a turn receives a `substitutable: true` `model-declined` outcome and the thread is not hard-pinned (§5.4), Bound walks the logical model's **fallback chain**:

1. **Fallback policy resolution** (`2026-11-21-model-catalog.md`, `R-MC7`, `R-MC11`):
   - **`mode: "never"`:** halt fallback and surface the refusal directly.
   - **`mode: "custom"`:** walk the operator's per-model `models` list in declared order (excluding the refused model and any model failing the turn's `CapabilityRequirements`).
   - **`mode: "auto"` (default):** branch on the active driver's `DriverFallbackSupport` descriptor:
     - if `server_side_auto: true` (e.g., Anthropic direct API), delegate to the provider's server-side automatic fallback (`fallbacks: "default"` + `server-side-fallback-2026-07-01`);
     - otherwise, walk provider-published `allowed_fallback_models` (when `publishes_allowed_targets: true` and mapped to available logical models), followed by the cluster's `default_fallback_models` filtered by the turn's `CapabilityRequirements`.
2. **Relay contract and in-request execution on the inference host**:
   - The loop host resolves the effective fallback policy and ordered target list and ships them on the inference request. For remote inference, `inferenceRequestPayloadSchema` (obeying Invariant #16) gains two optional fields:
     - `fallback_policy?: { mode: "auto" | "never" | "custom" }`
     - `fallback_models?: string[]` (ordered candidate `LogicalModelId[]` already filtered by turn `CapabilityRequirements`)
   - The executing driver on the inference host builds and holds the normalized provider wire body locally; the frozen request body never crosses the relay.
   - When the active driver declares `supports_fallback_credit: true`, a `credit.token` is present, **and** the next target in `fallback_models` is served on that **same host's same endpoint** (Anthropic API, Bedrock Runtime, Bedrock Mantle), the executing driver performs the retry directly inside the same inference call within the 5-minute redemption window:
     - **Anthropic direct API / Anthropic-managed GCP:** uses server-side fallback (`fallbacks: "default"` in `auto` mode, or named `fallbacks` in `custom` mode) when expressible server-side.
     - **Bedrock Runtime and Bedrock Mantle:** sends `fallback-credit-2026-07-01` on eligible requests (in `anthropic_beta` for `bedrock-runtime`, `anthropic-beta` header for `bedrock-mantle`), and redeems `fallback_credit_token` by replaying the refused prompt payload (`system`, `messages`, `tools`, `thinking`, `cache_control`, `output_config`, and identical beta flags) with `model` changed and `fallback_credit_token` added. Earlier `thinking` / `redacted_thinking` blocks are **not** stripped on a credited retry. Per-model driver wire adaptations (such as Mantle `reasoning.summary` pinning) are still respected where required by the target model; if the provider rejects the adapted body for credit redemption, step-down handles it cleanly.
     - **Redemption step-down:** if `has_prefill_claim` is `true` or absent (Bedrock), try the continuation body (appending the refused response's echoed `assistant` content, trimming trailing whitespace and unmatched client `tool_use`) first; if rejected with a validation `400`, retry with the unchanged body plus token; if still rejected on `fallback_credit_token` (including when the target model is not credit-eligible on that endpoint), forfeit the credit and retry without the token — **unless** server tools already ran in the refused attempt, in which case surface the error instead of re-running billed server tools. Transient `"redemption temporarily unavailable"` errors retry with the same token within the 5-minute window.
   - When the next fallback target is **not** co-located on that same endpoint (different host, endpoint, or vendor) or `supports_fallback_credit: false`, control returns to the loop host's router, which forfeits any endpoint-bound credit, dispatches to the fallback model's ranked route, and strips model-bound state (mismatched `reasoning_origin` encrypted reasoning, incompatible thinking signatures, cache markers) at the boundary.
3. **Non-substitutable refusals** (`substitutable: false`, such as `reasoning_extraction`): halt fallback immediately and surface the category and explanation to the thread so the prompt or tool schema can be corrected.
4. **Post-fallback stickiness**: after a model substitution succeeds, the thread pins to the substitute logical model for at least the cache window (or until the operator explicitly triggers "Try `<original>` again"), avoiding repeated billed refusals and repeated prompt-cache writes on subsequent turns.
5. **Per-request scope for subagents**: auxiliary agent turns and Yard `infer()` calls resolve and carry their own fallback chains per request; they do not inherit ambient thread-level fallback state.

### 7.4 Per-attempt provenance and cost accounting

A single turn can execute multiple attempts (for example, a refused primary attempt plus a credited fallback attempt, or a failed route trial plus a failover attempt). Every attempt is recorded separately in per-turn provenance and `cost_breakdown`:

- each attempt records `model_id`, `route_id`, `outcome` (`"ok" | "route-error" | "refusal"`), `refusal_category` (if refused), `credit_redeemed` (boolean), token counts (`input`, `output`, `cache_read`, `cache_write`), and `cost_usd`;
- tokens from different models are **never** summed into a single model's usage record;
- every classified refusal emits a dedicated observability event/metric (`llm.refusal`) paired with fallback outcomes (`llm.fallback`), independent of HTTP error-rate monitoring.

---

## 8. Requirements

### 8.1 Logical models, routes, and catalog

**R-MR1.** Every route in the cluster shall be uniquely identified by `RouteId = ${siteId}:${provider}:${backendId}` for ranking, health tracking, stickiness, hard pins, and per-turn provenance. Each local route entry shall separately carry its provider `reasoning_origin` (`${siteId}:${provider}[:${detail}]`) for encrypted-reasoning compatibility checks; `RouteId` and `reasoning_origin` shall not be conflated. `PooledBackend` shall be removed, and `ModelRouter` shall operate as a flat local route registry.

**R-MR2.** Each host shall advertise its ready local routes in `hosts.models` with `route_id`, `logical_model` (nullable when unassigned), `provider_model_id`, effective `capabilities` (including `max_context`), `max_output_tokens`, `cache_ttl`, and `thinking_mode`. Not-ready self-configuring backends shall be excluded from advertisements and candidate selection.

**R-MR3.** `tier` shall not exist in validated backend configuration schemas, router state, or host model advertisements. The config loader shall strip any legacy `tier` key before strict validation and emit a one-line warning naming its replacements.

**R-MR4.** Logical model grouping and metadata resolution shall follow `2026-11-21-model-catalog.md` (`R-MC1`–`R-MC9`). Unmatched auto-registered models shall be advertised with `logical_model: null` and surfaced for operator mapping.

**R-MR5.** Per-host `model_backends` configuration shall accept optional `logical_model`, `safety_settings` (Gemini), and `default` (bootstrap fallback only when synced `ClusterModelRoles.default` is unset), remaining closed-schema (Invariant #13). Provider credentials and endpoints shall never replicate to synced tables.

**R-MR6.** Cluster routing preferences shall live in STRICT synced LWW tables obeying Invariants #1, #2, and #20 (registered in synced schema introspection and snapshot ordering): `model_routing_rules` (PK `logical_model`), `route_drains` (PK `route_id`), and `model_aliases` (PK `provider_key`), with cluster-wide singletons (`routing.default_fallback_models`, `routing.model_roles`) in `cluster_config`. Concurrent edits to distinct models, routes, or aliases shall not clobber one another.

### 8.2 Ranking, stickiness, and pinning

**R-MR7.** Model resolution shall evaluate local and non-stale remote routes for the requested logical model in a single unified candidate pool. A local route shall not short-circuit remote routes. Omitted or `"default"` model requests shall resolve to synced `ClusterModelRoles.default`, falling back to local `model_backends.default` only when the cluster role is unset.

**R-MR8.** Candidate ranking shall be deterministic: explicit per-model `model_routing_rules.route_order` first, then locality (local before remote) for unlisted routes, then lexicographical `RouteId`. Host heartbeat timestamps (`modified_at`, `online_at`) shall gate liveness (5-minute staleness) only and shall never be used as a ranking tie-breaker.

**R-MR9.** The synced `turns` table shall record `route_id` and `substituted_from` (both nullable). On subsequent turns, resolution shall read the thread's latest ok turn (`status IS NULL OR status = 'ok'`) and stick to its `route_id` while that route remains eligible and `now < created_at + max(route.cache_ttl_ms, 5m)`. A higher-ranked route recovering from backoff shall not pull a warm sticky thread off its active route.

**R-MR10.** A thread, task, or auxiliary invocation may declare a hard pin to a specific `RouteId`. While hard-pinned, resolution shall consider only that `RouteId`, shall disable route failover and model substitution, and shall surface raw failures directly.

### 8.3 Health, recovery, and drains

**R-MR11.** Route health shall be managed locally per host (not synced through `change_log`, per Invariant #3) with states `healthy`, `backoff`, and `half_open`. Route failures shall apply exponential backoff starting at 30 seconds (2× per consecutive failure) capped at 4 hours, or the exact `Retry-After` duration on `429`.

**R-MR12.** A route whose backoff window has expired shall enter `half_open` and recover automatically using at most one concurrent real turn **per host** from a new or cold-cache thread as its trial. Synthetic probe requests shall not be sent. Trial success restores `healthy`; trial failure doubles backoff up to the 4-hour cap and fails that turn over to the next ranked route.

**R-MR13.** Auth expiry (`401`) shall attempt token refresh before tripping backoff and shall raise an operator advisory only when refresh fails. Sustained driver-bug `400`s shall emit a single advisory while continuing automatic half-open recovery.

**R-MR14.** Manual route drains shall be stored in synced `route_drains` and shall be independent of system health. A drained route shall remain out of rotation until manually re-enabled by an operator; automatic health recovery shall never clear a manual drain.

### 8.4 Failure classification, refusal fallback, and accounting

**R-MR15.** Every LLM driver shall classify provider-native refusals into a normalized `ModelDeclinedOutcome` before router error handling runs. A classified refusal shall never trigger same-model route failover and shall never mark a route unhealthy. Non-safety HTTP `400` responses (including Gemini Interactions API `400`s without a recognized safety `code`) shall fall through to route failure.

**R-MR16.** Mid-stream route failures shall preserve `#174` partial-output salvage as a labeled `developer`-role message (2000-character cap). Refused attempts shall never persist partial output as an ordinary assistant message; partial refused output shall be recorded only on the discarded attempt entry (except when echoed inside a credited Anthropic continuation retry request body, which still writes no standalone assistant `messages` row).

**R-MR17.** When a `substitutable: true` refusal occurs on an unpinned request, Bound shall apply the logical model's fallback policy (`2026-11-21-model-catalog.md`, `R-MC11`): `never` surfaces the refusal directly; `custom` walks the per-model list; `auto` delegates to the provider's server-side default when the driver declares `server_side_auto: true`, and otherwise walks provider-published `allowed_fallback_models` (if any) followed by the cluster's `default_fallback_models` filtered by the turn's required capabilities. `substitutable: false` refusals shall not substitute and shall surface the refusal cause directly.

**R-MR18.** `inferenceRequestPayloadSchema` shall carry optional `fallback_policy` and `fallback_models` fields (obeying Invariant #16) so remote inference hosts know the resolved fallback chain. When a target in `fallback_models` is co-located on the executing inference host's same endpoint and the driver declares `supports_fallback_credit: true` with a valid `credit.token`, the driver shall execute the credited retry inline within the 5-minute window using the refused prompt payload, identical beta flags, and unstripped thinking blocks, following provider step-down rules and refusing to silently re-run billed server tools. Non-co-located targets shall forfeit endpoint-bound credit and return control to the loop host's router.

**R-MR19.** Cross-route failovers, uncredited model fallbacks, and cross-vendor fallbacks shall strip route-bound and model-bound state (comparing `reasoning_origin` for encrypted reasoning, incompatible thinking signatures, and cache markers) at the boundary. Each driver shall govern its own boundary-state preservation rule.

**R-MR20.** After a model substitution succeeds, `turns.substituted_from` shall record the original logical model and the thread shall stick to the substitute logical model while within the cache window (or until the operator explicitly resets to the original model). Auxiliary agents and Yard `infer()` calls shall resolve and carry per-request fallback chains independently of ambient thread state.

**R-MR21.** Per-turn provenance and `cost_breakdown` shall record every attempt separately (model, route, outcome, refusal category, credit redemption, token counts, cost). Tokens from different models shall never be summed into one model's totals. Refusals and fallback outcomes shall emit dedicated observability events independent of HTTP error metrics.

### 8.5 Route and model removal

**R-MR22.** Removing a route from a host shall immediately omit its `RouteId` from `hosts.models` and discard its local health state. Sticky threads shall move cleanly to the next eligible route for the same logical model; hard-pinned requests shall fail loudly without unpinning. Synced `model_routing_rules.route_order` and `route_drains` entries for unadvertised routes shall remain dormant no-ops until explicitly pruned by an operator.

**R-MR23.** When no non-deleted `hosts` row in the cluster (ignoring heartbeat staleness; relying on host-liveness row eviction to clear permanently dead hosts) advertises a logical model, resolution shall classify it as permanently `unknown-model`. New pickers shall omit it, existing threads shall prompt the operator to select a replacement without silent substitution, scheduled tasks on literal removed IDs shall park with an operator advisory, and historical turn provenance shall remain intact.

**R-MR24.** When a ready route for a previously decommissioned logical model is re-advertised, pickers, existing threads, and unpruned dormant preferences shall resume automatically without operator reconfiguration; hard-pinned requests shall resume only if the exact pinned `RouteId` returns; and poison-pill parked scheduled tasks shall remain parked until explicitly resumed by an operator.

---

## 9. Web UI Experience

Every surface exposes only what the operator needs to make a decision; route ranking, breakers, stickiness, refusal classification, credit redemption, and state stripping stay internal.

### 9.1 Everyday surfaces

- **Model picker** (composer, thread header, task and aux forms): lists logical models only, never raw provider-specific IDs. Each model displays one health dot — **green** (preferred route healthy), **amber** (serving via fallback route), or **grey** (no eligible route). Hard route pinning sits behind an **Advanced** disclosure at the bottom of the picker.
- **Thread header chip:** displays the logical model name (`gpt-5.6-sol`). When the thread is running on a non-preferred route, a quiet suffix appears (`gpt-5.6-sol · via MSI / Codex`) with a tooltip explaining why. A hard route pin renders with a distinct lock indicator so forgotten debug pins stand out.
- **Per-turn provenance footer:** each assistant message carries a compact footer naming the serving model and route. Expanding it reveals all attempts for that turn with per-attempt cost breakdown, including discarded refusal attempts and failed route trials.

### 9.2 In-thread notifications

- **Route failover:** silent in the thread timeline (recorded in the turn footer). If a route fails repeatedly on a thread, Bound displays a single thread-level notice (for example, `"MSI / Codex failed 4 of the last 5 turns; using hub / Bedrock"`).
- **Model substitution:** displays an inline notice naming the refusal category (when available), the substitute model, and the stickiness decision, with a one-click **`Try <original> again`** action to clear the substitution pin. Non-substitutable refusals display the category and explanation without offering a substitute.

### 9.3 Settings › Models

One operator page manages synced cluster preferences while displaying read-only per-host route supply:

- **Per-model route list:** expanding a logical model lists all advertised routes across the cluster (host, provider, system health, and next trial countdown). Dragging reorders routes directly as that model's synced `route_order`; each row provides a manual **Drain** toggle. Unadvertised routes still present in `route_order` or `drained_routes` display as stale with a one-click **Remove** action.
- **Fallback chain:** shows *Automatic* (displaying whether the active route uses provider default or the cluster default fallback list) alongside controls to set a per-model custom list or select *Never substitute*.
- **Unassigned backends:** lists auto-registered provider models without a logical model alongside suggested matches, plus automatic structural matches with one-click undo (`2026-11-21-model-catalog.md` §9).

---

## 10. Acceptance Criteria

- **Unified ranking:** a test cluster with a local route and a remote route for the same logical model selects the remote route when `route_order` places it first, and defaults to local-before-remote then lexicographical `RouteId` when unordered; identical preferences on two hosts produce identical route ordering regardless of heartbeat timestamps.
- **Same-model cross-host failover:** when a local route fails with `429`, `5xx`, or a driver-bug `400`, the turn fails over to a healthy remote route serving the same logical model and completes without surfacing an error.
- **Auto-registered pooling:** an auto-registered backend whose provider-specific ID matches structural normalization (or a synced alias override per `2026-11-21-model-catalog.md`) pools with a static backend for the same logical model across hosts; an unmapped backend appears as unassigned and does not silently pool.
- **No `tier` (strip-and-warn):** a legacy config containing `tier` loads with a deprecation warning after stripping `tier`; `tier` is absent from the validated schema, router state, and `hosts.models`; `PooledBackend` is removed and all ranking, fallback, and Yard/aux selection tests pass.
- **Concurrent synced preference edits:** concurrent edits on two hosts to different logical models in `model_routing_rules`, different routes in `route_drains`, or different keys in `model_aliases` both survive LWW sync without clobbering each other.
- **Stickiness and hysteresis (cross-host via `turns`):** a thread pinned to route B after route A backs off writes `turns.route_id = B`, remains on route B even if the next turn triggers on a different host while within route B's cache window, and does not snap back when route A recovers; a new or cold-cache thread runs the per-host half-open trial on route A.
- **Automatic recovery vs. manual drain:** a route in backoff transitions to `half_open` on expiry, recovers on a single successful real turn per host without synthetic pings, and caps backoff at 4 hours on repeated failure; a manually drained route stays excluded until explicitly un-drained.
- **Hard route pin:** a hard-pinned thread routes only to the pinned `RouteId` and surfaces raw errors or refusals without failover or model substitution.
- **Refusal classification & allowlist:** Anthropic `stop_reason: "refusal"`, OpenAI `refusal` / `content_filter`, and Gemini `SAFETY` / `PROHIBITED_CONTENT` (including Interactions API HTTP `400` with recognized safety `code`) all normalize to `ModelDeclinedOutcome`, never mark the route unhealthy, and never persist partial refused text as an ordinary assistant message; a Gemini HTTP `400` *without* a recognized safety `code` falls through to route failure and trips backoff.
- **Mid-stream route salvage preserved:** a mid-stream transport/relay error still persists up to 2000 chars of partial output as a labeled `developer`-role message.
- **Credited driver-level fallback & continuation echo:** on a simulated Bedrock/Anthropic refusal carrying `fallback_credit_token` with a co-located target, the driver replays the refused prompt payload with identical beta flags and unstripped thinking blocks on the same endpoint, executes the Bedrock `fallback_has_prefill_claim` step-down sequence (echoing partial text only on the retry request body and never writing a standalone refused assistant `messages` row), refuses silent uncredited retry when server tools ran, forfeits credit and returns to the router for non-co-located targets, and records separate per-attempt usage/cost entries without summing cross-model tokens.
- **Non-substitutable refusal:** a `reasoning_extraction` refusal does not trigger model fallback and surfaces the prompt-level explanation directly.
- **Route and model removal and re-introduction:** removing one of two routes for a logical model moves sticky threads to the remaining route while failing hard-pinned threads loudly and preserving dormant `route_order` / `drained_routes` entries; removing the last route across all hosts classifies the model as `unknown-model`, parks literal-ID scheduled tasks with an advisory, prompts existing threads to pick a replacement, and preserves historical turn provenance; re-advertising the model restores pickers, existing threads, and unpruned dormant preferences while keeping poison-pill parked tasks paused until explicitly resumed.
- **Web UI surfaces:** model picker renders logical models only with three-state health dots; thread chip distinguishes non-preferred routes and hard pins; turn footer expands per-attempt provenance; Settings › Models updates synced route order, drains, fallback chains, and alias mappings across hosts.
