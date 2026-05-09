# MCP Platform Connectors Implementation Plan — Phase 2

**Goal:** Reimplement the Discord connector as a standard MCP Server with typed events and tools, connected via InMemoryTransport.

**Architecture:** A `createDiscordServer(config)` factory returns a configured MCP `Server` that: declares event types via custom `events/list` handler, streams events via `events/stream` with cursor-based replay, exposes `discord_send_message` and `discord_respond_interaction` as MCP tools, filters by allowlist, handles attachments inline, and emits `notifications/events/list_changed` when new conversations appear.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk (Server, custom request handlers), discord.js (Client, ChannelType, GatewayIntentBits, Partials — must remain a production dependency since the MCP server uses it at runtime)

**Scope:** 7 phases from original design (phase 2 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-platform-connectors.AC1: Platform events arrive as MCP Events and persist correctly
- **mcp-platform-connectors.AC1.1 Success:** Discord DM received → MCP server emits `notifications/events/event` with correct eventId, name, timestamp, data, cursor
- **mcp-platform-connectors.AC1.4 Success:** Bot's own messages are never emitted as events
- **mcp-platform-connectors.AC1.5 Success:** Messages from non-allowlisted users are never emitted as events
- **mcp-platform-connectors.AC1.6 Success:** Attachments < 1MB included as base64 ContentBlocks in event data
- **mcp-platform-connectors.AC1.7 Success:** Attachments ≥ 1MB stored as file_ref in event data

### mcp-platform-connectors.AC2: Agent uses MCP tools for outbound platform actions
- **mcp-platform-connectors.AC2.1 Success:** `discord_send_message` sends content to correct Discord channel
- **mcp-platform-connectors.AC2.2 Success:** Messages > 2000 chars are chunked at appropriate boundaries
- **mcp-platform-connectors.AC2.3 Success:** Typing indicator starts and stops within `discord_send_message` execution
- **mcp-platform-connectors.AC2.4 Success:** `discord_respond_interaction` edits ephemeral reply for valid callback_id
- **mcp-platform-connectors.AC2.5 Failure:** `discord_respond_interaction` with expired callback_id returns error

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Create Discord MCP Server factory — event type declarations

**Verifies:** mcp-platform-connectors.AC1.1 (partially — events/list response structure)

**Files:**
- Create: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

Create the factory function that returns a configured MCP `Server` with `events/list` handler. The server uses the low-level `Server` class from the MCP SDK (not `McpServer`) since we need custom request handlers for the events extension.

The `events/list` handler declares two event types:
- `message.received` — with input schema `{ channel_id: string }` and payload containing message content + attachments
- `interaction.received` — with input schema `{ channel_id: string }` and payload containing interaction data + callback_id

The server must also implement `tools/list` declaring `discord_send_message` and `discord_respond_interaction`.

Since the MCP Events extension is not built into the SDK, define custom Zod schemas for the request/response types:
- `events/list` request → returns `{ events: EventTypeDescriptor[] }`
- `events/stream` request (params: `{ event: string, params: object }`) → server holds the subscription and pushes `notifications/events/event` notifications
- `events/poll` request (params: `{ cursor: string }`) → returns `{ events: Event[], nextPollSeconds: number }`

The server holds internal state: Discord.js client, active subscriptions (keyed by subscription ID), event buffer for cursor-based replay, interaction store for callback tokens.

Key patterns from existing code to replicate:
- Discord client setup: `GatewayIntentBits.DirectMessages | MessageContent | Guilds`, `Partials.Channel | Message | Reaction`
- Bot-message filter: `if (msg.author.bot) return`
- Allowlist: `config.allowed_users` (empty = allow all)
- Message dedup: track recent message IDs (Set, prune at 100)

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): create Discord MCP server factory with event declarations`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement `events/stream` handler and event emission

**Verifies:** mcp-platform-connectors.AC1.1, mcp-platform-connectors.AC1.4, mcp-platform-connectors.AC1.5

**Files:**
- Modify: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

Add the `events/stream` request handler. When a client subscribes:
1. Validate the event name exists (`message.received` or `interaction.received`)
2. Store the subscription with its filter params (e.g., `channel_id`)
3. If a `cursor` is provided, replay buffered events after that cursor
4. For new events from the Discord gateway, filter by subscription params and emit `notifications/events/event`

The event notification shape:
```typescript
{
  method: "notifications/events/event",
  params: {
    subscriptionId: string,
    eventId: string,       // Discord message ID (unique, idempotent)
    name: string,          // "message.received" or "interaction.received"
    timestamp: string,     // ISO 8601
    data: object,          // Event payload (message content, attachments, metadata)
    cursor: string,        // Monotonic cursor for replay
  }
}
```

Event buffer: maintain a ring buffer of recent events (capped at 1000) with cursors for replay. Cursor is a monotonic counter (not timestamp — simpler and avoids clock skew).

Discord `messageCreate` listener:
1. Skip if `msg.author.bot` (AC1.4)
2. Skip if `msg.channel.type !== ChannelType.DM`
3. Skip if `config.allowed_users.length > 0 && !config.allowed_users.includes(msg.author.id)` (AC1.5)
4. Dedup via message ID set
5. Format event data with content + attachment metadata
6. Push to buffer, emit to matching subscriptions

Also implement `notifications/events/list_changed` emission when a new DM channel is detected (first message from a new user).

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement events/stream and event emission for Discord`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Implement attachment handling in event data

**Verifies:** mcp-platform-connectors.AC1.6, mcp-platform-connectors.AC1.7

**Files:**
- Modify: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

When processing message attachments for event data:

1. Download attachment via `fetch(attachment.url, { signal: AbortSignal.timeout(30_000) })`
2. Check file size against threshold (1 MB = 1,048,576 bytes)
3. For images < 1 MB:
   - Sniff media type from magic bytes (reuse `sniffImageMediaType()` pattern from existing discord.ts)
   - Convert to base64
   - Include as ContentBlock: `{ type: "image", source: { type: "base64", media_type, data } }`
4. For files >= 1 MB:
   - Include as file_ref: `{ type: "file_ref", file_id: attachment.id, filename: attachment.name, size: attachment.size }`
   - The connector handle infrastructure (Phase 3) or event task will handle actual file storage

The event `data` field carries all attachment info so the agent can use tools correctly without Bound needing to understand platform-specific semantics. The data includes:
- `author`: `{ id, username, display_name }`
- `channel_id`: string
- `content`: string (message text)
- `attachments`: ContentBlock[] (base64 images + file_refs)
- `message_id`: string (Discord message ID, for dedup)

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): add attachment handling to Discord event data`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: Implement `discord_send_message` MCP tool

**Verifies:** mcp-platform-connectors.AC2.1, mcp-platform-connectors.AC2.2, mcp-platform-connectors.AC2.3

**Files:**
- Modify: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

Register `discord_send_message` as an MCP tool via `tools/list` and implement its `tools/call` handler.

Tool definition:
```typescript
{
  name: "discord_send_message",
  description: "Send a message to the Discord DM channel bound to this conversation.",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: { type: "string", description: "The Discord channel ID to send to" },
      content: { type: "string", description: "Message content to send (will be chunked if >2000 chars)" },
    },
    required: ["channel_id", "content"],
  },
}
```

Execute handler:
1. Resolve the DMChannel from `channel_id` via `client.channels.fetch(channel_id)`
2. Start typing indicator: `channel.sendTyping()`
3. If content > 2000 characters, chunk at paragraph/sentence/word boundaries (not mid-word):
   - Split on `\n\n` first (paragraph breaks)
   - If a paragraph chunk > 2000, split on `\n` (line breaks)
   - If a line > 2000, split on space (word boundaries)
   - Last resort: hard split at 2000 chars
4. Send each chunk via `channel.send(chunk)` sequentially
5. Return `{ content: [{ type: "text", text: "sent" }] }` on success

Typing behavior: typing indicator is started WITHIN the tool execution (AC2.3) and naturally expires after the message is sent (Discord auto-stops typing on message send).

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement discord_send_message MCP tool`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Implement `discord_respond_interaction` MCP tool

**Verifies:** mcp-platform-connectors.AC2.4, mcp-platform-connectors.AC2.5

**Files:**
- Modify: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

Register `discord_respond_interaction` as an MCP tool and implement its handler.

Tool definition:
```typescript
{
  name: "discord_respond_interaction",
  description: "Respond to a Discord interaction (slash command or context menu) by editing the ephemeral reply.",
  inputSchema: {
    type: "object",
    properties: {
      callback_id: { type: "string", description: "The interaction callback ID from the event data" },
      content: { type: "string", description: "Response content (max 2000 chars, will be truncated)" },
    },
    required: ["callback_id", "content"],
  },
}
```

Execute handler:
1. Look up interaction from internal interaction store (Map keyed by callback_id)
2. If not found: return `{ content: [{ type: "text", text: "Error: interaction not found or expired" }], isError: true }`
3. Check TTL (14 minutes from creation): if expired, return error (AC2.5)
4. Truncate content to 2000 chars
5. Call `interaction.editReply({ content })` (AC2.4)
6. Remove interaction from store
7. Return `{ content: [{ type: "text", text: "sent" }] }`

Interaction store:
- Populated when `interactionCreate` gateway events fire
- Entries: `{ interaction: DiscordInteraction, createdAt: number }`
- TTL: 14 minutes (15 min Discord limit minus 1 min margin)
- Periodic cleanup: remove expired entries every 60 seconds

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement discord_respond_interaction MCP tool`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-7) -->
<!-- START_TASK_6 -->
### Task 6: Implement `events/poll` handler

**Files:**
- Modify: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

Add `events/poll` request handler for poll-mode delivery. This is an alternative to `events/stream` push mode — the connector handle infrastructure (Phase 3) decides which mode to use.

Handler:
1. Accept params: `{ event: string, params: object, cursor?: string }`
2. Look up events in the ring buffer after the given cursor
3. Filter by event name and params (channel_id match)
4. Return: `{ events: Event[], cursor: string, nextPollSeconds: number }`
   - `nextPollSeconds`: 2 (reasonable for real-time messaging)
   - Empty events array if nothing new (no-op for infrastructure)

This provides delivery mode transparency — both push and poll produce identical event shapes.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement events/poll handler for Discord`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Implement interaction event type (`interaction.received`)

**Files:**
- Modify: `packages/platforms/src/connectors/discord-server.ts`

**Implementation:**

Handle Discord `interactionCreate` gateway events:

1. Filter to supported interaction types (context menu, slash commands with allowlist)
2. Defer the interaction with ephemeral flag: `interaction.deferReply({ ephemeral: true })`
3. Store interaction object in the interaction map (keyed by generated callback_id)
4. Format event data:
   ```typescript
   {
     type: "interaction.received",
     callback_id: generatedCallbackId,  // UUID for agent to use with discord_respond_interaction
     interaction_type: "context_menu" | "slash_command",
     user: { id, username, display_name },
     channel_id: interaction.channelId,
     // For context menu: target message content + attachments
     target_message?: { content, author, attachments },
     // For slash commands: command name + options
     command?: { name, options },
   }
   ```
5. Emit to matching subscriptions via `notifications/events/event`
6. Also emit `notifications/events/list_changed` if this is a new channel

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): add interaction.received event type`
<!-- END_TASK_7 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_TASK_8 -->
### Task 8: Unit tests for Discord MCP Server

**Verifies:** mcp-platform-connectors.AC1.1, mcp-platform-connectors.AC1.4, mcp-platform-connectors.AC1.5, mcp-platform-connectors.AC1.6, mcp-platform-connectors.AC1.7, mcp-platform-connectors.AC2.1, mcp-platform-connectors.AC2.2, mcp-platform-connectors.AC2.3, mcp-platform-connectors.AC2.4, mcp-platform-connectors.AC2.5

**Files:**
- Create: `packages/platforms/src/__tests__/discord-server.test.ts`

**Testing:**

Tests connect client and server via InMemoryTransport pair, mock the Discord.js client, and verify:

- **AC1.1**: Subscribe to `message.received` → simulate Discord message → verify notification received with correct eventId, name, timestamp, data, cursor
- **AC1.4**: Simulate message from bot author (`msg.author.bot = true`) → verify NO event emitted
- **AC1.5**: Configure `allowed_users: ["user1"]` → simulate message from "user2" → verify NO event emitted; simulate from "user1" → verify event emitted
- **AC1.6**: Simulate message with attachment (< 1MB PNG) → verify event data contains base64 ContentBlock with correct media_type
- **AC1.7**: Simulate message with attachment (>= 1MB) → verify event data contains file_ref ContentBlock
- **AC2.1**: Call `discord_send_message` tool → verify Discord channel.send() called with correct content
- **AC2.2**: Call `discord_send_message` with 5000-char message → verify chunked into 3 messages, none exceeding 2000 chars
- **AC2.3**: Call `discord_send_message` → verify channel.sendTyping() called before channel.send()
- **AC2.4**: Store mock interaction → call `discord_respond_interaction` with valid callback_id → verify interaction.editReply() called
- **AC2.5**: Store mock interaction with expired timestamp → call `discord_respond_interaction` → verify error returned

Test setup pattern:
- Create server via `createDiscordServer(config)` with mocked Discord client
- Create `InMemoryTransport.createLinkedPair()`
- Connect server and client to their respective transports
- Use client to send requests and receive notifications

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-server.test.ts`
Expected: All tests pass.

**Commit:** `test(platforms): add Discord MCP server unit tests`
<!-- END_TASK_8 -->
