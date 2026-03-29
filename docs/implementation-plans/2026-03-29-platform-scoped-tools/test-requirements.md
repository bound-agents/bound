# Test Requirements: Platform-Scoped Tools

## Overview

These tests validate the platform-scoped tools feature, which replaces automatic message delivery in platform contexts (e.g., Discord) with an explicit `discord_send_message` tool the agent must call. The feature spans four packages (`shared`, `platforms`, `agent`, `cli`) across four implementation phases: interface contracts, Discord tool implementation, agent loop dispatch/context injection, and relay processor wiring with auto-deliver suppression.

## Automated Tests

### AC1: `discord_send_message` validates and delivers

| Criterion | Test Type | Test File | Test Description |
|-----------|-----------|-----------|-----------------|
| platform-scoped-tools.AC1.1 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | `execute()` with valid content under 2000 chars and no attachments calls `deliver()` once and returns the string `"sent"` |
| platform-scoped-tools.AC1.2 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | `execute()` with valid content and a readable filesystem path calls `deliver()` with an attachments array containing `{ filename, data: Buffer }` where `data` matches the file contents, and returns `"sent"` |
| platform-scoped-tools.AC1.3 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | Two sequential `execute()` calls each invoke `deliver()` separately (deliver spy called exactly twice, once per call, in order) |
| platform-scoped-tools.AC1.4 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | `execute()` with content exceeding 2000 chars returns an error string containing the actual character count, and `deliver()` is never called |
| platform-scoped-tools.AC1.5 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | `execute()` with valid content but a non-existent attachment path returns an error string mentioning the bad path, and `deliver()` is never called (no partial delivery) |
| platform-scoped-tools.AC1.6 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | `execute()` with content exactly 2000 chars long calls `deliver()` and returns `"sent"` |

### AC2: `PlatformConnector.getPlatformTools()` interface

| Criterion | Test Type | Test File | Test Description |
|-----------|-----------|-----------|-----------------|
| platform-scoped-tools.AC2.1 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | `DiscordConnector.getPlatformTools(threadId)` returns a `Map` containing the key `"discord_send_message"` whose `toolDefinition` has `function.name === "discord_send_message"`, a non-empty `function.description`, and a `function.parameters` object with `"content"` in its `required` array |
| platform-scoped-tools.AC2.2 | unit | packages/platforms/src/__tests__/discord-connector.test.ts | The `execute` closure returned by `getPlatformTools(threadId)` passes the provided `threadId` to `deliver()` as its first argument (verified by spy), confirming the closure is bound to the correct thread |

### AC3: AgentLoop platform tool dispatch

| Criterion | Test Type | Test File | Test Description |
|-----------|-----------|-----------|-----------------|
| platform-scoped-tools.AC3.1 | unit | packages/agent/src/__tests__/agent-loop.test.ts | When `AgentLoopConfig.platformTools` contains a key matching the tool call name, the platform tool's `execute()` is invoked and its return value is used as the tool result; `sandbox.exec()` is never called |
| platform-scoped-tools.AC3.2 | unit | packages/agent/src/__tests__/agent-loop.test.ts | When a tool call name does not match any key in `platformTools`, the call falls through to `sandbox.exec()` as before (sandbox spy is invoked) |

### AC4: `PlatformConnectorRegistry.getConnector()`

| Criterion | Test Type | Test File | Test Description |
|-----------|-----------|-----------|-----------------|
| platform-scoped-tools.AC4.1 | unit | packages/platforms/src/__tests__/registry.test.ts | `getConnector("discord")` (or another registered platform name) returns the registered `PlatformConnector` instance |
| platform-scoped-tools.AC4.2 | unit | packages/platforms/src/__tests__/registry.test.ts | `getConnector("nonexistent")` returns `undefined` |

### AC5: System message injection

| Criterion | Test Type | Test File | Test Description |
|-----------|-----------|-----------|-----------------|
| platform-scoped-tools.AC5.1 | unit | packages/agent/src/__tests__/context-assembly.test.ts | `assembleContext()` called with `platformContext: { platform: "discord" }` returns an `LLMMessage[]` that includes a `system`-role message whose content mentions `discord_send_message` and contains silence/invisibility semantics (matches `/sees nothing\|silence\|cannot see/i`) |
| platform-scoped-tools.AC5.2 | unit | packages/agent/src/__tests__/context-assembly.test.ts | `assembleContext()` called without a `platformContext` field returns an `LLMMessage[]` with no system message containing `discord_send_message` |

### AC6: End-to-end wiring and auto-deliver suppression

| Criterion | Test Type | Test File | Test Description |
|-----------|-----------|-----------|-----------------|
| platform-scoped-tools.AC6.1 | integration | packages/agent/src/__tests__/relay-processor.test.ts | `executeProcess()` with `payload.platform = "discord"` and a wired mock registry: the `AgentLoopConfig` passed to `agentLoopFactory` has `platform === "discord"` and `platformTools` is a `Map` containing `"discord_send_message"`; when the mock agent loop simulates calling the platform tool, the connector's `deliver()` is invoked |
| platform-scoped-tools.AC6.2 | integration | packages/agent/src/__tests__/relay-processor.test.ts | `executeProcess()` with `payload.platform = "discord"` where the mock agent loop does NOT call `discord_send_message`: no `platform:deliver` event is emitted on the event bus, and the connector's `deliver()` is never called |
| platform-scoped-tools.AC6.3 | integration | packages/agent/src/__tests__/relay-processor.test.ts | `executeProcess()` with `payload.platform = null`: the auto-deliver block fires normally, emitting a `platform:deliver` event with the last assistant message content when the thread interface is not `"web"` |
| platform-scoped-tools.AC6.4 | integration | packages/agent/src/__tests__/relay-processor.test.ts | `RelayProcessor` without `setPlatformConnectorRegistry()` called, processing a relay with `payload.platform = "discord"`: no crash occurs, the `AgentLoopConfig` passed to `agentLoopFactory` has `platform` and `platformTools` both undefined, and the loop runs to completion |

## Human Verification

| Criterion | Reason not automatable | Verification approach |
|-----------|----------------------|----------------------|
| (none) | All acceptance criteria are fully automatable. | N/A |

## Test Run Commands

```bash
# Run all platform-scoped-tools tests across all affected packages
bun test packages/platforms packages/agent

# Run only the Discord connector tests (AC1, AC2)
bun test packages/platforms/src/__tests__/discord-connector.test.ts

# Run only the registry tests (AC4)
bun test packages/platforms/src/__tests__/registry.test.ts

# Run only the context assembly tests (AC5)
bun test packages/agent/src/__tests__/context-assembly.test.ts

# Run only the agent loop dispatch tests (AC3)
bun test packages/agent/src/__tests__/agent-loop.test.ts

# Run only the relay processor integration tests (AC6)
bun test packages/agent/src/__tests__/relay-processor.test.ts

# Filter by test name patterns for platform-scoped-tools tests specifically
bun test packages/platforms --test-name-pattern "getPlatformTools|getConnector|discord_send_message"
bun test packages/agent --test-name-pattern "platform tool dispatch|platformContext|platform context"

# Full typecheck (verifies Phase 1 interface contracts)
bun run typecheck

# Full recursive test suite (confirms no regressions)
bun test --recursive
```
