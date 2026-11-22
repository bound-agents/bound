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
3. **Where can the request run?** Bound prefers an eligible backend on the loop host, then can
   consider an advertised backend on another host or a configured fallback route.

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
