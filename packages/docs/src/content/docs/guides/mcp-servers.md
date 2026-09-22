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

Restarting Bound applies the change too.

## 3. Verify

1. Open **Connections > MCP Servers**.
2. Find the configured server.
3. Confirm that it shows a connected status and the expected tools.

For multi-host installations, see the [System model](/bound/concepts/system-model/).

## Authenticate with OAuth

An `http` server that returns `401` with an authorization challenge, or steps up scope with
`403 insufficient_scope`, needs an OAuth 2.1 grant. Add an `auth` block of `type: "oauth"` to
switch that server off the static-`headers` path:

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

Omit `client_id` to register a public client with the authorization server at consent time.
Set `client_secret` for a confidential client; declare it only on the host that owns this
server's config, because it never syncs and never crosses the relay. See the
[`auth` block reference](/bound/reference/configuration/#mcpjs--mcpjson) for every field.

The first call to an OAuth server that has no token does not fail permanently. Bound raises a
challenge, settles the call, and keeps the thread usable. The settled tool result surfaces as a
consent affordance on whichever surface the call ran on:

- **boundless / TUI** renders a `🔐 authorization required` notice naming the server, the demanded
  scopes, and the challenge id, with the `bound login --challenge <id>` command inline. Nothing
  blocks — the call already settled and the thread stays usable.
- **web chat** renders a consent card at the top of the thread listing every pending challenge. On
  a loopback web bind (`WEB_BIND_HOST` unset or loopback, the default) the card carries a live
  **Authorize** button that opens your browser for consent. On a non-loopback bind (`0.0.0.0`, the
  documented hub setting) the card carries no button — a loopback callback is unreachable from a
  remote browser — and instead shows the `bound login --challenge <id>` instruction to run from a
  local session.

Resolve a challenge from any host:

- Run `bound login --challenge <id>` with the challenge id from the settled tool result or a card.
- Run `bound login --mcp <server>` to authorize a server before its first use.
- Click **Authorize** on the web consent card (loopback bind only).

Each of these opens your browser for consent and requires a running local daemon: the daemon
serves the loopback callback and transfers the authorization code to the host that owns the
server. That owning host performs the token exchange and holds the token in its own
`config/mcp-auth.json`; the token never syncs and never crosses the relay, so custody is per-host.
When the grant resolves, the thread that raised the challenge is woken so the model can re-issue
the call. Consent affordances are not delivered over platform connectors (Discord) — a challenge
raised from a connector thread still settles and resolves from the web card or the CLI. See
[CLI and operations](/bound/guides/cli-operations/#bound-login) for the command reference.

## Use MCP Apps

MCP Apps are optional and let compatible servers return interactive UI for supported tool
results in the web UI. See the [MCP Apps documentation](https://modelcontextprotocol.io/extensions/apps)
for server support and implementation details.

The web UI reaches an app-bearing server through a same-origin proxy (`/api/mcp-apps/proxy/...`),
not a direct browser connection — most MCP servers do not enable CORS for browser origins, and
the proxy dodges that. The proxy is **location-transparent**: an app-bearing server configured on
any host in the cluster renders in the web UI, not only servers on the host serving the page. When
the serving host owns the server it fetches upstream directly; when another host owns it, the call
rides the cluster relay to that host, which resolves the upstream URL and attaches any credential at
its own edge. Upstream URLs and auth tokens never reach the browser, and a browser cookie or
`Authorization` header is never forwarded upstream.

For an OAuth-authenticated app server (see [Authenticate with OAuth](#authenticate-with-oauth)),
the owning host attaches its own token when it proxies the call. If no valid grant is held yet, the
proxy returns `401` and the app panel surfaces the pending authorization; resolve it with
`bound login --mcp <server>` and reload the app.

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
