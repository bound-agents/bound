---
title: Inference and model routing
description: How Bound chooses an eligible model location, relays inference, and shapes provider context.
---

Bound can send a model request to different model services and locations. A **backend** is
a configured connection to a model service. A **host** is a Bound instance in the cluster.
The **loop host** coordinates the agent turn, while the **inference host** owns the backend
that serves a particular model request. These can be the same host or different hosts.

**Routing** chooses an eligible backend and host to serve a request while keeping the agent
loop on the loop host.

## Routing decisions

Each host advertises the models and capabilities available through its configured backends.
Bound combines those advertisements into a cluster inventory and evaluates the request
against it.

The decision has three broad questions:

1. **What did the turn request?** An omitted model and `"default"` use the cluster
   `default` role, resolved like any named logical model across hosts; an unavailable configured
   default fails the turn rather than switching models. The host's bootstrap default applies only
   when that role is unset. A hint that names a [role or alias](/bound/reference/configuration/#routingmodel_roles)
   follows that mapping to a logical model (an exact backend id always beats an alias of the same
   name); otherwise a named model narrows the eligible inventory directly.
2. **Which backends are eligible?** Eligibility depends on the advertised model, provider
   capabilities, and current backend configuration.
3. **Where can the request run?** Bound gathers every eligible route for the model
   across the loop host and the live remote hosts into one candidate pool — a local
   backend does not shadow a remote one. It then ranks them deterministically:
   local routes before remote routes, and ties broken by a stable route identity
   (`${site}:${provider}:${backend}`). Heartbeat freshness decides only whether a
   host is live, never the order between live routes. When a route fails with a
   rate limit, server error, or transport fault, the turn fails over to the next
   ranked route for the same model, on any host; it is not substituted for a
   different model.

When the selected backend is remote, the loop host relays its assembled context to the
inference host and streams the response back. The inference host serves the request; it does
not reconstruct the turn from replicated state. See [State, consistency, and multi-host
operation](/bound/concepts/sync/) for the distinction between inference relay and state
replication.

A selected backend or relay can be unavailable, reject the request, or lack a required
capability. Bound reports a failure when a route cannot complete; retry and recovery behavior
belongs to the [work lifecycle](/bound/concepts/work-lifecycle/).

## Local and hosted backends

A backend can use a model service running locally or a hosted provider API. Providers differ
in authentication, model discovery, request controls, and prompt-cache support. See the
[configuration reference](/bound/reference/configuration/#model_backendsjs--model_backendsjson) for the
current providers, credentials, and backend fields.

A backend's metadata — context window, output limit, capabilities, and pricing —
resolves in a fixed precedence: explicit values in `model_backends` config win,
then the provider's own discovery API (where the account's live model lineup and
limits come from), then the `models.dev` fallback registry. `context_window` and
`max_output_tokens` are optional overrides: set them to cap a value below what
the provider or `models.dev` reports, or for a model neither source knows. A
backend whose context window resolves from none of the three sources stays
unready, unadvertised, and unroutable. A reported output limit above 25% of the
context window is capped at 25%: Bound reserves the output limit out of the
window when it sizes the prompt, and some providers report an output limit as
large as the whole window. An explicit `max_output_tokens` override is always
honored.

The same precedence resolves each model's **display name**, shown in the model
picker, the **Models** view, the thread chip, and the message-header routing
note. A provider-published display name takes precedence, followed by the
`models.dev` name and then the raw provider model ID with its version dots
intact. When a logical model's routes resolve different names, the strongest
source wins, with ties broken by the provider model ID.

## Provider-specific request handling

### Prompt caching

For providers that support prompt caching, Bound can separate context that usually stays the
same from content that changes each turn, reducing how much unchanged prompt content the
provider processes again. Cache warming can refresh an active thread's provider cache before
expiry, trading an additional request for a greater chance of reuse. See the [configuration
reference](/bound/reference/configuration/) for cache support and settings.

Bound does not assume a single cache model across providers. An aggregating provider inherits
each upstream model's cache behavior per wire protocol, so caching follows three steps per
request.

- **Request.** When a route's protocol has a cache-lifetime field, Bound sends the configured
  `cache_ttl` in it: Anthropic Messages `cache_control.ttl`, Bedrock Converse `cachePoint.ttl`,
  and OpenAI Responses `prompt_cache_options.ttl`. A protocol without such a field gets none.
  If a provider rejects a request because of a cache field, Bound retries once — with the
  provider's listed value when the error names one and it fits the field, otherwise without the
  field — and remembers that outcome for the route. The rejection does not mark the route
  unhealthy and does not count as a refusal.
- **Observe.** Bound reads back cache-read and cache-write token counts, and, when the provider
  reports one, a per-lifetime write split (how many write tokens went to each lifetime, such as
  5m or 1h).
- **Price.** Bound prices a turn's cache writes from a provider-reported charge when one is
  present; otherwise from published per-lifetime write prices times the reported split;
  otherwise from a published write price times the unsplit or unpriced write tokens, recorded
  with the pricing source `estimate`; otherwise as unknown. An `estimate` source means the
  provider did not report the lifetime breakdown, so Bound priced the writes at the default
  lifetime's rate.

Thread stickiness uses a route's effective cache window: the longest gap between consecutive
turns on the route after which a later turn still read from cache, measured from turn history.
A route with no such history falls back to the lifetime it last requested. See [thread
stickiness](#thread-stickiness).

### Reasoning controls

Some providers expose controls such as an effort level, adaptive reasoning, or a fixed
thinking budget. Bound passes supported controls through the selected backend, but their
meaning and availability remain provider-specific. A fallback route must support the
capabilities the turn requests; controls should not be assumed to behave identically across
providers.

A backend's reasoning request comes from its own config first. When a backend sets no
`thinking`, Bound derives one from the model's resolved reasoning metadata (the `reasoning`
block in the [resolved catalog](#local-and-hosted-backends), published by the provider or
`models.dev`): a model that advertises no reasoning gets none, a model that advertises an
on/off toggle or an effort ladder gets reasoning enabled, and a model whose provider
advertises adaptive thinking gets adaptive thinking. A backend with no resolved reasoning
metadata and no config keeps whatever default its driver and protocol apply. The decision
reads published capabilities, never the model's name.

An `effort` level — whether set on the backend or inherited from the top-level `defaults`
block — is clamped to the nearest value the model actually lists before it reaches the
provider. A model that lists `low | medium | high` receives `high` for a configured
`xhigh`; a model that publishes no effort ladder has its configured value forwarded
unchanged for the driver's own validation to accept or drop. This keeps a cluster-wide
effort preference from erroring on a model that does not offer that exact level.

### Route failures and model refusals

A request can end in two distinct ways that both stop the turn. Bound separates them
because they call for opposite responses.

A **route failure** means the chosen backend or relay could not complete the request: a
transport fault, a rate limit, a server error, or a malformed request. Bound can retry a
route failure on another eligible route for the same model. When a route failure interrupts
a response that had already started streaming, Bound preserves the partial text as a
separate note so the work is not lost.

A **model refusal** means the request reached the model and its safety or policy classifier
declined to answer. Each provider signals a refusal differently: Anthropic and Bedrock
return a refusal stop reason, OpenAI returns a refusal message or a content-filter finish,
and Gemini returns a safety block reason. Some arrive as a successful HTTP response and some
as an HTTP 400. Each backend maps its provider's signal to one normalized refusal outcome
before routing decides what to do.

A refusal is a decision by the model, so retrying the same model on another route cannot
change it. Bound therefore treats a refusal differently from a route failure:

- A refusal never retries the same model on another route and never marks a route
  unhealthy.
- Bound keeps any partial text the model produced before the refusal out of the
  conversation history, so a later turn does not read it as a complete answer.
- When no fallback model serves the turn, an operator alert reports the refusal with the
  provider's refusal category and explanation when the provider supplies them.

An HTTP 400 that carries a recognized safety signal is a refusal. An HTTP 400 without one is
a route failure and counts toward route health like any other bad request.

### Refusal fallback

When a refusal is substitutable, Bound can answer the turn on a different model instead of
stopping. Each logical model has a **fallback policy** that decides whether, and how, a
substitution happens:

- **Automatic** (the default when no policy is set) delegates to the provider when the
  provider supports an automatic server-side fallback, and otherwise walks the cluster's
  default fallback list. A provider that publishes its own allowed fallback models is
  consulted before the cluster list.
- **Custom** walks an operator-declared list of models in order.
- **Never** shows the refusal and substitutes nothing.

A candidate model is skipped when it cannot meet the capabilities the turn needs. Some
refusals are prompt-fixable rather than model-specific — a request for reasoning the model
will not expose, for example. Bound marks these as not substitutable and surfaces the refusal
cause directly so the prompt or tool schema can be corrected, rather than retrying another
model that would decline for the same reason. A [hard-pinned](#hard-route-pins) turn never
substitutes.

After a substitution succeeds, the thread stays on the substitute model while its
prompt-cache window is warm, so a run of similar turns does not pay repeated refusals. Once
the window goes cold — or when an operator resets the thread's model — the thread returns to
the original model. Auxiliary agents and Yard `infer()` calls resolve their own fallback chain
per request and do not inherit a thread's substitution.

The loop host resolves the policy and the ordered candidate list and sends them with the
inference request, so a remote inference host knows the resolved chain. An older inference
host that does not understand these fields ignores them and returns the refusal unchanged.

### Fallback credit

Some providers mint a **fallback credit** on a refusal: a short-lived token that lets Bound
retry a different model against the same prompt cache without paying to process the prompt
again. Credit is bound to the endpoint that minted it and expires in five minutes.

Bound redeems a credit only when the next candidate model is served by the same endpoint on
the inference host that holds the credit. The retry reuses the refused prompt with the same
provider options and keeps earlier reasoning content in place. If the provider rejects the
credited form, Bound steps down cleanly — it tries a continuation of the refused response,
then the unchanged prompt with the credit, then the prompt without the credit — and stops
stepping down if billed server tools already ran on the refused attempt, surfacing the
refusal instead of running those tools again uncredited. A candidate on a different endpoint,
host, or provider forfeits the credit and goes back through the loop host's router as an
ordinary substitution, which strips provider-bound state such as encrypted reasoning at the
boundary.

### Cost of a substituted turn

A turn that refuses and then substitutes runs more than one model attempt. Bound records each
attempt on its own — the model, the route, the outcome, whether a credit was redeemed, and
the tokens and cost — and never adds one model's tokens into another model's totals. The
thread's cost view shows the attempts separately so a substituted turn's spend is attributed
to the model that actually incurred it.

## Route health and recovery

Each host tracks route health locally without replicating it across the cluster.
Because health is short-lived failure state, each live host runs its own recovery
trial when a route's backoff expires. A route is in one of three states:

**Healthy** is the normal state: the route is a full candidate for any turn.

**Backing off** starts the moment a route fails. The host stops routing new turns to it
and waits before trying again. The wait starts at 30 seconds and doubles on each further
failure — 30 seconds, one minute, two minutes, and so on — up to a ceiling of four hours.
When a rate-limited provider sends a `Retry-After`, the host waits exactly that long
instead of the doubling schedule. When a provider reports when a usage limit resets
(reset headers, a `resets_at` field, or a "will reset at" message, as ChatGPT, z.AI,
and OpenCode Go send), the route backs off until that moment and the error text
carries the reset time.

Every route failure backs the failed route off and moves the turn to the next ranked
route for the same model within that turn: rate limits (`429`/`529`), payment or quota
exhaustion (`402` or a quota message), authentication failures (`401`/`403`), server
errors (`5xx`), malformed-request `400`s that are not refusals, and transport errors.
Server and transport errors first retry the same route a few times, so a brief blip
keeps the thread's prompt cache. A route that already failed in the current turn is
never retried in it. When every route fails, the surfaced error lists each route and
its own cause in order, including a route on another host that the turn failed over to. A model refusal is not a route failure and never fails over.

**Half-open** is the recovery probe. When the wait expires, the route becomes a candidate
again for one real trial turn per host at a time, never a synthetic health ping. The trial
comes from a new or cold-cache thread whenever the model has another eligible route. A warm
thread first moves to a healthy local route for the same model, then to a remote route.
When the half-open route is the only route for its model, a warm thread takes the trial
itself instead of waiting for an unrelated cold thread. The trial is an ordinary turn that
happens to land on the recovering route:

- If it succeeds, the route returns to healthy. The failure count clears after ten minutes
  without another failure.
- If it fails, the wait doubles again (still capped at four hours) and that turn fails over
  immediately to the next ranked route for the same model, so the trial never costs the
  thread its turn.

**No route available right now.** A model that the cluster still knows about can have every
route in backoff, drained, on an offline host, or holding its half-open trial for another
turn. A turn that hits this waits up to two minutes (or the relay inference timeout, if
shorter) and starts as soon as a route becomes eligible. If no route frees up in that time,
the thread gets one notice that names each route's state, such as `backoff until <time>`,
`half-open trial in flight`, `drained`, or `host offline`. The turn does not end in a loop
error. What happens next depends on who started the turn:

- An interactive thread keeps retrying in two-minute rounds until a route recovers, the
  operator cancels, or the thread's model changes. A repeat outage does not post the notice
  again.
- A scheduled task run ends as failed. The notice says when it runs next: cron and
  heartbeat tasks at their next scheduled time, deferred tasks after their limited retries,
  and event tasks on their next event.
- A cache-warm poke ends quietly.

Cancelling the turn interrupts the wait at once. The `Unknown model` message is reserved for
a model that no host advertises any more; see [Route and model removal](#route-and-model-removal).

Some failures also raise an operator alert, because they need a human. An expired
authentication token (`401`) first tries a token refresh; the route only backs off and
alerts if the refresh itself fails, since re-login is a human action. A provider that keeps
returning malformed-request errors raises a single alert while automatic recovery
keeps running, so a later fix takes effect without manual action.

The candidate pool and its ranking are shaped by cluster-wide preferences that replicate
to every host, so a thread sees the same routing decision wherever its next turn runs.

### Route order

An operator can declare a preferred order of routes for a logical model. When set, the
listed routes rank first in their declared order; any eligible route that is not listed
follows, ordered by locality (local before remote) and then by a stable route identity.
Route order ranks eligible routes by identity; any listed route that is offline,
unhealthy, or missing a required capability is skipped.

### Drains

An operator can **drain** a route by its identity. A drained route is removed from every
candidate list and from health-recovery trials until the operator un-drains it. Draining
is the manual counterpart to automatic health backoff: health transitions never set or
clear a drain, and a drain never expires on its own. Draining a route a thread is currently
using moves that thread to the next ranked route on its next turn.

### Thread stickiness

After a thread runs a turn on a route, it stays on that route for subsequent turns while
the route remains eligible and the turn is still within the route's prompt-cache window
(at least five minutes, longer when the route advertises a longer cache TTL). Stickiness
holds even when a higher-ranked route recovers in the meantime, and it holds across hosts:
if the next turn triggers on a different host, that host reads the same prior-turn record
and makes the same choice. This keeps a warm thread on its warm cache and its
provider-bound state instead of flapping back to a just-recovered route. Once the cache
window goes cold, or the sticky route becomes ineligible, the thread resolves from the
ranked list again. Only a successful prior turn pins a thread; a failed or aborted turn
never holds a thread to a dead route.

When the prior turn was a [refusal substitution](#refusal-fallback), stickiness applies to
the substitute: a request for the original model reuses the substitute's route while that
route's cache window is warm, then returns to the original model's ranked routes.

### Hard route pins

A thread, scheduled task, or auxiliary invocation can **pin** a single route for debugging.
A pin is expressed in the model hint as `logical_model@RouteId` (or `@RouteId` to pin a
route regardless of its logical model). A pinned call considers only that route: route
failover and model substitution are both disabled, and any route error or model refusal
surfaces verbatim. If the pinned route no longer exists anywhere in the cluster, the call
fails with an error.

### Route and model removal

Routes and models come and go as providers are added, removed, or temporarily lose
their lineup. Bound distinguishes a route or model that is temporarily unavailable from
one that is permanently removed, preserving operator preferences during temporary outages.

**Removing one route of several.** When a host drops a route — a provider is removed from
its config, or a lineup refresh no longer lists it — that route leaves the host's
advertisement and its local health state is discarded. Threads sticky to the removed
route move to the next ranked route for the same model on their next turn. A hard pin on
the removed route fails with an error. Any route order, drain, alias, or fallback-list
entry that named the route stays in place as a dormant no-op while the route is absent,
and the **Models** view marks it **Unavailable** with a **Remove** button. A reverted
config edit or a provider that comes back restores those entries without reconfiguration.

**Removing the last route for a model.** A model becomes decommissioned once no
non-deleted host in the cluster advertises it. While an offline or stale host's row
survives, the model stays temporarily unavailable (retryable, shown as a gray dot). Once
host-liveness eviction removes the dead host's row, the model is decommissioned and leaves
the picker for new threads and tasks. Existing threads targeting it stay readable and
prompt the operator to choose another model on the next turn. Live scheduled tasks naming
the model directly park with an advisory, while tasks and auxiliary agents targeting a
cluster role or alias follow the mapping. Heartbeat and consolidation tasks stay active
and surface an advisory when their `model_hint` becomes dead. Any cluster role, alias,
auxiliary agent, or live scheduled task pointing to a decommissioned model raises an
advisory. Historical turn records keep the model and route that originally served each
turn.

**When the model comes back.** Once any host advertises a ready route for the model again,
it reappears in the picker and existing threads resume on their next turn. Dormant
preferences that were never pruned take effect again, and the dangling-reference advisories
resolve on their own. A hard pin resumes only if the exact same route identity returns.
Scheduled tasks that parked while the model was gone stay parked; their advisory notes
the model's return so the operator can resume them deliberately and avoid a burst of
catch-up runs.

See the [configuration reference](/bound/reference/configuration/#replicated-control-state)
for the cluster-wide default-model role and fallback-list keys.
