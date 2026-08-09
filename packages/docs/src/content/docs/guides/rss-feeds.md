---
title: Add an RSS feed
description: Configure Bound to poll an RSS or Atom feed and process new items as tasks.
---

Use an RSS feed connection when Bound should poll a source and process each new item as an
agent task.

## Prerequisites

- A running Bound instance
- An HTTP or HTTPS RSS 2.0 or Atom feed URL

## Create the feed in the web UI

1. Open **Connections > RSS feeds**.
2. Select **Create**.
3. Enter a unique name and the feed URL.
4. Set the polling interval and optional task settings.
5. Save the feed.

The minimum polling interval is 60 seconds. The default is 900 seconds.

## Create the feed through the API

Send a request to the web server:

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

Feed names must match `^[a-z0-9][a-z0-9_-]{0,63}$`.

## Configure task behavior

Each feed can set:

- A custom prompt added to the task's system prompt
- A model hint, or the cluster default when omitted
- A no-history flag for stateless processing

## Verify delivery

The first poll initializes the feed cursor without delivering existing items. Publish or
wait for a new feed item, then confirm that the linked task runs in **Timetable**.

## Manage the feed

Open **Connections > RSS feeds** to edit or delete a feed. Changing the URL resets the
cursor, so the first poll of the replacement URL also seeds without delivering its backlog.

The API provides `GET /api/rss-feeds`, `GET /api/rss-feeds/:id`,
`PATCH /api/rss-feeds/:id`, and `DELETE /api/rss-feeds/:id`.

## Delivery and failover behavior

Only the elected RSS leader polls feeds. Bound stores up to 500 seen item identifiers on
the synced feed row, allowing a replacement leader to continue without replaying recent
items.
