---
title: HTTP API reference
description: Endpoints, request boundaries, and payload rules for Bound's web and webhook HTTP APIs.
---

The Bound web server listens on `http://localhost:3001` by default and serves JSON endpoints
under `/api/*`. Webhook delivery ingress runs separately on the sync server (`http://localhost:3000`
by default) at `/webhook/:name`.

By default, the web server accepts requests with `Host` headers matching `localhost`, `127.0.0.1`,
or `[::1]`. See [Security boundaries](/bound/concepts/security-boundaries/) before exposing the
server beyond loopback.

For stateless OpenAI-compatible inference at `POST /v1/responses`, see the
[Responses API reference](/bound/reference/responses-api/).

## Threads and messages

| Method and path | Purpose |
| --- | --- |
| `GET /api/threads` | List threads |
| `POST /api/threads` | Create a thread |
| `GET /api/threads/:id` | Get thread details |
| `PATCH /api/threads/:id` | Rename or update a thread |
| `GET /api/threads/:id/status` | Get live turn status |
| `GET /api/threads/:id/cost` | Get thread spend summary |
| `GET /api/threads/:id/messages` | List messages in a thread |
| `POST /api/threads/:id/messages` | Send a message to a thread |
| `POST /api/threads/:id/redact` | Redact messages in a thread |
| `POST /api/threads/:id/messages/:messageId/redact` | Redact a single message |

## Webhooks

| Method and path | Purpose |
| --- | --- |
| `GET /api/webhooks` | List webhooks |
| `POST /api/webhooks` | Create a webhook and linked event task |
| `GET /api/webhooks/:id` | Get webhook details (excludes secret) |
| `GET /api/webhooks/:id/urls` | List candidate delivery URLs on the sync server |
| `PATCH /api/webhooks/:id` | Update webhook settings |
| `DELETE /api/webhooks/:id` | Soft-delete a webhook and cancel its linked task |
| `POST /api/webhooks/:id/rotate` | Generate and return a new signing secret |
| `GET /api/webhooks/unauthenticated-switch` | Check whether `none` format webhooks are permitted |
| `PUT /api/webhooks/unauthenticated-switch` | Toggle cluster-wide `allow_unauthenticated` (`true` or `false`) |

`POST /api/webhooks` accepts `name` (immutable), `format` (`github` default, `stripe`, `slack`,
`raw`, or `none`), and optional `description`, `prompt`, `model_hint`, and `no_history`. The
`201 Created` response returns the generated `secret` once along with `id`, `task_id`, and
`thread_id`.

### Webhook delivery ingress

Senders post payloads to `POST /webhook/:name` on the sync server (port `3000`). Valid requests
return `202 Accepted` and queue the linked event task.

| Signature format | Validation |
| --- | --- |
| `github` | HMAC-SHA256 of the body in `X-Hub-Signature-256` |
| `stripe` | HMAC-SHA256 with timestamp (within 5 minutes) in `Stripe-Signature` |
| `slack` | HMAC-SHA256 with timestamp (within 5 minutes) in `X-Slack-Signature` |
| `raw` | HMAC-SHA256 over timestamp and body in `X-Webhook-Signature` and `X-Webhook-Timestamp` |
| `none` | No signature check (requires cluster-wide `allow_unauthenticated: true`) |

Bound deduplicates deliveries that include `X-GitHub-Delivery`, `Stripe-Idempotency-Key`, or
`X-Idempotency-Key`.

## RSS feeds

| Method and path | Purpose |
| --- | --- |
| `GET /api/rss-feeds` | List configured RSS and Atom feeds |
| `POST /api/rss-feeds` | Create a feed and linked event task |
| `GET /api/rss-feeds/:id` | Get feed details |
| `PATCH /api/rss-feeds/:id` | Update feed settings (changing `url` resets the seen cursor) |
| `DELETE /api/rss-feeds/:id` | Delete a feed and cancel its linked task |

`POST /api/rss-feeds` accepts `name` (matching `^[a-z0-9][a-z0-9_-]{0,63}$`), `url` (`http` or
`https`), optional `description`, `prompt`, `model_hint`, `no_history`, and
`poll_interval_seconds` (minimum `60`, default `900`).

### Feed URL restrictions

The poller rejects any URL or redirect target whose resolved IPv4 or IPv6 address is not publicly
routable — including loopback, link-local (`169.254.0.0/16`), private (`10/8`, `172.16/12`,
`192.168/16`, `fc00::/7`), multicast, unspecified, and IPv4-mapped IPv6 equivalents — with a
`not publicly routable` error. Each poll shares a 30-second deadline across DNS resolution and
redirects, and caps the streamed response body size.

## Skills

| Method and path | Purpose |
| --- | --- |
| `GET /api/skills` | List imported and bundled skills |
| `POST /api/skills` | Import a skill directory |
| `GET /api/skills/:id` | Inspect a skill and its files |
| `PATCH /api/skills/:id` | Update a skill |
| `DELETE /api/skills/:id` | Soft-delete a skill (including bundled skills) |

Skill authoring limits:

| Field | Limit |
| --- | --- |
| `name` | 1–64 characters, kebab-case matching `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `description` | Up to 1,024 characters |
| `SKILL.md` body | Up to 500 lines and 64 KB |

## Tasks, advisories, and connectors

| Method and path | Purpose |
| --- | --- |
| `GET /api/tasks` | List tasks |
| `GET /api/tasks/:id` | Get task details |
| `PATCH /api/tasks/:id` | Update task model hint, history mode, or alert threshold |
| `POST /api/tasks/:id/cancel` | Cancel a task |
| `GET /api/advisories` | List advisories |
| `GET /api/advisories/count` | Count open advisories |
| `POST /api/advisories/:id/{approve,dismiss,defer,apply}` | Transition an advisory state (requires a note) |
| `GET /api/connectors/bindings` | List platform connector bindings |
| `PATCH /api/connectors/bindings/:id` | Update a connector binding |
| `DELETE /api/connectors/bindings/:id` | Detach a connector binding |

## MCP, files, memory, persona, and status

| Method and path | Purpose |
| --- | --- |
| `GET /api/mcp/servers` | List configured MCP servers and tools |
| `GET /api/mcp-apps` | List available MCP Apps |
| `GET /api/mcp-challenges` | List pending OAuth challenges |
| `GET /api/mcp-challenges/by-server` | List OAuth challenge status per MCP server |
| `POST /api/mcp-challenges/:id/claim` | Claim a pending OAuth challenge |
| `GET /api/files` | List virtual filesystem entries |
| `GET /api/files/download` | Download a virtual file |
| `POST /api/files/upload` | Upload a virtual file |
| `GET /api/memory/graph` | Read the memory knowledge graph |
| `GET /api/persona` | Read the cluster-wide persona |
| `POST /api/persona` | Update the cluster-wide persona (up to 64 KB). Optional `expected_modified_at` enables optimistic concurrency: if it does not match the stored `modified_at`, the write is rejected with `409 Conflict` |
| `GET /api/status` | Read host status |
| `GET /api/status/network` | Read cluster network and sync status |
| `GET /api/status/models` | List advertised models across the cluster |
| `POST /api/status/cancel/:threadId` | Cancel an active turn on a thread |
| `GET /api/metrics` | Query inference cost, token, cache, latency, and relay metrics |
