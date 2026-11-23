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

1. **What did the turn request?** An omitted model and `"default"` use the configured default
   route; a named model narrows the eligible inventory.
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
`max_output_tokens` are therefore optional overrides: you set them only to cap a
value below what the provider or `models.dev` reports, or for a model neither
source knows. A backend whose context window resolves from none of the three
sources stays unready — not advertised, not routable — rather than running on a
guessed window. A reported output limit that is as large as the whole context
window is treated as unknown (it would leave no room for the prompt); an explicit
`max_output_tokens` override is always honoured.

The same precedence resolves each model's **display name** — the name shown in the
model picker, the Settings › Models page, the thread chip, and the per-turn
provenance footer. A provider-published display name wins, then the `models.dev`
name, then the raw provider model id with its version dots intact. The internal
grouping key (`logical_model`), route ids, and site ids are never shown as a
model name. When a logical model's routes resolve different names, the one from
the strongest source wins, ties broken by the provider model id.

## Provider-specific request handling

### Prompt caching

For providers that support prompt caching, Bound can separate context that usually stays the
same from content that changes each turn, reducing how much unchanged prompt content the
provider processes again. Cache warming can refresh an active thread's provider cache before
expiry, trading an additional request for a greater chance of reuse. See the [configuration
reference](/bound/reference/configuration/) for cache support and settings.

### Reasoning controls

Some providers expose controls such as an effort level, adaptive reasoning, or a fixed
thinking budget. Bound passes supported controls through the selected backend, but their
meaning and availability remain provider-specific. A fallback route must support the
capabilities the turn requests; controls should not be assumed to behave identically across
providers.

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
- An operator alert reports the refusal.

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
prompt-cache window is warm, so a run of similar turns does not pay repeated refusals. An
operator action returns the thread to the original model. Auxiliary agents and Yard
`infer()` calls resolve their own fallback chain per request and do not inherit a thread's
substitution.

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

Each host tracks the health of every route on its own, and never shares that health
with other hosts. Health is short-lived failure state, not durable configuration, so
replicating it would flood the cluster with churn; a recovering route simply gets one
trial from each live host instead. A route is in one of three states.

**Healthy** is the normal state: the route is a full candidate for any turn.

**Backing off** starts the moment a route fails. The host stops routing new turns to it
and waits before trying again. The wait starts at 30 seconds and doubles on each further
failure — 30 seconds, one minute, two minutes, and so on — up to a ceiling of four hours.
When a rate-limited provider sends a `Retry-After`, the host waits exactly that long
instead of the doubling schedule.

**Half-open** is the recovery probe. When the wait expires, the route becomes a candidate
again, but only for a real turn from a new or cold-cache thread — never a warm thread that
is already working on another route, and never a synthetic health ping. Each host lets at
most one such trial through at a time. The trial is an ordinary turn that happens to land
on the recovering route:

- If it succeeds, the route returns to healthy. The failure count clears after ten minutes
  without another failure.
- If it fails, the wait doubles again (still capped at four hours) and that turn fails over
  immediately to the next ranked route for the same model, so the trial never costs the
  thread its turn.

Some failures also raise an operator alert, because they need a human. An expired
authentication token (`401`) first tries a token refresh; the route only backs off and
alerts if the refresh itself fails, since re-login is a human action. A provider that keeps
returning malformed-request errors (a driver bug, not a refusal) raises a single alert
while automatic recovery keeps running, so a later fix is picked up without operator
action.

The candidate pool and its ranking are shaped by cluster-wide preferences that replicate
to every host, so a thread sees the same routing decision wherever its next turn runs.

### Route order

An operator can declare a preferred order of routes for a logical model. When set, the
listed routes rank first in their declared order; any eligible route that is not listed
follows, ordered by locality (local before remote) and then by a stable route identity.
Route order is a preference over identity, never over liveness — a listed route that is
offline, unhealthy, or lacks a capability the turn needs is skipped, not forced.

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

### Hard route pins

A thread, scheduled task, or auxiliary invocation can **pin** a single route for debugging.
A pin is expressed in the model hint as `logical_model@RouteId` (or `@RouteId` to pin a
route regardless of its logical model). A pinned call considers only that route: route
failover and model substitution are both disabled, and any route error or model refusal
surfaces verbatim rather than being retried elsewhere. If the pinned route no longer
exists anywhere in the cluster, the call fails with a clear error rather than silently
falling back to another route.

### Route and model removal

Routes and models come and go as providers are added, removed, or temporarily lose
their lineup. Bound distinguishes a route or model that is **momentarily down** from one
that is **gone for good**, and never destroys operator preferences on the former in case
it returns.

**Removing one route of several.** When a host drops a route — a provider is removed from
its config, or a lineup refresh no longer lists it — that route leaves the host's
advertisement and its local health state is discarded. Threads sticky to the removed
route move to the next ranked route for the same model on their next turn. A hard pin on
the removed route fails loudly rather than silently switching routes. Any route order,
drain, alias, or fallback-list entry that named the route is left in place as a dormant
no-op — it does nothing while the route is absent, and Settings › Models marks it stale so
it can be pruned by hand. A reverted config edit or a provider that comes back restores
those entries without reconfiguration.

**Removing the last route for a model.** A model becomes decommissioned only once no
non-deleted host in the cluster advertises it. A host that is merely offline or stale
still counts: while its row survives, the model it advertised stays *transiently
unavailable* (retryable, shown as a grey dot), not decommissioned. Only when cluster
host-liveness eviction removes the dead host's row does the model flip to
*decommissioned*. A decommissioned model leaves the picker for new threads and tasks.
Existing threads that target it stay readable and, on the next turn, surface a notice
asking the operator to pick another model — Bound does not silently substitute one.
Scheduled tasks naming the model literally park with an advisory (a task targeting a
cluster role follows the role instead). A cluster role or auxiliary agent pointing at the
decommissioned model raises an operator advisory rather than being silently reassigned.
Historical turn records keep the model and route that originally served each turn.

**When the model comes back.** Once any host advertises a ready route for the model again,
it reappears in the picker and existing threads resume on their next turn. Dormant
preferences that were never pruned take effect again, and the dangling-reference advisories
resolve on their own. A hard pin resumes only if the exact same route identity returns.
Scheduled tasks that parked while the model was gone stay parked — their advisory notes
the model's return so the operator can resume them deliberately, rather than firing a
burst of catch-up runs after a long absence.

See the [configuration reference](/bound/reference/configuration/#replicated-control-state)
for the cluster-wide default-model role and fallback-list keys.
