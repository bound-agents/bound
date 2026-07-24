---
title: MCP Servers
description: Connect MCP servers for tool access, and use MCP Apps for inline interactive UI in the web interface.
---

Bound connects to external [Model Context Protocol](https://modelcontextprotocol.io) servers and registers their tools as agent commands. MCP server tools are auto-registered — the agent can call them like any built-in tool.

## Configuration

MCP servers are configured in `mcp.json`:

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    {
      "name": "tavily",
      "transport": "http",
      "url": "https://mcp.tavily.com/mcp",
      "headers": { "Authorization": "Bearer tvly-..." }
    }
  ]
}
```

### Common fields

Every server entry has: `name` (non-empty string), `allow_tools` (optional array of tool names to allowlist), `confirm` (optional array of tools that require confirmation before execution).

### stdio transport

Runs a local process and communicates over stdin/stdout. Fields: `command` (required), `args` (optional array), `env` (optional string→string map).

### http transport

Connects to a remote HTTP endpoint. Fields: `url` (required), `headers` (optional string→string map).

Each transport variant is strict independently — unknown keys on one transport don't slip through via the other.

## Tool registration

MCP server tools are registered as subcommand-dispatched commands through the sandbox: one `CommandDefinition` per MCP server (named by the server name, e.g. `github`), with a `subcommand` parameter selecting the individual tool. This reduces the LLM tool definition count and simplifies cross-host delegation tracking.

The agent calls MCP tools like any other tool. The LLM sees them as structured JSON schemas — no string parsing.

## Cross-host tool calls

When an MCP tool lives on a remote host (because the server process only runs on one machine), the tool call relays through the sync transport:

1. The requesting host writes a `tool_call` relay message
2. The target host receives it, executes the tool locally
3. The target writes a `result` response back via the relay
4. The requesting host's agent loop picks it up

Client tools (boundless filesystem/shell) relay as `client_tool` → `client_result` through the WS session host.

## Allowlisting tools

Use `allow_tools` to restrict which tools from a server are exposed to the agent:

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "allow_tools": ["create_issue", "get_issue", "list_issues"]
}
```

Use `confirm` to require explicit approval before a tool executes:

```json
{
  "confirm": ["create_issue", "create_pull_request"]
}
```

## MCP Apps

When an `http`/`sse` MCP server advertises the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) `io.modelcontextprotocol/ui` capability, its UI-bearing tool results render inline as interactive apps in the web UI.

There is no separate config for MCP Apps — app-bearing servers are discovered automatically by joining `mcp.json` against the synced capability inventory (captured at connect time). The web router serves the browser-reachable subset via `GET /api/mcp-apps`.

The agent still calls these tools server-side as normal. The browser is purely a renderer: it reads the server's `ui://` resources and routes the app's callbacks. It is never a second tool provider.
