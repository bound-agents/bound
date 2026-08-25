---
title: Inference and model routing
description: How Bound chooses an eligible model location, relays inference, and shapes provider context.
---

Bound can send a model request to different model services and locations. A **backend** is
a configured connection to a model service. A **host** is a Bound instance in the cluster.
The **loop host** coordinates the agent turn, while the **inference host** owns the backend
that serves a particular model request. These can be the same host or different hosts.

**Routing** is the process of choosing an eligible backend and, therefore, the host that
will serve the request. It does not move the agent loop.

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

A model advertisement or fallback route does not guarantee that a routed request will
succeed. The selected backend or relay can be unavailable, reject the request, or lack a
required capability. Bound reports a failure when it cannot complete the selected route;
retry and recovery behavior belongs to the [work
lifecycle](/bound/concepts/work-lifecycle/).

## Local and hosted backends

A backend can use a model service running locally or a hosted provider API. Providers differ
in authentication, model discovery, request controls, and prompt-cache support. See the
[configuration reference](/bound/reference/configuration/#model_backendsjs) for the
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
