# MCP Subcommand Dispatch Design

## Summary

Currently, bound's MCP bridge generates one sandbox `CommandDefinition` and one LLM `ToolDefinition` per MCP tool — so a server exposing ten tools contributes ten commands (e.g., `github-create_issue`, `github-list_prs`, …). This design collapses that flat list into a two-level hierarchy: one command per connected MCP server, with individual tools becoming subcommands dispatched at runtime. The `github` server becomes a single `CommandDefinition` named `github`; the LLM calls `github` and passes `subcommand="create_issue"` alongside the tool's own parameters. A built-in `--help` path at both the server and subcommand level lets the LLM discover what tools are available without needing the tool list baked into the schema.

The change touches three files. `mcp-bridge.ts` is refactored to produce the server-level commands and a companion `serverNames` registry, while also simplifying `updateHostMCPInfo` to store server names instead of individual tool names. `help.ts` replaces a fragile name-contains-hyphen heuristic with the explicit registry to correctly categorize MCP commands in the `commands` discovery listing. `start.ts` replaces the per-tool `ToolDefinition` loop with a single entry per server whose schema declares only `subcommand` as a required field and opens the rest of the shape with `additionalProperties: true`, leaving argument passing to the existing `--_json` encoding path unchanged.

## Definition of Done

- `generateMCPCommands` produces one `CommandDefinition` per connected MCP server (named after the server), each with an internal dispatcher that routes `args.subcommand` to the right `client.callTool()` call
- In `start.ts`, `mcpToolDefinitions` produces one `ToolDefinition` per server (not per tool), with a schema that includes a `subcommand` field plus the tool's parameters — so the LLM calls `github` instead of `github-create_issue`
- `updateHostMCPInfo` stores server-level names in `mcp_tools` (e.g. `["github"]` not `["github-create_issue", "github-list_prs"]`)
- `resources`, `resource`, `prompts`, `prompt` meta-commands remain unchanged
- Existing tests updated; new tests cover subcommand dispatch and schema generation

## Acceptance Criteria

### mcp-subcommand-dispatch.AC1: One command per server
- **mcp-subcommand-dispatch.AC1.1 Success:** A server with two tools produces one `CommandDefinition` named after the server, not two named `{server}-{tool}`
- **mcp-subcommand-dispatch.AC1.2 Success:** A setup with three servers produces three server-level commands (plus 4 meta-commands)
- **mcp-subcommand-dispatch.AC1.3 Success:** Calling a valid subcommand invokes `client.callTool()` with the correct tool name and args
- **mcp-subcommand-dispatch.AC1.4 Failure:** Calling an unknown subcommand returns exitCode 1 and stderr listing available subcommands
- **mcp-subcommand-dispatch.AC1.5 Edge:** A disconnected server produces no command (existing behaviour preserved)

### mcp-subcommand-dispatch.AC2: `--help` discovery at both levels
- **mcp-subcommand-dispatch.AC2.1 Success:** Handler called with `help: true` and no subcommand returns all subcommand names, descriptions, and required params
- **mcp-subcommand-dispatch.AC2.2 Success:** Handler called with a subcommand and `help: true` returns param table for that subcommand only
- **mcp-subcommand-dispatch.AC2.3 Success:** Handler called with no args returns same output as `--help`
- **mcp-subcommand-dispatch.AC2.4 Edge:** Help output only lists subcommands that passed the `allow_tools` filter

### mcp-subcommand-dispatch.AC3: `allow_tools` and `confirmGates` at dispatch level
- **mcp-subcommand-dispatch.AC3.1 Success:** `allow_tools: ["create_issue"]` — `create_issue` dispatches; invoking any other subcommand returns exitCode 1
- **mcp-subcommand-dispatch.AC3.2 Failure:** A gated subcommand in autonomous mode (`taskId` not starting with `"interactive-"`) returns exitCode 1 with confirmation error
- **mcp-subcommand-dispatch.AC3.3 Success:** A gated subcommand in interactive mode (`taskId: "interactive-xxx"`) dispatches normally

### mcp-subcommand-dispatch.AC4: LLM `ToolDefinition` per server
- **mcp-subcommand-dispatch.AC4.1 Success:** One `ToolDefinition` produced per connected server
- **mcp-subcommand-dispatch.AC4.2 Success:** Schema has `subcommand` as required string with `additionalProperties: true`
- **mcp-subcommand-dispatch.AC4.3 Failure:** No per-tool entries (e.g., `"github-create_issue"`) appear in the tool definitions list

### mcp-subcommand-dispatch.AC5: `updateHostMCPInfo` stores server-level names
- **mcp-subcommand-dispatch.AC5.1 Success:** A server with multiple tools results in one entry in `mcp_tools` (the server name)
- **mcp-subcommand-dispatch.AC5.2 Success:** Two connected servers result in exactly two entries in `mcp_tools`

### mcp-subcommand-dispatch.AC6: `commands` discovery reflects new structure
- **mcp-subcommand-dispatch.AC6.1 Success:** `commands` lists server names (e.g., `github`), not individual tool names
- **mcp-subcommand-dispatch.AC6.2 Success:** `commands github` renders the subcommand listing
- **mcp-subcommand-dispatch.AC6.3 Success:** Remote MCP section parses `mcp_tools` as `string[]` and shows server names

### mcp-subcommand-dispatch.AC7: Meta-commands unchanged
- **mcp-subcommand-dispatch.AC7.1 Success:** `resources`, `resource`, `prompts`, `prompt` remain as top-level commands
- **mcp-subcommand-dispatch.AC7.2 Success:** Existing meta-command tests pass without modification

## Glossary

- **MCP (Model Context Protocol)**: An open protocol for exposing tools, resources, and prompts to LLM-powered agents. Servers implement MCP; clients (like bound's agent) connect and discover capabilities at runtime.
- **MCP server**: A process that exposes a named set of tools, resources, and/or prompts over MCP. Examples in the document: `github`, `notion`.
- **`MCPClient`**: bound's client wrapper around an active MCP connection to a single server. Provides `callTool()`, `listTools()`, and related methods.
- **`CommandDefinition`**: bound's internal interface describing a sandbox command — its name, argument schema, and handler function. Produced by `generateMCPCommands` and consumed by the agent's command executor.
- **`ToolDefinition`**: The JSON schema description of a callable function sent to the LLM. The LLM reads these to know what tools exist and how to invoke them.
- **`generateMCPCommands`**: The function in `mcp-bridge.ts` that converts connected MCP servers into `CommandDefinition` objects the agent loop can execute.
- **`updateHostMCPInfo`**: A function that writes which MCP servers a host provides into the `mcp_tools` database column, used for delegation and routing decisions.
- **`mcp_tools` column**: A database column on the `hosts` table storing a JSON array of MCP capability identifiers for a given host. Used by the relay router to decide which host can handle a tool call.
- **Subcommand dispatch**: The pattern of routing a single named command to one of several sub-operations based on a `subcommand` argument, rather than registering each sub-operation as a top-level command.
- **Dispatch table**: A map built at command-generation time from subcommand names to their metadata (description, input schema), used at runtime to validate and route incoming calls.
- **`allow_tools` filter**: A per-server configuration allowlist that restricts which of a server's tools the agent is permitted to call. Applied when building the dispatch table.
- **`confirmGates`**: A mechanism that marks certain subcommands as requiring interactive confirmation. In autonomous task contexts the call is rejected; in interactive contexts it proceeds.
- **`--_json` encoding**: A convention in the sandbox's command argument handling where structured data with shell metacharacters is passed as a JSON blob under the `--_json` flag rather than as individual shell arguments.
- **`MCPCommandsResult`**: The new return type introduced by this design, carrying both the `CommandDefinition[]` array and a `serverNames: Set<string>` registry.
- **`serverNames` registry**: The `Set<string>` exported alongside the command definitions so that `help.ts` can categorize commands as MCP-sourced without relying on name-pattern heuristics.
- **Relay router**: The component that inspects outgoing tool calls and decides whether to execute locally or forward to a remote host via the relay transport. It uses `mcp_tools` to match tool names to hosts.
- **`taskId` prefix convention**: Autonomous agent tasks have a `taskId` that does not start with `"interactive-"`; interactive sessions do. `confirmGates` uses this prefix to distinguish the two execution contexts.
- **`additionalProperties: true`**: A JSON Schema keyword indicating that an object may contain properties beyond those explicitly declared. Used in the server-level `ToolDefinition` so the LLM can pass tool-specific parameters alongside `subcommand` without schema violations.

## Architecture

`generateMCPCommands` in `packages/agent/src/mcp-bridge.ts` produces one `CommandDefinition` per connected MCP server instead of one per tool. Each command is named after its server (e.g., `github`).

Inside each command's handler, a dispatch table maps subcommand names to their tool metadata (description and input schema), built at command generation time with `allow_tools` filtering applied. The handler inspects incoming args before dispatching:

- `help` flag present, no subcommand → return server-level listing: all subcommand names, descriptions, and required params
- `help` flag present with a subcommand → return param table for that specific subcommand
- Subcommand matches a dispatch table entry → call `client.callTool(subcommand, restArgs)`
- Subcommand missing or unknown → return error listing available subcommands

`confirmGates` applies before `callTool()`: if the subcommand is gated and the context is autonomous (taskId not starting with `"interactive-"`), return an error.

`updateHostMCPInfo` stores server names only — `["github", "notion"]` — eliminating the `listTools()` call it previously made. Since the LLM now calls `github` as the tool name, `toolCommandName` in the relay router is `"github"`, and `["github"].includes("github")` continues to match.

The `commands` command in `packages/agent/src/commands/help.ts` uses an explicit server name registry (a `Set<string>` exported alongside `CommandDefinition[]` from `generateMCPCommands`) instead of the current `name.includes("-")` heuristic. `commands` lists each server as a single entry. `commands github` renders the subcommand table.

The LLM receives one `ToolDefinition` per server with schema `{ subcommand: string (required), additionalProperties: true }` and a description hinting to call with `subcommand="help"` for discovery.

`executeToolCall` in `packages/agent/src/agent-loop.ts` requires no changes — it still builds `github --_json '{"subcommand":"create_issue","title":"foo"}'`.

### Key contracts

`generateMCPCommands` return type extends to carry the server name registry:

```typescript
export interface MCPCommandsResult {
  commands: CommandDefinition[];
  serverNames: Set<string>;  // names of server-level MCP commands
}
```

Server-level `CommandDefinition.args`:

```typescript
args: [
  { name: "subcommand", required: false, description: "Subcommand to run, or 'help' for usage" }
]
```

LLM `ToolDefinition` per server:

```typescript
{
  type: "function",
  function: {
    name: serverName,
    description: `${serverDescription}\n\nCall with subcommand="help" to list available tools and their parameters.`,
    parameters: {
      type: "object",
      properties: {
        subcommand: { type: "string", description: "Tool to invoke. Use \"help\" to list available subcommands." }
      },
      required: ["subcommand"],
      additionalProperties: true
    }
  }
}
```

## Existing Patterns

The `CommandDefinition` interface and `createDefineCommands` factory in `packages/sandbox/src/commands.ts` are the foundation. The `--_json` encoding path (`commands.ts:44-57`) handles structured args with shell metacharacters — this design relies on it unchanged.

The `confirmGates` and `allow_tools` patterns from the current `generateMCPCommands` loop are preserved. Their application point shifts from command-name registration to dispatch-table construction.

`packages/agent/src/commands/help.ts` already supports two-level help (`commands` for listing, `commands <name>` for detail). The subcommand listing reuses this detail path by populating the server command's `args` with subcommand descriptors.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Refactor `mcp-bridge.ts` to server-level commands

**Goal:** Replace per-tool `CommandDefinition` generation with one command per server, implementing `--help` dispatch and updating `updateHostMCPInfo`.

**Components:**
- `packages/agent/src/mcp-bridge.ts` — `generateMCPCommands` refactored; return type changed to `MCPCommandsResult`; each server produces one `CommandDefinition` with internal dispatch table; `--help` at server and subcommand level; `updateHostMCPInfo` simplified to store server names only, removing `listTools()` call
- `packages/agent/src/__tests__/mcp-bridge.test.ts` — existing tests updated; new tests for subcommand dispatch, `--help` at both levels, unknown subcommand error, `allow_tools` filtering in dispatch table, `confirmGates` in dispatch, `updateHostMCPInfo` storing server names

**Dependencies:** None

**Done when:** One command per server produced; `--help` returns subcommand listing; `updateHostMCPInfo` stores `["server-name"]`; tests pass
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Update `commands` discovery and server name registry

**Goal:** Replace the `-` heuristic in `help.ts` with the explicit server name registry; fix the `mcp_tools` remote parsing inconsistency; update listings to show server-level entries.

**Components:**
- `packages/agent/src/commands/help.ts` — MCP categorization uses `serverNames` set from `MCPCommandsResult`; remote `mcp_tools` parsing aligned to `string[]` (fixes existing inconsistency at line 111 where it parses as `Array<{server, name}>`); listings show server-level entries; `commands <serverName>` renders subcommand table
- `packages/agent/src/commands/index.ts` — `setCommandRegistry` updated to accept optional `serverNames: Set<string>`
- `packages/agent/src/__tests__/commands.test.ts` — tests updated for new listing format and registry-based categorization

**Dependencies:** Phase 1

**Done when:** `commands` output shows MCP servers by name; `commands github` shows subcommand listing; remote section parses flat string array; tests pass
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Update LLM `ToolDefinition` generation in `start.ts`

**Goal:** Replace the per-tool `ToolDefinition` loop with one entry per server using the minimal subcommand schema.

**Components:**
- `packages/cli/src/commands/start.ts` — `mcpToolDefinitions` loop replaced with one `ToolDefinition` per connected server using `MCPCommandsResult.serverNames`; schema is `{ subcommand: string (required), additionalProperties: true }`; description defaults to `"${serverName} MCP server tools. Call with subcommand='help' to list available tools."`; second `listTools()` call removed

**Dependencies:** Phase 1, Phase 2

**Done when:** One `ToolDefinition` per server registered; no per-tool entries in LLM tool list; existing integration tests pass
<!-- END_PHASE_3 -->

## Additional Considerations

**`mcp_tools` format inconsistency:** `help.ts` currently parses `mcp_tools` as `Array<{server, name}>` while `updateHostMCPInfo` stores flat strings. Phase 2 fixes both sides to `string[]` of server names, resolving this pre-existing inconsistency.

**Server description sourcing:** `MCPClient` does not currently expose a server info/description method. The `ToolDefinition` description defaults to `"${serverName} MCP server tools"`. A future enhancement could add `MCPClient.getServerInfo()` to pull the MCP server's declared description.
