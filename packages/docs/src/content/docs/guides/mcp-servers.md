---
title: Connect MCP servers
description: Connect a local or remote Model Context Protocol server and control its exposed tools.
---

Use this guide to connect one Model Context Protocol (MCP) server, limit the tools Bound
exposes, and verify the connection in the web UI.

## Prerequisites

- A running Bound installation
- A local MCP command or remote MCP endpoint
- Any credentials required by the MCP server

## 1. Add a server

Create or update `mcp.json` in Bound's
[configuration reference](/bound/reference/configuration/). The
vendor packages, endpoints, and tool names below are illustrative and can change between
versions. Check the vendor's current documentation before using them.

### Local stdio

Add a `stdio` server to start a process on the Bound host:

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "allow_tools": ["create_issue", "get_issue", "list_issues"],
      "confirm": ["create_issue"]
    }
  ]
}
```

Replace the example token with the credential required by your server. `allow_tools` exposes
only the named tools. `confirm` requires approval for the selected exposed tools.

### Remote HTTP

To connect an HTTP endpoint instead of starting a local process, set `transport` to `http`
and provide its URL. Add headers when the endpoint requires them:

```json
{
  "servers": [
    {
      "name": "tavily",
      "transport": "http",
      "url": "https://mcp.tavily.com/mcp",
      "headers": { "Authorization": "Bearer tvly-..." }
    }
  ]
}
```

Use `stdio` with `command` and optional `args` and `env` for a process on the Bound host. Use
`http` with `url` and optional `headers` for a remote endpoint.

:::caution[Tool access]
An MCP tool runs with the access granted to its server process or remote endpoint. Expose
only the tools the agent needs with `allow_tools`, and use `confirm` to require operator
approval for sensitive actions.
:::

## 2. Reload

Apply the change without restarting Bound:

```bash
boundctl config reload mcp
```

You can restart Bound instead.

## 3. Verify

1. Open **Connections > MCP Servers**.
2. Find the configured server.
3. Confirm that it shows a connected status and the expected tools.

For multi-host installations, see the [System model](/bound/concepts/system-model/).

## Use MCP Apps

MCP Apps are optional and let compatible servers return interactive UI for supported tool
results in the web UI. See the [MCP Apps documentation](https://modelcontextprotocol.io/extensions/apps)
for server support and implementation details.

## Troubleshoot the connection

### Configuration doesn't load

Check the JSON syntax and remove fields that don't belong to the selected transport. The
transport schemas reject unknown fields. Compare the file with the
[`mcp.json` reference](/bound/reference/configuration/#mcpjs--mcpjson).

### The server or its tools don't appear

Run `boundctl config reload mcp` after saving `mcp.json`, then check **Connections > MCP
Servers** again. If the server appears but a tool doesn't, confirm that `allow_tools`
contains that tool's name.

### A remote server can't authenticate

Confirm that the required value is present in `headers`. For a local `stdio` server, confirm
that its required credential is present in `env`.

## Related concepts

- [System model](/bound/concepts/system-model/)
- [Work lifecycle](/bound/concepts/work-lifecycle/)
- [Security boundaries](/bound/concepts/security-boundaries/)
