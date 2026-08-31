---
title: Add an RSS feed
description: Configure and verify an RSS or Atom feed that processes new items as Bound tasks.
---

Use this guide to make Bound poll an RSS or Atom feed and process each new item.

## Prerequisites

- A running Bound instance
- An HTTP or HTTPS RSS 2.0 or Atom feed URL

## 1. Create the feed

1. Open **Connections > RSS feeds**.
2. Select **Create**.
3. Enter a unique name and the feed URL.
4. Set the polling interval.
5. Save the feed.

A successful create automatically creates a system-owned delivery thread and a pending
linked event task. Bound stores those links as `thread_id` and `task_id` on the feed source.

The minimum polling interval is 60 seconds. The default is 900 seconds.

## 2. Configure the linked event task

Edit the feed to set any optional task behavior:

- `prompt`, mapped to the linked event task's `system_prompt_addition`
- `model_hint`, applied to the linked event task and its delivery thread
- `no_history`, applied to the linked event task

For how scheduled and event-driven tasks move through Bound, read
[Work lifecycle](/bound/concepts/work-lifecycle/).

## 3. Verify a new item

The first poll initializes the feed cursor without delivering existing items.

1. Wait for the first poll to complete.
2. Publish or wait for a new feed item.
3. Open **Timetable**.
4. Confirm that the linked event task runs for the new item.

## Create a feed through the API

As an alternative to the web UI, send all supported create fields to the web server:

```bash
curl -X POST http://localhost:3001/api/rss-feeds \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hackernews",
    "url": "https://hnrss.org/frontpage",
    "description": "Hacker News front page",
    "prompt": "Summarize each new item and explain why it matters.",
    "poll_interval_seconds": 900,
    "model_hint": "fast",
    "no_history": true
  }'
```

The `prompt`, `model_hint`, and `no_history` fields are optional. Omitting
`poll_interval_seconds` uses the 900-second default. Feed names must match
`^[a-z0-9][a-z0-9_-]{0,63}$`.

### Feed URL restrictions

Bound polls feeds server-side, so a feed URL is a request the bound host makes on
your behalf. To keep a feed from being used to reach internal services, the poller
rejects any URL — and any redirect it follows — whose resolved address is not
publicly routable: loopback, link-local (including the `169.254.0.0/16` cloud-metadata
range), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), multicast, or
unspecified, for both IPv4 and IPv6 (including IPv4-mapped IPv6 forms such as
`::ffff:169.254.169.254`). URLs must be `http`/`https`. A whole poll — DNS resolution
plus every redirect hop — shares one 30-second deadline, and the response body is
capped while streaming, so a slow or oversized endpoint cannot hold a poll open or
exhaust memory. A feed pointed at a blocked address fails its poll with a
"not publicly routable" error and delivers nothing.

## Edit or delete the feed

Open **Connections > RSS feeds** to edit or delete a feed. Changing the URL resets the seen
cursor. The next poll seeds the replacement feed's cursor without delivering its existing
backlog.

Deleting a feed cancels its linked event task. Its delivery thread remains.

The API provides these endpoints:

```text
GET /api/rss-feeds
GET /api/rss-feeds/:id
PATCH /api/rss-feeds/:id
DELETE /api/rss-feeds/:id
```

## Troubleshoot delivery

### Existing items aren't delivered

Bound seeds the seen cursor without delivering the existing backlog on the first poll after
creating a feed or changing its URL. Wait for that poll to complete, then verify with an item
published afterward.

### Items aren't checked as often as configured

Confirm that the interval is at least 60 seconds. Open **Connections > RSS feeds** and check
the saved interval and URL.

## Multi-host behavior

Only the elected RSS leader polls feeds. Bound stores up to 500 seen item identifiers on the
synchronized feed row so that a replacement leader can continue without replaying recent
items. This bounded history is not a general exactly-once guarantee.

After a 15-minute grace window, every host reconciles its own local RSS, webhook, and connector intake. A live binding is re-emitted locally as an event wakeup; repeated emissions are safe because the scheduler claims the task once and only marks intake processed after its wakeup is durable. A deleted feed or connector handle’s orphaned intake is dead-lettered. This local recovery is not leader-gated: a host that has since lost connector leadership can still drain connector intake it accepted. Diagnostic reconciliation without an event bus raises an advisory instead.

`relay_inbox` is local to the host that accepted the item. If an RSS leader dies permanently after advancing the synchronized seen cursor, a successor cannot read that leader’s local inbox rows. A synced pending-delivery ledger would be required to close that residual cross-host loss window.

For how polling work proceeds, read [Work lifecycle](/bound/concepts/work-lifecycle/). For
how hosts share feed state, read [Synchronization](/bound/concepts/sync/).

## Related concepts

- [Work lifecycle](/bound/concepts/work-lifecycle/)
- [System model](/bound/concepts/system-model/)
- [Security boundaries](/bound/concepts/security-boundaries/)
