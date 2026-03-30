# Discord "File for Later" Context Menu Design

## Summary

This design introduces a Discord "File for Later" context menu command that allows users to save messages for future reference. When a user right-clicks any message and selects "File for Later," the invoking user receives an ephemeral (private) response from the agent -- no one else in the channel sees the bot's interaction. The agent processes the filed message through its standard memorization pipeline, producing a natural language acknowledgment visible only to the filer.

The implementation refactors the existing Discord integration to share a single Discord.js client between two connectors: `DiscordConnector` (existing DM functionality) and `DiscordInteractionConnector` (new context menu interactions). A shared `DiscordClientManager` owns the gateway connection lifecycle. The interaction connector follows the same message pipeline as DMs (user/thread/message creation, intake relay) but uses a dedicated thread interface (`discord-interaction`) and stores interaction tokens in-memory to deliver ephemeral responses. The filing prompt includes metadata about the target message's author, channel, and timestamp, with a trust signal indicating whether the author is a recognized bound user.

## Definition of Done

A "File for Later" message context menu command is registered globally when the Discord bot connects. Right-clicking any message and selecting it triggers an ephemeral-only interaction flow — the invoking user sees the agent's real response, nobody else sees anything.

The interaction reuses the existing message pipeline (user/thread/message creation, intake relay) with threads using `interface = 'discord-interaction'`. The target message author is looked up in the bound users DB and included as a trust signal in the agent prompt.

A `DiscordInteractionConnector` handles interaction delivery (`editReply`) separately from the existing `DiscordConnector` (DMs), both sharing a single Discord.js client via `DiscordClientManager`. `PlatformConnectorRegistry` spawns both connectors from a single `platform: "discord"` config entry.

The allowlist is enforced on the invoking user. Graceful degradation when the interaction token expires (agent response persists in DB, ephemeral delivery skipped with a warning).

## Acceptance Criteria

### discord-file-for-later.AC1: Context menu command registration
- **discord-file-for-later.AC1.1 Success:** On `connect()`, "File for Later" command is registered globally via `client.application.commands.create()` with type `ApplicationCommandType.Message` (3)
- **discord-file-for-later.AC1.2 Success:** Re-connecting does not duplicate the command (idempotent upsert)

### discord-file-for-later.AC2: Interaction handling and ephemeral response
- **discord-file-for-later.AC2.1 Success:** Selecting "File for Later" on a message triggers `deferReply({ ephemeral: true })` as first action
- **discord-file-for-later.AC2.2 Success:** Agent's real response delivered via `editReply`, visible only to the invoking user
- **discord-file-for-later.AC2.3 Failure:** Interaction from non-allowlisted user receives ephemeral error reply, no message/thread/relay created
- **discord-file-for-later.AC2.4 Failure:** Target message with empty content and no image attachments receives `editReply` with `"Error: This message has no extractable content."`, no pipeline invoked
- **discord-file-for-later.AC2.5 Edge:** Non-"File for Later" context menu interactions are ignored

### discord-file-for-later.AC3: Message pipeline reuse
- **discord-file-for-later.AC3.1 Success:** Interaction creates/reuses user record via `findOrCreateUser` with `interaction.user.id`
- **discord-file-for-later.AC3.2 Success:** Interaction creates/reuses thread with `interface = 'discord-interaction'`
- **discord-file-for-later.AC3.3 Success:** User message persisted via `insertRow("messages", ...)` with filing prompt containing target content, author, channel, timestamp
- **discord-file-for-later.AC3.4 Success:** Intake relay written via `writeOutbox` with `platform: "discord-interaction"`, `sync:trigger` emitted

### discord-file-for-later.AC4: Target author trust signal
- **discord-file-for-later.AC4.1 Success:** Target author found in users table includes `(recognized -- bound user "name")` in prompt
- **discord-file-for-later.AC4.2 Success:** Target author not found includes `(unrecognized)` in prompt
- **discord-file-for-later.AC4.3 Edge:** Target message from the bot itself includes `(this bot)` in prompt

### discord-file-for-later.AC5: DiscordClientManager
- **discord-file-for-later.AC5.1 Success:** Client created with combined intents: `DirectMessages`, `DirectMessageReactions`, `MessageContent`, `Guilds`
- **discord-file-for-later.AC5.2 Success:** Both connectors register event handlers on the same client instance
- **discord-file-for-later.AC5.3 Success:** `disconnect()` destroys client and both connectors' handlers are cleaned up

### discord-file-for-later.AC6: Interaction connector deliver()
- **discord-file-for-later.AC6.1 Success:** `deliver()` with valid stored interaction calls `editReply` with content
- **discord-file-for-later.AC6.2 Success:** Content > 2000 chars truncated to 2000 chars before `editReply`
- **discord-file-for-later.AC6.3 Failure:** Interaction token expired or missing logs warning, does not throw

### discord-file-for-later.AC7: Registry integration
- **discord-file-for-later.AC7.1 Success:** Single `{ "platform": "discord" }` config entry creates both `DiscordConnector` and `DiscordInteractionConnector`
- **discord-file-for-later.AC7.2 Success:** `platform:deliver` for thread with `interface = 'discord'` routes to `DiscordConnector.deliver()`
- **discord-file-for-later.AC7.3 Success:** `platform:deliver` for thread with `interface = 'discord-interaction'` routes to `DiscordInteractionConnector.deliver()`
- **discord-file-for-later.AC7.4 Success:** Both connectors share one `PlatformLeaderElection` and connect/disconnect together

### discord-file-for-later.AC8: Response polling
- **discord-file-for-later.AC8.1 Success:** After intake relay, polling finds assistant response on the thread and delivers via `editReply`
- **discord-file-for-later.AC8.2 Failure:** No response within 5 minutes results in `editReply` with timeout error message

## Glossary

- **Context menu command**: A Discord application command that appears when right-clicking a message (as opposed to slash commands typed in the chat input). Type 3 in Discord's API taxonomy.
- **Ephemeral message**: A Discord message visible only to the invoking user -- other users in the channel do not see it.
- **deferReply**: Discord.js method that acknowledges an interaction within the 3-second window, telling Discord the bot is working on a response.
- **editReply**: Discord.js method that updates a deferred interaction's response. Used after the agent loop completes to deliver the final message.
- **Interaction token**: A time-limited token (15 minutes) that Discord provides for responding to an interaction. Expires independently of the bot's connection, making persistent storage impractical.
- **Gateway**: The WebSocket connection between a Discord bot and Discord's API. Receives real-time events like messages and interactions.
- **GatewayIntentBits**: Permissions that control which events a Discord bot receives over the gateway.
- **Platform connector**: Bound's abstraction for third-party integrations (Discord, Slack, etc.). Implements `connect()`, `disconnect()`, and `deliver()` methods.
- **Intake relay**: A relay message kind that routes inbound platform messages to the appropriate host for agent processing. Part of Bound's store-and-forward relay transport.
- **Thread interface**: The `interface` field on Bound's threads table, indicating the originating platform (e.g., `'discord'` for DMs, `'discord-interaction'` for context menu interactions).
- **Leader election**: Bound's mechanism for ensuring exactly one host manages a given platform connection in a multi-host cluster.
- **Discord.js**: The Node.js library used to interact with Discord's API. Provides high-level abstractions over the gateway, REST endpoints, and event handling.
- **MessageContextMenuCommandInteraction**: Discord.js type representing a context menu interaction triggered on a message. Contains metadata about the invoking user and target message.
- **ApplicationCommandType.Message**: Discord API constant (value 3) indicating a context menu command that operates on messages.
- **Trust signal**: The filing prompt's annotation indicating whether the target message author is recognized in Bound's users table, unrecognized, or the bot itself.
- **TTL (Time-To-Live)**: The expiration duration for stored interaction tokens (14 minutes -- slightly shorter than Discord's 15-minute window for safety margin).

## Architecture

The Discord platform integration splits from one connector into two connectors sharing a client. `DiscordClientManager` owns the Discord.js `Client` instance and gateway lifecycle. `DiscordConnector` (existing, refactored) handles DM messages. `DiscordInteractionConnector` (new) handles application command interactions.

Both connectors live in `packages/platforms/src/connectors/`. The registry spawns both from a single `platform: "discord"` config entry and routes `platform:deliver` events to the correct connector based on the thread's `interface` field (`"discord"` vs `"discord-interaction"`).

**Interaction flow:**

```
User right-clicks message → "File for Later"
  → interactionCreate event on shared Discord.js client
  → DiscordInteractionConnector.onInteraction()
    → deferReply({ ephemeral: true })
    → allowlist check on interaction.user
    → validate extractable content (reject empty with error)
    → findOrCreateUser(interaction.user)
    → findOrCreateThread(userId, interface='discord-interaction')
    → look up targetMessage.author in users table → trust signal
    → persist user message with filing prompt + context
    → write intake relay (same as onMessage)
    → store interaction token in ephemeral map (14 min TTL)
    → poll messages table for assistant response (500ms interval, 5 min timeout)
    → editReply with agent's real response (or timeout fallback error)
```

The agent runs a normal loop — memorizes the content, produces a natural language response. The response is delivered via `DiscordInteractionConnector.deliver()` which calls `editReply` on the stored interaction.

**Shared client contract:**

```typescript
class DiscordClientManager {
  private client: DiscordClient | null;

  /** Create and log in the Discord.js client with combined intents. */
  connect(token: string): Promise<void>;

  /** Destroy the client and release resources. */
  disconnect(): Promise<void>;

  /** Returns the live client. Throws if not connected. */
  getClient(): DiscordClient;
}
```

**Interaction token map type:**

```typescript
interface StoredInteraction {
  /** The Discord.js interaction object — needed for editReply. */
  interaction: MessageContextMenuCommandInteraction;
  /** ISO timestamp when this entry expires (14 minutes from creation). */
  expiresAt: string;
}

/** Map from bound thread ID to stored interaction. Pruned lazily on access. */
type InteractionTokenMap = Map<string, StoredInteraction>;
```

**DiscordInteractionConnector contract (implements PlatformConnector):**

```typescript
class DiscordInteractionConnector implements PlatformConnector {
  readonly platform = "discord-interaction";
  readonly delivery = "broadcast";

  constructor(
    config: PlatformConnectorConfig,
    db: Database,
    siteId: string,
    eventBus: TypedEventEmitter,
    logger: Logger,
    clientManager: DiscordClientManager,
  );

  /** Register context menu command + interactionCreate listener on shared client. */
  connect(hostBaseUrl?: string): Promise<void>;

  /** Remove interaction listener. Client lifecycle owned by DiscordClientManager. */
  disconnect(): Promise<void>;

  /** Deliver via editReply on stored interaction. Logs warning if token expired. */
  deliver(threadId: string, messageId: string, content: string): Promise<void>;
}
```

**Filing prompt format (persisted as user message):**

```
File this message for future reference.

From: @DisplayName (recognized — bound user "alice")
Channel: #general in ServerName
Sent: 2026-03-30T14:22:00Z

[original message content]
```

When the target author is not in the users table, the trust signal reads `(unrecognized)` instead. When the target is the bot itself, it reads `(this bot)`.

## Existing Patterns

The filing flow closely follows `DiscordConnector.onMessage()` (`packages/platforms/src/connectors/discord.ts:215-374`): allowlist check → `findOrCreateUser()` → `findOrCreateThread()` → `insertRow("messages", ...)` → `writeOutbox("intake", ...)` → `sync:trigger`. The interaction handler reuses this exact sequence with different inputs (interaction metadata instead of DM message).

Response polling follows the `bound-mcp` pattern in `packages/mcp-server/src/handler.ts:24-43`: poll thread status at 500ms intervals, 5 minute timeout, then read the last assistant message. The interaction connector adapts this to poll the local DB directly (since it's on the same host as the platform leader) rather than going through HTTP.

The two-connector-from-one-config pattern is new. Currently `createConnector()` returns a single `PlatformConnector` per config entry. This design extends the registry to support spawning multiple connectors from one entry, with one shared leader election (since both connectors share a gateway connection and must be on the same host).

Thread `interface` field routing is also new. Currently `platform:deliver` matches on `payload.platform` to find the connector. This design extends the routing to check the thread's `interface` value to select between `"discord"` and `"discord-interaction"` connectors.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: DiscordClientManager & Connector Refactor

**Goal:** Extract the Discord.js client lifecycle from `DiscordConnector` into a shared `DiscordClientManager`. Refactor `DiscordConnector` to accept the shared client. No behavioral change.

**Components:**
- `DiscordClientManager` in `packages/platforms/src/connectors/discord-client-manager.ts` — owns client creation, intent configuration, login/destroy lifecycle
- Refactored `DiscordConnector` in `packages/platforms/src/connectors/discord.ts` — constructor takes `DiscordClientManager` instead of creating its own client. `connect()` registers event handlers on the shared client rather than creating it. `disconnect()` removes handlers but does not destroy the client.

**Dependencies:** None (first phase).

**Done when:** Existing DM functionality (send/receive messages, typing indicators, image attachments) works identically with the shared client. All existing Discord connector tests pass without modification.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: DiscordInteractionConnector Core

**Goal:** New connector that registers the "File for Later" context menu command, handles the `interactionCreate` event, manages the interaction token map, and implements `deliver()` via `editReply`.

**Components:**
- `DiscordInteractionConnector` in `packages/platforms/src/connectors/discord-interaction.ts` — implements `PlatformConnector`, receives shared `DiscordClientManager`
- Context menu command registration via `client.application.commands.create()` (idempotent upsert) in `connect()`
- `interactionCreate` listener with `isMessageContextMenuCommand()` guard
- `deferReply({ ephemeral: true })` as first action in handler
- Interaction token map (`Map<string, StoredInteraction>`) with 14-minute TTL and lazy pruning
- `deliver()` implementation that looks up stored interaction and calls `editReply({ content })`

**Dependencies:** Phase 1 (DiscordClientManager).

**Done when:** Connector registers the context menu command on connect, handles interactions with deferReply, stores interaction tokens with TTL, and editReply works for stored interactions. Token expiry logs a warning without throwing.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Interaction Filing Flow

**Goal:** Full message pipeline from interaction to intake relay — reusing `onMessage` patterns for user/thread/message creation, with interaction-specific additions (target author trust signal, filing prompt, content validation).

**Components:**
- Shared helpers extracted from `DiscordConnector` (or duplicated with `interface` parameter) — `findOrCreateUser()`, `findOrCreateThread()` with configurable `interface` value
- Target message author lookup against users table via `json_extract(platform_ids, '$.discord')` — returns recognized/unrecognized trust signal
- Filing prompt construction (message content + author + channel + guild + timestamp + trust signal)
- Content validation gate — reject interactions where `targetMessage.content` is empty and no image attachments exist, respond with `editReply({ content: "Error: This message has no extractable content." })`
- Allowlist enforcement on `interaction.user.id` against `config.allowed_users`
- Intake relay write via `writeOutbox()` + `sync:trigger` emit

**Dependencies:** Phase 2 (DiscordInteractionConnector core).

**Done when:** Right-clicking a message creates user/thread/message rows with correct `interface = 'discord-interaction'`, includes trust signal in the filing prompt, writes intake relay. Empty messages are rejected with an error. Non-allowlisted users receive an ephemeral unauthorized error.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Response Polling & Delivery

**Goal:** After writing the intake relay, poll the local DB for the agent's response and deliver it via the interaction's ephemeral channel.

**Components:**
- Polling loop in the interaction handler (adapted from `packages/mcp-server/src/handler.ts` pattern) — query messages table for `role = 'assistant'` on the interaction's thread with `created_at` after the filed user message, 500ms interval, 5 minute timeout
- On success: call `deliver(threadId, messageId, content)` which calls `editReply`
- On timeout: call `editReply` with a timeout error message
- Content truncation at Discord's 2000-character limit for editReply

**Dependencies:** Phase 3 (filing flow creates the message and intake relay that triggers the agent loop).

**Done when:** The agent's real response appears as an ephemeral message to the invoking user. Timeout produces a clear error. Long responses are truncated to 2000 chars.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Registry Integration

**Goal:** Wire both connectors through `PlatformConnectorRegistry` from a single `platform: "discord"` config entry.

**Components:**
- Modified `PlatformConnectorRegistry.start()` in `packages/platforms/src/registry.ts` — when `config.platform === "discord"`, creates `DiscordClientManager` + both `DiscordConnector` and `DiscordInteractionConnector`, registers both in the elections map
- Shared leader election — both connectors share one `PlatformLeaderElection` instance (they must be on the same host since they share a gateway connection)
- Modified `platform:deliver` routing — look up thread's `interface` field to select between `"discord"` and `"discord-interaction"` connectors
- `DiscordClientManager` lifecycle tied to leader election (connect when elected, disconnect on demotion)
- Export `DiscordInteractionConnector` and `DiscordClientManager` from `packages/platforms/src/index.ts`

**Dependencies:** Phase 4 (complete interaction connector).

**Done when:** A single `{ "platform": "discord", "token": "..." }` config entry starts both connectors. DM messages route to `DiscordConnector.deliver()`. Interaction-originated messages route to `DiscordInteractionConnector.deliver()`. Leader election governs both connectors together.
<!-- END_PHASE_5 -->

## Additional Considerations

**Interaction token volatility:** The interaction token map is in-memory only. On process restart, all pending interaction tokens are lost. This is acceptable — the agent's response still persists in the database, and the 15-minute interaction window makes persistence impractical. The connector logs a warning when `deliver()` finds an expired or missing token.

**Concurrent interactions:** Multiple "File for Later" interactions from the same user create separate entries in the same `discord-interaction` thread. Each interaction gets its own token map entry (keyed by thread ID — but since they share a thread, the later interaction's token overwrites the earlier one). If this becomes a problem, the map key could be changed to message ID. For the initial implementation, one-at-a-time filing is sufficient.

**Guild intents:** The shared client adds `GatewayIntentBits.Guilds` to the existing intent set. This is needed for `interaction.guild` metadata in the filing prompt. Interactions themselves are received regardless of intents.

**Multi-host timing:** In a multi-host cluster, the interaction handler runs on the platform leader. The intake relay routes through the hub to a spoke that runs the agent loop. The response syncs back. The polling loop reads from the leader's local DB, so it sees the response only after sync completes. This adds latency proportional to the sync interval but stays well within the 15-minute interaction window and the 5-minute poll timeout.
