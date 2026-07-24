---
title: Web UI & Platforms
description: The Hono API server, Svelte 5 SPA, WebSocket protocol, and MCP-based platform connectors.
---

Bound exposes two HTTP servers and a real-time WebSocket interface. Platform connectors (Discord, etc.) are in-process MCP servers managed by the platforms package.

## Servers

| Server | Port | Purpose |
| --- | --- | --- |
| Web | `WEB_PORT` (3001) | Hono API + Svelte 5 SPA + WebSocket |
| Sync | `PORT` (3000) | Hub-spoke sync + relay + webhook ingestion |

The web server refuses to start on a non-loopback `WEB_BIND_HOST` without `BOUND_ALLOW_UNSAFE_WEB_BIND=1`, because it exposes unauthenticated endpoints (`/api/sandbox/file` arbitrary cluster-FS read/write and `/ws` agent control) that assume a loopback-only trust boundary.

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/threads` | POST | Create a thread |
| `/api/threads/:id/messages` | POST | Send a message |
| `/api/files` | — | File CRUD |
| `/api/memory` | — | Memory operations |
| `/api/status` | — | Cluster status |
| `/api/tasks` | — | Task management |
| `/api/advisories` | — | Advisory operations |
| `/api/mcp` | — | MCP server management |
| `/api/skills` | — | Skill CRUD |
| `/api/webhooks` | — | Webhook management |
| `/api/rss-feeds` | — | RSS feed management |
| `/api/mcp-apps` | GET | Browser-reachable MCP app inventory |

Cross-host MCP tool calls are relayed through the sync transport, not a dedicated HTTP proxy endpoint.

## WebSocket

`GET /ws` on the web server carries chat and event streaming. The web UI is a real-time Svelte 5 SPA — live chat, thread management, task-scheduler visualization, model/backend selection, and MCP app rendering.

## Platform connectors

Platform connectors are in-process MCP servers managed by `PlatformMcpRegistry` in `@bound/platforms`. Each connector is configured in `platforms.json`.

### Leader election

Only the leader host runs active event subscriptions. Standby hosts take over after a configurable silence threshold (`failover_threshold_ms`, default 30s). Leadership roles:

| Role | Behavior |
| --- | --- |
| `auto` | Participate in election (default) |
| `leader` | Always leader |
| `standby` | Always standby |
| `all` | Run subscriptions on every host |

### Connector tool

The unified `connector` tool (`action: list | channels | attach | detach`) manages event subscriptions. The `connector_handles` table (synced, LWW) tracks which events each task is subscribed to.

Tool scoping is two-branch:

- **Event task threads** — get scoped tools from the bound server via `getToolsForThread(threadId)`
- **Other threads** — get read-only platform tools (filtered by `annotations.readOnlyHint === true`) plus the `connector` tool

### Discord

Discord is the primary platform connector. Configuration in `platforms.json`:

```json
{
  "connectors": [
    {
      "platform": "discord",
      "token": "<bot-token>",
      "allowed_users": ["<discord-user-id>"],
      "leadership": "auto"
    }
  ]
}
```

Discord messages reach the agent as `intake` relay messages routed to the host with platform affinity. Outbound responses are sent via the `discord_send_message` tool, relayed to the leader host via the unified tool dispatch if needed.

## MCP Apps

When an `http`/`sse` MCP server advertises the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) `io.modelcontextprotocol/ui` capability, its UI-bearing tool results render inline as interactive apps in the web UI.

There is no separate config: app-bearing servers are discovered by joining `mcp.json` against the synced capability inventory. The agent still calls these tools server-side as normal; the browser is purely a renderer (it reads the server's `ui://` resources and routes the app's callbacks), never a second tool provider.
