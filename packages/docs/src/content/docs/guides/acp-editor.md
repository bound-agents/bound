---
title: Connect an ACP editor
description: Optionally connect an ACP-compatible editor to Bound through boundless for agent sessions with editor-managed tools.
---

Boundless can optionally run as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent, letting you use Bound from an ACP-compatible editor. Bound continues to provide inference, memory, and model routing; your editor remains responsible for workspace tools and their permission prompts.

## Prerequisites

Before connecting an editor, make sure you have:

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

## Understand sessions and output

ACP clients create sessions with `session/new` and load sessions with `session/load`. The `--attach` option does not apply to ACP. To resume an existing Bound thread, have the client load it with `session/load`.

Standard output is reserved for ACP JSON-RPC traffic. Boundless writes logs to `~/.bound/less/logs`; fatal startup errors are written to standard error so your editor can report them.

## Troubleshoot connection problems

- **The agent does not start:** Check the editor's reported startup error and the logs in `~/.bound/less/logs`.
- **Boundless cannot reach Bound:** Configure the Bound server URL through the client configuration used by `boundless`.
- **Workspace actions are unavailable:** Review the editor's tool permissions and approve file or shell access when prompted.

For more detail, see [Boundless](/bound/guides/boundless/), [security boundaries](/bound/concepts/security-boundaries/), and [Boundless CLI operations](/bound/guides/cli-operations/#boundless).
