---
title: Security and execution boundaries
description: Understand the trust, authorization, data, and execution boundaries of each Bound interface.
---

Bound combines interfaces, hosts, providers, and tools with different trust boundaries. No
single control secures all of them. Evaluate authentication, authorization, confirmation,
confinement, and transport encryption separately.

## Security controls

- **Authentication** establishes who or what is connecting. Webhook signatures and the sync
  handshake authenticate different kinds of senders.
- **Authorization** decides what an authenticated identity may do. User allowlists and
  connector restrictions are authorization controls.
- **Confirmation** asks for approval before a selected operation. An MCP confirmation rule
  does not authenticate the MCP server or confine its process.
- **Confinement** restricts where code can write or which network destinations it can reach.
  It does not necessarily restrict reads or prevent data from being sent through an allowed
  tool.
- **Transport encryption** protects data in transit between endpoints. It does not decide
  whether an endpoint is trusted to receive that data.

Before comparing surfaces, it helps to separate the roles. An **operator** configures and
runs Bound. A **user or caller** sends work. A **Bound host** receives or runs that work.
A **provider** supplies a model or tool, and a host or live client owns the connection used
to reach it. One person or machine can fill more than one role.

## Surface comparison

| Surface | Execution and data boundary | Primary control |
| --- | --- | --- |
| Web UI and web API | The web server exposes conversations and operational controls. Its default local-only address assumes trust in the local machine. | Listen address, network access, and configured user identity. |
| Platform connector | A connector receives platform events and makes a limited set of tools available. | Platform credentials, allowed users, and the connector's allowed actions. |
| Webhook | An HTTP endpoint receives an external request and wakes linked work after validation. | Signature validation; accepting unsigned requests requires an explicit setting for the cluster. |
| `boundless` terminal client | Bound runs the agent loop while a live client provides file and shell tools. Rules for reads and writes are separate. | Client connection, working directory, operating-system restrictions, and tool permissions. |
| ACP editor | Bound supplies the agent and model access while the editor supplies workspace tools. | Editor permissions and the live client session. |
| Configured MCP server | The server supplies tools and receives their arguments through the host connected to it. | Server settings, the allowed-tool list, and confirmation for selected tools. |
| Relayed inference | The host running the loop sends model context to the selected inference host. | Trust between cluster hosts, provider credentials, and encrypted cluster transport where documented. |
| Responses API | The caller supplies complete stateless model input. Bound does not load agent memory, skills, or thread history. | Network access or an operator-provided authenticated proxy. The endpoint has no bearer-token authentication; any supplied bearer token is ignored. |

## Network and host boundaries

The web server defaults to loopback. Exposing it beyond the local machine also exposes API
surfaces that were designed around that trust boundary. Put an access-controlled proxy or
an equivalent network boundary in front of a remotely reachable deployment.

Webhook traffic enters through an HTTP listener. Signed formats validate the sender using
the configured secret. The unsigned format performs no signature validation and is disabled
unless an operator explicitly allows unauthenticated webhooks across the cluster. Keep such
an endpoint behind a boundary that admits only intended senders.

Hosts use signed identities and encrypted sync traffic. This protects cluster transport, but
it is distinct from user authorization and from the decision to send model context to a
remote inference host.

## Tool and filesystem boundaries

A tool's **provider** is the component that makes the tool available, such as Bound, an MCP
server, or a live client. Its **owner** is the host or client that maintains the connection
and handles the call. Native tools act on Bound state, MCP tools run through their server,
and live client tools act on the client host. Knowing that a tool exists does not make it
available when its server or client is disconnected.

The agent virtual filesystem and a host workspace are separate. The virtual filesystem is
persisted through Bound state. A `boundless` client can expose host reads and constrained
writes. Write confinement does not imply that host reads are confined to the same paths.
See [Sandbox and filesystems](/bound/concepts/sandbox/) for the operation-level model.

## Limits of these controls

These controls are not interchangeable. Loopback binding is a deployment boundary, not
application-level authentication, and the Responses API does not provide bearer-token
authentication. Encryption protects transport but does not authorize every connected party.
Tool confirmation does not sandbox a tool. Write confinement does not prevent reading data
or sending it through another allowed capability.

## Related documentation

- [How Bound fits together](/bound/concepts/system-model/) for host, agent, and interface roles.
- [State, consistency, and multi-host operation](/bound/concepts/sync/) for replication and
  cluster transport.
- [Create a webhook](/bound/guides/webhooks/) for webhook setup and signature options.
- [Connect MCP servers](/bound/guides/mcp-servers/) for tool allowlists and confirmation.
- [Responses API](/bound/reference/responses-api/) for endpoint behavior and deployment.
