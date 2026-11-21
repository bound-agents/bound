---
title: Connect an ACP editor
description: Optionally connect an ACP-compatible editor to Bound through boundless for agent sessions with editor-managed tools.
---

The `boundless` terminal client can run as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent, exposing Bound to an ACP-compatible editor. Bound continues to provide inference, memory, and model routing; the editor remains responsible for workspace tools and their permission prompts.

## Prerequisites

Before connecting an editor, confirm the following are in place:

- A running Bound server.
- The `boundless` command available on your `PATH`.
- An ACP-compatible editor.

## Connect your editor

1. Configure your editor to launch `boundless --acp` as a custom ACP agent.

   For Zed, add the following agent-server configuration:

   ```json
   {
     "agent_servers": {
       "bound": {
         "type": "custom",
         "command": "boundless",
         "args": ["--acp"],
         "env": {}
       }
     }
   }
   ```

2. Start or open the Bound agent from your editor's agent interface.

3. Verify the division of responsibilities: Bound supplies inference, memory, and model routing, while the editor supplies workspace file and shell tools. The editor gates those tools with its own permission prompts.

## Sessions and logs

ACP clients create and resume threads through the editor's session controls rather than the
`--attach` flag. `boundless` writes logs to `~/.bound/less/logs` and reports fatal startup
errors to standard error so your editor can display them.

## Troubleshoot connection problems

- **The agent does not start:** Check the editor's reported startup error and the logs in `~/.bound/less/logs`.
- **`boundless` cannot reach Bound:** Configure the Bound server URL through the client configuration used by `boundless`.
- **Workspace actions are unavailable:** Review the editor's tool permissions and approve file or shell access when prompted.

For more detail, see [Use the `boundless` terminal client](/bound/guides/boundless/), [security boundaries](/bound/concepts/security-boundaries/), and [`boundless` CLI options](/bound/guides/cli-operations/#boundless).
