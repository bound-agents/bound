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

## Routing preferences, drains, and pins

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

See the [configuration reference](/bound/reference/configuration/#replicated-control-state)
for the cluster-wide default-model role and fallback-list keys.
