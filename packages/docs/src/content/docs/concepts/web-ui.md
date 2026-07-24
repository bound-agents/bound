---
title: Web UI Tour
description: The eight tabs of the Bound web interface — what each one does and when to use it.
---

The Bound web UI runs at `http://localhost:3001` by default. It's a real-time single-page app — live chat, thread management, task scheduling, and cluster monitoring, all in one place.

## System Map

The landing page. Shows all conversation threads (web, Discord, boundless, scheduled tasks) with search and live activity indicators. Click a thread to open it in the Line view. Create new threads here.

A memory graph visualization is available — it renders the agent's knowledge graph as an interactive node-link diagram.

## Timetable

The task scheduler view. Shows all scheduled tasks — cron, deferred, event-driven, and heartbeat — with their status, next run time, and trigger type. Filter by status, expand a task to see details.

Think of it as a departure board for the agent's autonomous work: what's running, what's queued, what's coming up.

## Network

Cluster network status. Shows all known hosts, their sync state, online/offline status, and which models each host advertises. Use this to verify your cluster is healthy and see which hosts are available for inference.

## Advisories

Operational advisories — cost alerts, frequency anomalies, model issues. Each advisory has a lifecycle: `proposed` → `approved` → `applied` (or `dismissed`/`deferred`). Every state change requires a note explaining why.

Advisories are how the agent flags things that need your attention. Check here if something seems off.

## Files

File browser for the agent's virtual filesystem. Shows all files the agent has created or modified, organized by path. Preview files inline. Files replicate across hosts via sync.

## Connections

A consolidated tab with five sub-sections:

### Webhooks

Create and manage webhook endpoints. Each webhook has a name, a signature format (GitHub, Stripe, Slack, raw HMAC, or unauthenticated), and optional settings: a custom prompt, a model hint, and a no-history flag. The cluster-wide unauthenticated-webhook kill switch is here too — it's off by default, and must be explicitly enabled before unsigned webhooks can be created or receive deliveries.

See [Webhooks](/bound/guides/webhooks/) for details.

### RSS feeds

Create and manage RSS/Atom feed subscriptions. Each feed polls on a configurable interval (minimum 60 seconds, default 900). Like webhooks, feeds support custom prompts, model hints, and no-history. A brand-new feed's first poll seeds without delivering — creating a feed doesn't dump its backlog.

See [RSS Feeds](/bound/guides/rss-feeds/) for details.

### Connector bindings

Platform event subscriptions — shows which Discord channels (or other platform events) the agent is subscribed to, and which tasks handle them. Detach a binding to stop the agent from receiving those events.

### Skills

Manage the agent's skills — import, view, and delete SKILL.md files. See [Skills](/bound/concepts/skills/) for the skill format.

### MCP Servers

Cluster MCP tool inventory. Shows all connected MCP servers across all hosts, their tools, and which host holds each server. Use this to verify your MCP connections are live.

## Metrics

Usage analytics with a date range selector:

- **Cost timeline** — spending over time, per model
- **Token charts** — input, output, cache-read, cache-write tokens
- **Cache hit timeline** — prompt cache hit rate over time
- **Latency** — per-model response latency
- **Relay cycles** — cross-host relay timing and success rates

Polls automatically when the date range includes "now".

## Persona

Cluster-wide persona editor. The persona is free-form Markdown that becomes the agent's voice — personality, working style, habits. Changes propagate to every host and take effect on the next turn. Capped at 64 KB.

You can also set the persona from the CLI: `boundctl set-persona --file my-persona.md`.
