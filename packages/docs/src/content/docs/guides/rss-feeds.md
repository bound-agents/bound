---
title: RSS Feeds
description: Poll RSS and Atom feeds and deliver new items to the agent.
---

Bound can poll RSS and Atom feeds on your behalf. When a new item appears, the agent receives it as a task — the same delivery path as a webhook, but pull-based instead of push-based.

## Creating an RSS feed

From the web UI: **Connections → RSS feeds → Create**.

From the API:

```bash
curl -X POST http://localhost:3001/api/rss-feeds \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hackernews",
    "url": "https://hnrss.org/frontpage",
    "poll_interval_seconds": 900,
    "description": "Hacker News front page"
  }'
```

Feed names must match `^[a-z0-9][a-z0-9_-]{0,63}$` — lowercase, digits, underscores, dashes, 1–64 chars.

## How polling works

A leader-gated poller fetches each feed on its `poll_interval_seconds` cadence (minimum 60 seconds, default 900). It parses RSS 2.0 and Atom feeds, and writes one task per new item.

A brand-new feed's first poll seeds without delivering — creating a feed doesn't dump its entire backlog into the agent. Only items published after the feed was created are delivered. If you change a feed's URL, the cursor resets for the same reason.

Deduplication is durable: `seen_guids` is stored on the synced feed row (capped at 500 items) so leader failover never re-delivers old items.

## Per-feed options

Each feed supports the same options as webhooks:

- **Custom prompt** — a system-prompt addition injected when processing this feed's items
- **Model hint** — route feed tasks to a specific model (empty = cluster default)
- **No history** — skip loading conversation history for the feed's tasks

## Managing feeds

From the web UI: Connections → RSS feeds. View, edit (URL, interval, prompt, model, history flag), and delete feeds. The detail view shows the linked task.

From the API: `GET /api/rss-feeds` (list), `GET /api/rss-feeds/:id` (detail), `PATCH /api/rss-feeds/:id` (edit), `DELETE /api/rss-feeds/:id` (delete).

## Multi-host

In a cluster, the poller runs on the leader host (elected under `platform_leader:rss`). If the leader goes down, a standby takes over automatically. The `seen_guids` cursor is synced, so failover doesn't cause re-delivery.
