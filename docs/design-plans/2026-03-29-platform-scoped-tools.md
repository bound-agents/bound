# Platform-Scoped Tools Design

## Summary

Today, when the agent responds to a Discord message it produces a reply and the system automatically delivers that reply back to the user. This design replaces that automatic delivery with an explicit tool the agent must call: `discord_send_message`. The agent gains intentional control over whether anything is sent at all — if it never calls the tool, the Discord user sees nothing ("silence"). This is the same model as every other tool in the system: the agent decides when and whether to act.

The implementation is structured to stay clean across the existing package boundaries. Platform connectors (living in `packages/platforms/`) expose their tools through a new optional interface method, `getPlatformTools()`. The agent loop (in `packages/agent/`) receives those tool definitions at construction time and checks them as the highest-priority dispatch path before falling through to the sandbox. No new cross-package dependencies are introduced. When the agent loop runs in a Discord context, a system message is automatically prepended to the conversation explaining the silence semantics, so the LLM understands that the user is invisible to it unless it explicitly sends something.

## Definition of Done

A `discord_send_message` tool implemented in `packages/platforms/` that the agent calls explicitly to send messages to Discord. Calling it delivers immediately (content + optional file attachments loaded from filesystem paths). Multiple calls per turn produce multiple messages. Content > 2000 chars or unreadable attachment paths return an error to the agent without delivering. If the agent never calls it, nothing is delivered to Discord ("silence").

A new optional method on `PlatformConnector` allows connectors to contribute tool definitions and command definitions. The `agentLoopFactory` and `executeProcess()` are extended to merge these platform-specific tools into the agent loop when `ProcessPayload.platform` is non-null.

When running in a Discord context, a system message is injected programmatically explaining the silence semantics. The existing auto-deliver behavior in `executeProcess()` is suppressed for platform contexts — delivery is entirely controlled by `send_message` calls.

## Acceptance Criteria

### platform-scoped-tools.AC1: `discord_send_message` validates and delivers
- **platform-scoped-tools.AC1.1 Success:** Valid content ≤ 2000 chars with no attachments → `deliver()` is called, tool returns `"sent"`
- **platform-scoped-tools.AC1.2 Success:** Valid content + readable attachment path → `deliver()` called with `{ filename, data: Buffer }`, returns `"sent"`
- **platform-scoped-tools.AC1.3 Success:** Multiple `send_message` calls in one turn → each results in a separate `deliver()` invocation, in call order
- **platform-scoped-tools.AC1.4 Failure:** Content > 2000 chars → returns error string, `deliver()` is NOT called
- **platform-scoped-tools.AC1.5 Failure:** At least one attachment path is unreadable/missing → returns error string, `deliver()` is NOT called (no partial delivery)
- **platform-scoped-tools.AC1.6 Edge:** Content exactly 2000 chars → succeeds

### platform-scoped-tools.AC2: `PlatformConnector.getPlatformTools()` interface
- **platform-scoped-tools.AC2.1 Success:** `DiscordConnector.getPlatformTools(threadId)` returns a map containing key `"discord_send_message"` with a valid `toolDefinition` (correct name, description, and parameters schema)
- **platform-scoped-tools.AC2.2 Success:** The `execute` closure in the returned map is bound to the given `threadId`

### platform-scoped-tools.AC3: AgentLoop platform tool dispatch
- **platform-scoped-tools.AC3.1 Success:** Tool call matching a `platformTools` key → `execute()` called, result returned; `sandbox.exec()` is NOT called
- **platform-scoped-tools.AC3.2 Success:** Tool call not in `platformTools` → falls through to existing sandbox dispatch unchanged

### platform-scoped-tools.AC4: `PlatformConnectorRegistry.getConnector()`
- **platform-scoped-tools.AC4.1 Success:** Known platform name → returns registered connector instance
- **platform-scoped-tools.AC4.2 Success:** Unknown platform name → returns `undefined`

### platform-scoped-tools.AC5: System message injection
- **platform-scoped-tools.AC5.1 Success:** `assembleContext()` with `platformContext: { platform: "discord" }` → assembled messages include a `system` entry mentioning `discord_send_message` and the silence/invisibility semantics
- **platform-scoped-tools.AC5.2 Success:** `assembleContext()` without `platformContext` → no platform-specific system message added

### platform-scoped-tools.AC6: End-to-end wiring and auto-deliver suppression
- **platform-scoped-tools.AC6.1 Success:** Discord context, agent calls `send_message` → connector `deliver()` invoked
- **platform-scoped-tools.AC6.2 Success:** Discord context, agent never calls `send_message` → `deliver()` is NOT invoked
- **platform-scoped-tools.AC6.3 Success:** Non-platform context (`platform = null`) → existing auto-deliver behavior is preserved
- **platform-scoped-tools.AC6.4 Success:** `RelayProcessor` without a registry (registry not yet set) → gracefully falls back to no platform tools injected

## Glossary

- **Agent loop**: The central state machine in `packages/agent/` that drives a single conversational turn — assembling context, calling the LLM, executing tool calls, and persisting results.
- **`agentLoopFactory`**: A factory function (wired at startup in `packages/cli/`) that constructs a configured `AgentLoop` instance for a given thread and user. Used by `executeProcess()` to spawn loops for incoming messages.
- **`assembleContext()`**: The 8-stage pipeline inside `packages/agent/` that builds the message array sent to the LLM, including history retrieval, budget trimming, and volatile system message injection.
- **Auto-deliver**: The existing behavior in `executeProcess()` where the agent's final text response is automatically forwarded back to the originating platform after the loop completes, without any explicit tool call.
- **`CommandDefinition`**: The internal framework type used to define agent commands that run in the sandbox. Platform tools bypass this framework entirely and use closures instead.
- **`ContextParams`**: The parameter object passed to `assembleContext()`, carrying configuration that shapes which messages are included and what volatile context is injected.
- **`deliver()`**: The method on `PlatformConnector` that actually sends a message to the external platform (e.g., posts to Discord via the Discord API).
- **`DiscordConnector`**: The platform connector in `packages/platforms/` that handles inbound and outbound Discord messages, interacting with the Discord API.
- **`executeProcess()`**: The method in `RelayProcessor` that handles an incoming `process`-kind relay message by constructing an agent loop and running it to completion.
- **`getPlatformTools()`**: The new optional method being added to `PlatformConnector`. Returns a map of tool name → tool definition + execute closure, bound to a specific thread.
- **`AgentLoopConfig`**: The configuration object passed to the `AgentLoop` constructor, specifying tools, platform context, sandbox, model settings, etc.
- **MCP (Model Context Protocol)**: The protocol used to expose external tool capabilities to the LLM. `ToolDefinition` follows the MCP schema shape for describing tool names, descriptions, and input parameter schemas.
- **`PlatformConnector`**: The interface in `packages/platforms/` that all platform integrations implement. Defines how to receive inbound events and send outbound messages via `deliver()`.
- **`PlatformConnectorRegistry`**: The class in `packages/platforms/` that instantiates connectors from config and routes events to them. Being extended with `getConnector()` to allow lookup by platform name.
- **`platformTools` map**: The `Map<string, { toolDefinition, execute }>` carried on `AgentLoopConfig` at runtime. The agent loop checks this map first in the tool dispatch path.
- **`RelayProcessor`**: The component in `packages/agent/` that consumes messages from the relay inbox and executes them locally — including `process` (delegated loops), `platform_deliver`, `intake`, and `event_broadcast` kinds.
- **Sandbox**: The virtual execution environment in `packages/sandbox/` where the agent's built-in commands run. Platform tools bypass it entirely.
- **Setter injection**: A dependency injection pattern used to wire late-initialized dependencies without constructor cycles. `RelayProcessor` already uses this for `agentLoopFactory`; `setPlatformConnectorRegistry()` follows the same pattern.
- **Silence semantics**: The behavior where, in a platform context, nothing is delivered to the user unless the agent explicitly calls the platform's `send_message` tool. The opposite of auto-deliver.
- **`ToolDefinition`**: The typed schema object describing a tool to the LLM — name, description, and JSON Schema for its input parameters.
- **Volatile context injection**: The pattern in `assembleContext()` where ephemeral `system` messages are prepended to the assembled context for a single turn without being persisted to the database. Used by `relayInfo` today; `platformContext` follows the same pattern.

## Architecture

Platform connectors contribute tool definitions and execution handlers at loop construction time. The `AgentLoopConfig` carries a `platformTools` map and a `platform` field; the agent loop checks this map before falling through to sandbox dispatch. Connectors stay in `packages/platforms/`; the agent loop stays in `packages/agent/` — no new cross-package dependencies are introduced.

**New interface method on `PlatformConnector`:**
```typescript
getPlatformTools?(threadId: string): Map<string, {
  toolDefinition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}>
```
Each value closes over both the connector instance and `threadId`, so execution has everything it needs without ambient state.

**New fields on `AgentLoopConfig`:**
```typescript
platform?: string
platformTools?: Map<string, {
  toolDefinition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}>
```

**New field on `ContextParams`:**
```typescript
platformContext?: { platform: string }
```
When present, `assembleContext()` prepends a `system` message explaining that the user sees only what is sent via `discord_send_message` and that no delivery occurs if the tool is never called.

**Dispatch order in `AgentLoop.executeToolCall()`:**
1. Check `platformTools` map — if match, call `execute()` directly
2. Check `toolCall.name === "bash"` — existing direct path
3. Fall through to `sandbox.exec()` — existing path

**`discord_send_message` tool contract:**
```typescript
// Input schema (what the LLM sees):
{
  content: string;        // required; max 2000 chars
  attachments?: string[]; // optional; absolute filesystem paths
}

// Returns: "sent" on success, or an error string describing the problem
// On error: no message is delivered (atomic — either everything sends or nothing)
```
Validation order: content length check first, then all attachment paths read (fail-fast on first unreadable path). On success, calls `this.deliver(threadId, uuid(), content, loadedFiles)`.

**`PlatformConnector.deliver()` attachment type narrowed:**
```typescript
// Before:
attachments?: unknown[]
// After:
attachments?: Array<{ filename: string; data: Buffer }>
```

**End-to-end flow:**
```
Discord DM received
  → DiscordConnector.onMessage() → relay_outbox (intake, platform: "discord")
  → RelayProcessor.executeProcess():
      connector = registry.getConnector("discord")
      platformTools = connector.getPlatformTools(threadId)
      agentLoopFactory({
        threadId, userId, platform: "discord",
        tools: [sandboxTool, ...platformToolDefs],
        platformTools,
      })
  → AgentLoop.run():
      assembleContext({ ..., platformContext: { platform: "discord" } })
        → injects system message about silence semantics
      LLM sees: bash + discord_send_message
      LLM calls discord_send_message({ content, attachments? })
        → platformTools.get("discord_send_message").execute(input)
        → validate content ≤ 2000 chars, read attachment files
        → DiscordConnector.deliver(threadId, ...) → Discord API
        → returns "sent"
  → executeProcess(): auto-deliver block skipped (platform != null)
```

## Existing Patterns

**`relayInfo` volatile context injection** (`packages/agent/src/context-assembly.ts`): `ContextParams` already carries optional `relayInfo` that injects a volatile `system` message into the assembled context. `platformContext` follows the exact same pattern.

**Setter injection for late-wired dependencies** (`packages/agent/src/relay-processor.ts`): `RelayProcessor.setAgentLoopFactory()` exists precisely because `agentLoopFactory` can't be passed at construction time (circular init order). The `PlatformConnectorRegistry` reference is wired the same way via a new `setPlatformConnectorRegistry()` setter.

**`agentLoopFactory` config merging** (`packages/cli/src/commands/start.ts`): The factory already does `tools: config.tools ?? [sandboxTool]`. Platform tool definitions are appended to this list when `platform` is set.

**`CommandDefinition` handler context** (`packages/agent/src/commands/`): Built-in commands receive `{ db, siteId, eventBus, logger, mcpClients }` via `createDefineCommands()`. Platform tools bypass this entirely — they use closures over the connector instance instead of a shared context object.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Interface contracts
**Goal:** Add new optional fields and methods to shared interfaces across packages. No behavior changes — TypeScript builds cleanly after this phase.

**Components:**
- `packages/platforms/src/connector.ts` — add optional `getPlatformTools()` method; narrow `deliver()` attachment type from `unknown[]` to `Array<{ filename: string; data: Buffer }>`
- `packages/agent/src/types.ts` — add `platform?: string` and `platformTools?` to `AgentLoopConfig`
- `packages/agent/src/context-assembly.ts` — add `platformContext?: { platform: string }` to `ContextParams`

**Dependencies:** None

**Done when:** `bun run typecheck` passes across all packages with no new errors
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: DiscordConnector platform tool implementation
**Goal:** `DiscordConnector` implements `getPlatformTools()`, returning a `discord_send_message` tool with validation and delivery logic. `PlatformConnectorRegistry` exposes `getConnector()`.

**Components:**
- `packages/platforms/src/connectors/discord.ts` — implement `getPlatformTools(threadId)`: creates `discord_send_message` tool definition and `execute` closure; updates `deliver()` to accept typed `{ filename, data }` attachments and call `channel.send({ content, files })`
- `packages/platforms/src/registry.ts` — add `getConnector(platform: string): PlatformConnector | undefined`

**Dependencies:** Phase 1

**Done when:** Unit tests pass covering:
- `platform-scoped-tools.AC1.1` – `execute()` with valid short content calls `deliver()` and returns `"sent"`
- `platform-scoped-tools.AC1.2` – `execute()` with content > 2000 chars returns error string, does not call `deliver()`
- `platform-scoped-tools.AC1.3` – `execute()` with a non-existent attachment path returns error string, does not call `deliver()`
- `platform-scoped-tools.AC1.4` – `execute()` with valid content and readable attachment path calls `deliver()` with `{ filename, data }` and returns `"sent"`
- `platform-scoped-tools.AC2.1` – `getPlatformTools()` returns a map containing `"discord_send_message"` with a valid `toolDefinition`
- `platform-scoped-tools.AC4.1` – `getConnector("discord")` returns the registered connector; `getConnector("unknown")` returns `undefined`
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: AgentLoop dispatch and system prompt injection
**Goal:** `AgentLoop.executeToolCall()` routes platform tool calls before reaching the sandbox. `assembleContext()` injects the silence-semantics system message when `platformContext` is set.

**Components:**
- `packages/agent/src/agent-loop.ts` — in `executeToolCall()`, check `this.config.platformTools?.get(toolCall.name)` before the bash check; if found, call `execute(toolCall.input)` and return the result
- `packages/agent/src/context-assembly.ts` — when `params.platformContext` is present, push a `system` message stating that the user only sees messages sent via `discord_send_message`, and that no delivery occurs if the tool is never called; `AgentLoop.run()` passes `platform` from config through to `assembleContext()`

**Dependencies:** Phase 1

**Done when:** Unit tests pass covering:
- `platform-scoped-tools.AC3.1` – tool call matching a key in `platformTools` invokes `execute()` and returns its result, bypassing `sandbox.exec()`
- `platform-scoped-tools.AC3.2` – tool call not in `platformTools` falls through to sandbox dispatch as before
- `platform-scoped-tools.AC5.1` – `assembleContext()` with `platformContext: { platform: "discord" }` includes a `system` message mentioning `discord_send_message` and silence semantics
- `platform-scoped-tools.AC5.2` – `assembleContext()` without `platformContext` does not include a platform-specific system message
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: RelayProcessor wiring and auto-deliver suppression
**Goal:** `executeProcess()` looks up the active connector, injects platform tools into the loop config, and skips auto-delivery when `payload.platform` is non-null.

**Components:**
- `packages/agent/src/relay-processor.ts` — add `setPlatformConnectorRegistry(registry)` setter (mirrors `setAgentLoopFactory()`); in `executeProcess()`, when `payload.platform` is non-null: call `registry.getConnector(payload.platform)`, call `connector.getPlatformTools(threadId)`, merge tool definitions and `platformTools` map into `AgentLoopConfig`, set `config.platform`; remove the auto-deliver block for the platform-non-null path
- `packages/cli/src/commands/start.ts` — after `relayProcessor.setAgentLoopFactory()`, call `relayProcessor.setPlatformConnectorRegistry(platformRegistry)` when registry is available

**Dependencies:** Phases 2 and 3

**Done when:** Integration tests pass covering:
- `platform-scoped-tools.AC6.1` – agent loop run in a Discord context with `send_message` calls produces delivered messages (connector `deliver()` invoked once per call)
- `platform-scoped-tools.AC6.2` – agent loop run in a Discord context that never calls `send_message` produces no delivery (auto-deliver suppressed)
- `platform-scoped-tools.AC6.3` – agent loop run in a non-platform context (platform = null) retains existing auto-deliver behavior
- `platform-scoped-tools.AC6.4` – multiple `send_message` calls in one agent turn each produce a separate invocation of `deliver()`
<!-- END_PHASE_4 -->

## Additional Considerations

**Extensibility:** Any future platform connector (Telegram, Slack, etc.) can implement `getPlatformTools()` with its own tool names and validation rules. The dispatch and injection machinery is platform-agnostic.

**Delivery timing:** `discord_send_message` delivers immediately when called, mid-turn. If the LLM makes multiple tool calls in one response, each fires in the order they are processed by the agent loop's tool execution loop. This matches the existing serial tool execution order.

**No partial attachment delivery:** If any attachment path fails to read, the entire `send_message` call returns an error with no delivery. This is intentional — partial delivery (some text but missing files) would be confusing to the user and the agent.
