# Boundless Implementation Plan — Phase 7: TUI Views & App Shell

**Goal:** Compose Phase 6 primitives into the full TUI: chat view with message history and tool execution, MCP configuration view, thread/model pickers, and the root App component with state management and Ctrl-C integration.

**Architecture:** Four React hooks manage async state (session, messages, tool calls, MCP servers). Three views compose primitives. The root `App` component uses `useReducer` for centralized state, `useInput` for Ctrl-C routing, and view routing based on current mode (chat/mcp/picker).

**Tech Stack:** TypeScript, React 18, Ink 5, ink-testing-library, bun:test

**Scope:** 8 phases from original design (phase 7 of 8)

**Codebase verified:** 2026-04-18

---

## Acceptance Criteria Coverage

This phase implements and tests:

### boundless.AC9: TUI Views & Integration
- **boundless.AC9.1 Success:** ChatView renders message history with user/assistant/tool_call/tool_result blocks
- **boundless.AC9.2 Success:** In-flight tool calls render as ToolCallCard with spinner and elapsed time
- **boundless.AC9.3 Success:** `boundless_bash` stdout streams to ToolCallCard in real-time locally
- **boundless.AC9.4 Success:** StatusBar shows thread ID, model name, connection status, MCP server count
- **boundless.AC9.5 Success:** `/model <name>` sets model; `/model` opens picker populated from `client.listModels()`
- **boundless.AC9.6 Success:** `/attach` without arg opens thread picker from `client.listThreads()`; selection triggers transition
- **boundless.AC9.7 Success:** `/mcp` opens configuration view with server list, status badges, add/remove/enable/disable
- **boundless.AC9.8 Success:** Unknown slash command shows inline error
- **boundless.AC9.9 Success:** Non-slash input sends message via `client.sendMessage()` with current model

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: React hooks — useSession, useMessages, useToolCalls, useMcpServers

**Verifies:** boundless.AC9.1 (data layer), boundless.AC9.2 (tracking), boundless.AC9.3 (streaming)

**Files:**
- Create: `packages/less/src/tui/hooks/useSession.ts`
- Create: `packages/less/src/tui/hooks/useMessages.ts`
- Create: `packages/less/src/tui/hooks/useToolCalls.ts`
- Create: `packages/less/src/tui/hooks/useMcpServers.ts`
- Test: `packages/less/src/__tests__/tui-hooks.test.ts`

**Implementation:**

**useSession(url: string)**: Manages BoundClient lifecycle.
- Creates and connects BoundClient on mount, disconnects on unmount
- Tracks connection state: `"connecting" | "connected" | "disconnected"`
- Exposes `client`, `connectionState`, `reconnect()`
- Routes BoundClient events to other hooks via callbacks

**useMessages(client: BoundClient | null, initialMessages: Message[])**: Manages message list.
- State: `Message[]` initialized from attach flow
- Listens to `client.on("message:created", ...)` to append new messages
- Handles pending tool call placeholders (from AC7.2): when a `tool:call` message arrives, replace the placeholder with the actual tool call. When `tool:result` arrives, append it.
- Exposes `messages`, `appendMessage()`, `clearMessages()`

**useToolCalls(client: BoundClient | null, handlers: Map<string, ToolHandler>, hostname: string, cwd: string)**: Manages in-flight tool execution.
- State: `Map<string, { controller: AbortController, toolName: string, startTime: number, stdout?: string }>` for active tool calls
- Listens to `client.on("tool:call", ...)`: creates AbortController, dispatches to handler, sends result via `client.sendToolResult()`
- Listens to `client.on("tool:cancel", ...)`: aborts matching controller (AC3.5 — unknown callIds silently dropped)
- For `boundless_bash`: uses `bashToolWithStreaming()` from Phase 3, passing an `onStdoutChunk` callback that updates the in-flight tool entry's `stdout` field via `setState`. This causes the ToolCallCard to re-render with new stdout content in real-time (AC9.3)
- Exposes `inFlightTools`, `abortAll()`

**useMcpServers(mcpManager: McpServerManager)**: Tracks MCP server state for the McpView.
- State: mirrors `mcpManager.getServerStates()`
- Refreshes on manager changes
- Exposes `serverStates`, `runningCount`

**Testing:**

- Test useMessages: append a message, verify list updated. Replace a pending placeholder, verify replacement.
- Test useToolCalls: simulate tool:call event, verify handler invoked and result sent.

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-hooks.test.ts`
Expected: All tests pass

**Commit:** `feat(less): TUI React hooks for session, messages, tool calls, and MCP state`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Message rendering components — MessageBlock, ToolCallCard, StatusBar

**Verifies:** boundless.AC9.1, boundless.AC9.2, boundless.AC9.3, boundless.AC9.4

**Files:**
- Create: `packages/less/src/tui/components/MessageBlock.tsx`
- Create: `packages/less/src/tui/components/ToolCallCard.tsx`
- Create: `packages/less/src/tui/components/StatusBar.tsx`
- Test: `packages/less/src/__tests__/tui-message-components.test.tsx`

**Implementation:**

**MessageBlock** (AC9.1): Props: `message: Message`. Renders differently based on `message.role`:
- `"user"`: Green "You:" prefix + content text
- `"assistant"`: Blue "Agent:" prefix + content (handle both string and ContentBlock[])
- `"tool_call"`: Dimmed tool invocation with tool name and args summary
- `"tool_result"`: Collapsible output with tool name header
- Pending placeholder: dimmed "Waiting for tool result..." text

**ToolCallCard** (AC9.2, AC9.3): Props: `toolName: string`, `startTime: number`, `stdout?: string`. Renders:
- `<Spinner />` with elapsed time since `startTime`
- `<Badge status="running" />` with tool name
- If `stdout` provided (AC9.3 — bash streaming): `<Collapsible>` with live stdout content, auto-expanded

**StatusBar** (AC9.4): Props: `threadId: string`, `model: string | null`, `connectionState: string`, `mcpServerCount: number`. Renders a bottom bar with: thread ID (truncated), model name, connection status badge, MCP count.

**Testing:**

- boundless.AC9.1: Render MessageBlock with each role type, verify appropriate prefix and content
- boundless.AC9.2: Render ToolCallCard, verify spinner and badge visible
- boundless.AC9.4: Render StatusBar, verify all fields displayed

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-message-components.test.tsx`
Expected: All tests pass

**Commit:** `feat(less): TUI message rendering — MessageBlock, ToolCallCard, StatusBar`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Views — ChatView, McpView, PickerView

**Verifies:** boundless.AC9.5, boundless.AC9.6, boundless.AC9.7, boundless.AC9.8, boundless.AC9.9

**Files:**
- Create: `packages/less/src/tui/views/ChatView.tsx`
- Create: `packages/less/src/tui/views/McpView.tsx`
- Create: `packages/less/src/tui/views/PickerView.tsx`
- Test: `packages/less/src/__tests__/tui-views.test.tsx`

**Implementation:**

**ChatView** (AC9.1, AC9.8, AC9.9): The main view. Composes:
- `<SplitView>` with top=message area, bottom=input area
- Top: `<ScrollRegion>` containing `<MessageBlock>` list + `<ToolCallCard>` for in-flight tools
- Bottom: `<TextInput>` + `<StatusBar>`
- Banner: shown when MCP failures exist or in degraded mode
- **Slash command parsing**: On submit, if input starts with `/`:
  - `/model <name>`: set model directly (AC9.5)
  - `/model`: open picker (AC9.5)
  - `/attach <threadId>`: trigger transition (AC9.6)
  - `/attach`: open picker (AC9.6)
  - `/mcp`: switch to MCP view (AC9.7)
  - `/clear`: create new thread + transition
  - Unknown: show inline error banner "Unknown command: /foo" (AC9.8)
- **Non-slash input** (AC9.9): `client.sendMessage(threadId, input, { model })`. Disable TextInput while agent is active.

**McpView** (AC9.7): Modal overlay for MCP configuration:
- `<ModalOverlay>` wrapping `<SelectList>` of servers with `<Badge>` per item
- `<ActionBar>` with available actions: add (a), remove (d), enable/disable (space), back (esc)
- Add flow: prompt for server name, command/url
- Remove: confirm, then hot-reload
- Enable/disable: toggle `enabled` field, hot-reload
- Hot-reload: calls `mcpManager.reload()`, rebuilds tools, re-sends `session:configure`, persists to `mcp.json`

**PickerView** (AC9.5, AC9.6): Reusable modal for /attach and /model:
- `<ModalOverlay>` wrapping `<SelectList>` with `<ActionBar>`
- For /attach: items from `client.listThreads()`, select triggers `transitionThread()`
- For /model: items from `client.listModels()`, select sets model + re-configures

**Testing:**

- boundless.AC9.8: Render ChatView, submit "/unknown", verify error banner shown
- boundless.AC9.9: Render ChatView, submit "hello", verify sendMessage called

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-views.test.tsx`
Expected: All tests pass

**Commit:** `feat(less): TUI views — ChatView, McpView, PickerView`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: App root component with state management and Ctrl-C

**Verifies:** boundless.AC9.1 (end-to-end rendering)

**Files:**
- Create: `packages/less/src/tui/App.tsx`
- Test: `packages/less/src/__tests__/tui-app.test.tsx`

**Implementation:**

**AppState** (useReducer):
```ts
type AppView = "chat" | "mcp" | "picker";
type PickerMode = "thread" | "model";

interface AppState {
    view: AppView;
    pickerMode?: PickerMode;
    threadId: string;
    model: string | null;
    degraded: boolean;
    bannerMessage: string | null;
    bannerType: "error" | "info" | null;
}
```

**App component** props: `{ client, threadId, configDir, cwd, hostname, mcpManager, mcpConfigs, logger, initialMessages, model }`.

Composes all hooks:
- `useMessages(client, initialMessages)`
- `useToolCalls(client, toolHandlers, hostname, cwd)`
- `useMcpServers(mcpManager)`

Integrates `CancelStateMachine` from Phase 5:
- `useInput` at App level captures all Ctrl-C presses
- Routes to `cancelStateMachine.onCtrlC()`
- Sets `cancelStateMachine.turnActive` based on whether agent is processing
- Sets `cancelStateMachine.modalOpen` based on `state.view !== "chat"`

View routing:
- `"chat"`: `<ChatView />`
- `"mcp"`: `<McpView />`
- `"picker"`: `<PickerView mode={state.pickerMode} />`

**Testing:**

- Render App with mock client and messages, verify ChatView renders with message history

**Verification:**
Run: `bun test packages/less/src/__tests__/tui-app.test.tsx`
Expected: All tests pass

**Commit:** `feat(less): App root component with state management and Ctrl-C routing`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
