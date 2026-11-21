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

## Edit or delete the feed

Open **Connections > RSS feeds** to edit or delete a feed. Changing the URL resets the seen
cursor so the next poll seeds the replacement feed without delivering its existing backlog.
Deleting a feed cancels its linked event task while keeping its delivery thread.

To manage feeds programmatically or review feed URL and naming rules, see the
[HTTP API reference](/bound/reference/http-api/#rss-feeds).

## Troubleshoot delivery

### Existing items aren't delivered

Bound seeds the seen cursor without delivering the existing backlog on the first poll after
creating a feed or changing its URL. Wait for that poll to complete, then verify with an item
published afterward.

### Items aren't checked as often as configured

Confirm that the interval is at least 60 seconds. Open **Connections > RSS feeds** and check
the saved interval and URL.

### Feed fails with `not publicly routable`

Bound blocks feed URLs and redirects that resolve to loopback, private, or link-local addresses.
Use a publicly routable `http` or `https` URL. See
[Feed URL restrictions](/bound/reference/http-api/#feed-url-restrictions) for the full list.

## Multi-host behavior

In a multi-host cluster, only the elected RSS leader polls feeds. Bound replicates up to 500 seen
item identifiers on the feed record so a replacement leader can continue without replaying recent
items. For how hosts share feed state, read [Synchronization](/bound/concepts/sync/).

For how polling work proceeds, read [Work lifecycle](/bound/concepts/work-lifecycle/). For
how hosts share feed state, read [Synchronization](/bound/concepts/sync/).

## Related concepts

- [Work lifecycle](/bound/concepts/work-lifecycle/)
- [System model](/bound/concepts/system-model/)
- [Security boundaries](/bound/concepts/security-boundaries/)
