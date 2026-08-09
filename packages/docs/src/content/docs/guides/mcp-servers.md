---
title: Connect MCP servers
description: Add local or remote Model Context Protocol servers to Bound's tool inventory.
---

This guide connects a [Model Context Protocol](https://modelcontextprotocol.io) server and
controls which of its tools Bound exposes.

## Prerequisites

- A running Bound installation
- A local MCP command or remote MCP endpoint

## Add a server

Add the server to `mcp.json`:

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

Restart Bound after changing this file, or reload MCP configuration:

```bash
boundctl config reload mcp
```

## Choose a transport

Use `stdio` for a process that runs on the Bound host. Set `command`, and optionally set
`args` and `env`.

Use `http` for a remote endpoint. Set `url`, and optionally set `headers`.

Each transport schema is strict. Unknown fields cause configuration loading to fail.

## Restrict exposed tools

Set `allow_tools` to expose only named tools:

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "allow_tools": ["create_issue", "get_issue", "list_issues"]
}
```

Set `confirm` to require approval for selected tools:

```json
{
  "confirm": ["create_issue", "create_pull_request"]
}
```

## Verify the connection

Open **Connections > MCP Servers**. Confirm that the server, host, and expected tools appear
in the cluster inventory.

Bound represents each MCP server as one command with a `subcommand` parameter. If the
server runs on another host, Bound relays the tool call to that host.

## Use MCP Apps

When an HTTP MCP server advertises the
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
`io.modelcontextprotocol/ui` capability, supported tool results render as interactive apps
in the web UI.

MCP Apps require no separate Bound configuration. The server remains the tool provider;
the browser renders its `ui://` resources.
