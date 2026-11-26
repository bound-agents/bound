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

Create or update `mcp.json` in your Bound configuration directory (see the
[configuration reference](/bound/reference/configuration/#mcpjs--mcpjson)). The
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

Restarting Bound applies the change too.

## 3. Verify

1. Open **Connections > MCP Servers**.
2. Find the configured server.
3. Confirm that it shows a connected status and the expected tools.

For multi-host installations, see the [System model](/bound/concepts/system-model/).

## Authenticate with OAuth

For an `http` server that requires OAuth 2.1, add an `auth` block of `type: "oauth"` instead of
static `headers`:

```json
{
  "servers": [
    {
      "name": "acme",
      "transport": "http",
      "url": "https://mcp.acme.com/mcp",
      "auth": {
        "type": "oauth",
        "scopes": ["read", "write"],
        "client_id": "your-registered-client-id"
      }
    }
  ]
}
```

Omit `client_id` to register a public client dynamically at consent time. Set `client_secret` on
the owning host's config for a confidential client. See the
[`auth` block reference](/bound/reference/configuration/#mcpjs--mcpjson) for every field.

When a tool call reaches an unauthorized OAuth server, Bound raises a challenge and keeps the
thread usable. Resolve a challenge in any of three ways:

- Run `bound login --challenge <id>` using the challenge ID shown in `boundless` or the web UI.
- Run `bound login --mcp <server>` to authorize a server ahead of its first use.
- Click **Authorize** on the web UI consent card or under **Connections > MCP Servers** (when the
  web server is bound to loopback).

Each option opens your browser for consent through a running local daemon and stores the
resulting token on the host that owns the server. Once authorized, the waiting thread resumes so
the model can retry the call.

If the authorization server rejects a stored grant (`invalid_grant`, `invalid_client`, or
`unauthorized_client`, for example after you revoke access), Bound deletes the rejected tokens and
raises a new challenge for the server instead of retrying them. This applies at startup as well:
the server waits for authorization rather than dropping out of the server list, and resolving the
challenge reconnects it without a restart. Network failures, rate limits, and server errors leave
the stored tokens in place.

### Read OAuth failure logs

When an MCP connect, reload, or reconnect fails because of an OAuth error, the log record carries
these fields next to `error`:

| Field | Value |
| --- | --- |
| `oauthError` | The OAuth error code, such as `invalid_grant` or `temporarily_unavailable`. `error` holds only the server's description, such as `Grant not found`. |
| `tokenEndpoint` | The token endpoint that returned the error, without its query string. |
| `status` | The HTTP status of the failed token request, when Bound observed it. |

Bound logs one WARN, `[mcp-oauth] invalidating <scope> credentials for <server>`, each time it
deletes a rejected grant. The WARN carries `server`, `scope`, and the fields above. When the
rejection raises a challenge, the `needs authorization` line carries the same fields. If clearing
the grant itself fails, Bound logs `[mcp] grant-loss recovery failed for <server>` before the
ordinary `Failed to connect` WARN. Failures that aren't OAuth errors, such as a refused
connection, log `error` only. No record includes an access token, refresh token, client secret,
authorization code, or PKCE verifier.

## Use MCP Apps

Compatible `http` servers can render interactive UI inline for tool results in the web UI,
including servers configured on another host in the cluster. No extra `mcp.json` fields are
required; if an OAuth-protected app server has no grant yet, run `bound login --mcp <server>` and
reload the app. See the [MCP Apps documentation](https://modelcontextprotocol.io/extensions/apps)
for server support.

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
