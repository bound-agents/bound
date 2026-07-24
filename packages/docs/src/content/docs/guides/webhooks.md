---
title: Webhooks
description: Receive external events via HTTP webhooks and turn them into agent tasks.
---

Bound can receive external events via webhooks. An external service POSTs to a URL on your bound instance, the payload is validated, and the agent processes it as a new task. This is how GitHub pushes, Stripe events, Slack webhooks, and other integrations reach the agent.

## How it works

Each webhook is a three-row consist: a `webhooks` row (name, secret, signature format), a delivery thread, and an event task. When a POST hits `/webhook/:name` on the sync server (port 3000), the signature is validated against the configured format, and the payload is delivered to the agent as a task.

## Creating a webhook

From the web UI: **Connections → Webhooks → Create**.

From the API:

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github",
    "format": "github",
    "description": "GitHub push events"
  }'
```

The response includes a `secret` — you'll need this to configure the external service's webhook signature. The secret is only shown once at creation time.

### Signature formats

| Format | How it validates | Use case |
| --- | --- | --- |
| `github` | HMAC-SHA256 of the payload body, sent in `X-Hub-Signature-256` | GitHub webhooks |
| `stripe` | HMAC-SHA256, sent in `Stripe-Signature` header | Stripe events |
| `slack` | HMAC-SHA256, sent in `X-Slack-Signature` | Slack slash commands / events |
| `raw` | HMAC-SHA256, sent in `X-Signature` header | Custom integrations |
| `none` | No signature validation | **Unauthenticated** — gated by a cluster-wide kill switch |

The `none` format is unauthenticated — no signature is checked. It's off by default and must be explicitly enabled cluster-wide before a `none` webhook can be created or receive deliveries. Toggle it in the web UI (Connections → Webhooks) or via the API:

```bash
curl -X PUT http://localhost:3001/api/webhooks/unauthenticated-switch \
  -H "Content-Type: application/json" \
  -d '{"allow_unauthenticated": true}'
```

## Webhook URLs

The webhook endpoint is on the **sync server** (port 3000), not the web API (port 3001). The web UI shows all valid delivery URLs for your cluster — the hub URL, local URLs, and peer host URLs — so you can pick the one that matches your deployment topology.

```
http://your-hub-host:3000/webhook/github
```

If you're behind a reverse proxy, point it at port 3000 on the hub.

## Per-webhook options

Each webhook supports:

- **Custom prompt** — a system-prompt addition injected into the agent's context when processing this webhook's events
- **Model hint** — route the webhook's tasks to a specific model (empty = cluster default)
- **No history** — skip loading conversation history for the webhook's task (useful for stateless event processing)

## Deduplication

Inbound deliveries are deduplicated using platform delivery headers (`X-GitHub-Delivery`, `Stripe-Idempotency-Key`, `X-Idempotency-Key`). Duplicate deliveries are silently dropped.

## Configuring the external service

Point the external service's webhook URL at your bound instance:

**GitHub example:**
1. Go to your repo → Settings → Webhooks → Add webhook
2. Payload URL: `http://your-hub-host:3000/webhook/github`
3. Content type: `application/json`
4. Secret: the secret returned when you created the webhook
5. Select the events you want to receive

**Stripe example:**
1. Go to Stripe Dashboard → Developers → Webhooks → Add endpoint
2. Endpoint URL: `http://your-hub-host:3000/webhook/stripe`
3. Select the events to send
4. The signing secret from Stripe goes into the webhook's secret field

## Managing webhooks

From the web UI, you can view, edit, and delete webhooks in the Connections → Webhooks tab. The detail view shows the cluster-wide delivery URLs, the linked task, and recent deliveries.

From the API: `GET /api/webhooks` (list), `GET /api/webhooks/:id` (detail), `PATCH /api/webhooks/:id` (edit), `DELETE /api/webhooks/:id` (delete).
