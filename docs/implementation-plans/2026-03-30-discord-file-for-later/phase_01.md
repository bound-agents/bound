# Discord "File for Later" Implementation Plan — Phase 1

**Goal:** Extract the Discord.js client lifecycle from DiscordConnector into a shared DiscordClientManager. Refactor DiscordConnector to accept the shared client. No behavioral change.

**Architecture:** DiscordClientManager owns Client creation (combined intents, partials), login, and destroy. DiscordConnector receives the manager via constructor, registers/removes its own event handlers on the shared client. This separation enables Phase 2's DiscordInteractionConnector to share the same gateway connection.

**Tech Stack:** TypeScript, Discord.js v14 (dynamic import), bun:test

**Scope:** 5 phases from original design (phase 1 of 5)

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### discord-file-for-later.AC5: DiscordClientManager
- **discord-file-for-later.AC5.1 Success:** Client created with combined intents: `DirectMessages`, `DirectMessageReactions`, `MessageContent`, `Guilds`

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create DiscordClientManager class

**Files:**
- Create: `packages/platforms/src/connectors/discord-client-manager.ts`

**Implementation:**

Create the DiscordClientManager that owns Discord.js Client lifecycle. It follows the existing lazy-import pattern from `discord.ts:61` to avoid hard dependency at module load time.

The manager creates the Client with all four intents needed by both connectors (DM + Guild). The `Guilds` intent is new — current DiscordConnector only uses `DirectMessages`, `DirectMessageReactions`, and `MessageContent`. Adding `Guilds` here prepares for Phase 2's interaction connector which needs guild metadata.

```typescript
import type { Logger } from "@bound/shared";

// Discord.js types only — imported dynamically in connect()
type DiscordClient = import("discord.js").Client;

/**
 * Owns the Discord.js Client instance and gateway lifecycle.
 * Shared between DiscordConnector (DMs) and DiscordInteractionConnector (context menus).
 */
export class DiscordClientManager {
	private client: DiscordClient | null = null;

	constructor(private readonly logger: Logger) {}

	/**
	 * Create and log in the Discord.js client with combined intents.
	 * Intents cover both DM handling and guild interaction metadata.
	 * Idempotent — if already connected, logs a warning and returns.
	 */
	async connect(token: string): Promise<void> {
		if (this.client) {
			this.logger.warn("DiscordClientManager: already connected, skipping");
			return;
		}

		const { Client, GatewayIntentBits, Partials } = await import("discord.js");

		this.client = new Client({
			intents: [
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.DirectMessageReactions,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.Guilds,
			],
			partials: [Partials.Channel, Partials.Message, Partials.Reaction],
		});

		await this.client.login(token);
		this.logger.info("Discord client connected");
	}

	/** Destroy the client and release resources. No-op if already disconnected. */
	async disconnect(): Promise<void> {
		if (this.client) {
			this.client.destroy();
			this.client = null;
			this.logger.info("Discord client disconnected");
		}
	}

	/** Returns the live client. Throws if not connected. */
	getClient(): DiscordClient {
		if (!this.client) {
			throw new Error("Discord client not connected");
		}
		return this.client;
	}
}
```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `refactor(platforms): add DiscordClientManager for shared client lifecycle`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Write DiscordClientManager tests

**Verifies:** discord-file-for-later.AC5.1

**Files:**
- Create: `packages/platforms/src/__tests__/discord-client-manager.test.ts`

**Testing:**

Tests must verify:
- discord-file-for-later.AC5.1: Client constructed with all 4 combined intents (`DirectMessages`, `DirectMessageReactions`, `MessageContent`, `Guilds`) and 3 partials (`Channel`, `Message`, `Reaction`)
- `getClient()` throws `"Discord client not connected"` when not connected
- `getClient()` returns the client after `connect()`
- `disconnect()` calls `client.destroy()` and subsequent `getClient()` throws
- `disconnect()` when already disconnected is a no-op (no throw)
- `connect()` when already connected is idempotent (logs warning, does not create second client)

The test must mock `import("discord.js")` to avoid needing a real Discord gateway. Create a mock Client class that captures constructor options (intents, partials) and exposes a `login()` stub that resolves immediately and a `destroy()` stub. Use `jest.mock` or Bun's module mocking to intercept the dynamic import.

If Bun module mocking of dynamic imports is problematic, an alternative approach: test DiscordClientManager by injecting the discord.js module through a factory function. However, the simpler approach is to verify behavior through the public API — call `connect()` with a mocked discord.js, verify `getClient()` returns the client, verify `disconnect()` nulls it.

Follow project testing patterns in:
- `packages/platforms/src/__tests__/discord-connector.test.ts` (mock logger pattern at lines 13-18, database setup at lines 42-65)
- Root `CLAUDE.md` lines 123-131 (testing conventions)

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-client-manager.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): add DiscordClientManager unit tests`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Refactor DiscordConnector to use shared DiscordClientManager

**Files:**
- Modify: `packages/platforms/src/connectors/discord.ts` (514 lines)
- Modify: `packages/platforms/src/registry.ts` (108 lines)

**Implementation:**

Refactor DiscordConnector to receive DiscordClientManager instead of creating its own client. The connector's `connect()` drives the manager lifecycle (calls `clientManager.connect(token)`) — Phase 5 later moves lifecycle control to the registry.

**Note:** Line numbers below reference the current 514-line `discord.ts` as of codebase verification (2026-03-30). If intervening changes shift line numbers, locate the code by pattern (e.g., search for `private client:` rather than relying on "line 40").

**Changes to `packages/platforms/src/connectors/discord.ts`:**

1. **Add import** at top of file:
   ```typescript
   import { DiscordClientManager } from "./discord-client-manager.js";
   ```

2. **Remove private client field** (line 40):
   ```typescript
   // DELETE: private client: DiscordClient | null = null;
   ```

3. **Add named handler references** (replace the deleted line 40 with):
   ```typescript
   private onClientReady: ((client: { user: { tag: string } }) => void) | null = null;
   private onMessageCreate: ((msg: DiscordMessage) => void) | null = null;
   ```

4. **Add clientManager to constructor** — add as 6th parameter after `logger` (lines 47-53):
   ```typescript
   constructor(
       private readonly config: PlatformConnectorConfig,
       private readonly db: Database,
       private readonly siteId: string,
       private readonly eventBus: TypedEventEmitter,
       private readonly logger: Logger,
       private readonly clientManager: DiscordClientManager,
   ) {}
   ```

5. **Rewrite `connect()` method** (lines 55-87):
   ```typescript
   async connect(_hostBaseUrl?: string): Promise<void> {
       const token = this.config.token;
       if (!token) {
           throw new Error("DiscordConnector: token is required in platforms.json connector config");
       }

       // Drive manager lifecycle (Phase 5 moves this to registry level)
       await this.clientManager.connect(token);
       const client = this.clientManager.getClient();

       const { ChannelType } = await import("discord.js");

       this.onClientReady = (c) => {
           this.logger.info("Logged in as Discord bot", { tag: c.user.tag });
       };

       this.onMessageCreate = (msg) => {
           if (msg.author.bot) return;
           if (msg.channel.type !== ChannelType.DM) return;
           this.onMessage(msg).catch((err) => {
               this.logger.error("onMessage error", { error: String(err) });
           });
       };

       client.on("clientReady", this.onClientReady);
       client.on("messageCreate", this.onMessageCreate);
   }
   ```

6. **Rewrite `disconnect()` method** (lines 89-95):
   ```typescript
   async disconnect(): Promise<void> {
       for (const threadId of this.typingTimers.keys()) {
           this.stopTyping(threadId);
       }
       try {
           const client = this.clientManager.getClient();
           if (this.onClientReady) client.off("clientReady", this.onClientReady);
           if (this.onMessageCreate) client.off("messageCreate", this.onMessageCreate);
       } catch {
           // Client already disconnected — handlers already cleaned up by destroy()
       }
       this.onClientReady = null;
       this.onMessageCreate = null;
       // Drive manager lifecycle (Phase 5 moves this to registry level)
       await this.clientManager.disconnect();
   }
   ```

7. **Update `deliver()` method** (lines 97-131) — remove the `this.client` guard at line 103-105. The client is now obtained through `clientManager.getClient()` inside `getDMChannelForThread()`, which throws if not connected.
   ```typescript
   async deliver(
       threadId: string,
       _messageId: string,
       content: string,
       attachments?: Array<{ filename: string; data: Buffer }>,
   ): Promise<void> {
       // No client null check needed — getDMChannelForThread uses clientManager.getClient()
       const channel = await this.getDMChannelForThread(threadId);
       // ... rest unchanged
   ```

8. **Update `getDMChannelForThread()` method** (lines 499-503) — replace `this.client` usage:
   ```typescript
   // Replace the existing this.client check and usage (lines 499-503):
   const client = this.clientManager.getClient();
   const discordUser = await client.users.fetch(discordId);
   return discordUser.createDM();
   ```

**Changes to `packages/platforms/src/registry.ts`:**

9. **Add import** at top:
   ```typescript
   import { DiscordClientManager } from "./connectors/discord-client-manager.js";
   ```

10. **Update `createConnector()` method** (lines 92-107) — create DiscordClientManager and pass to connector:
    ```typescript
    private createConnector(config: PlatformConnectorConfig): PlatformConnector {
        switch (config.platform) {
            case "discord": {
                const clientManager = new DiscordClientManager(this.ctx.logger);
                return new DiscordConnector(
                    config,
                    this.ctx.db,
                    this.ctx.siteId,
                    this.ctx.eventBus,
                    this.ctx.logger,
                    clientManager,
                );
            }
            case "webhook-stub":
                return new WebhookStubConnector();
            default:
                throw new Error(`Unknown platform: ${config.platform}`);
        }
    }
    ```

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `refactor(platforms): DiscordConnector uses shared DiscordClientManager`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update existing tests for new constructor signature

**Files:**
- Modify: `packages/platforms/src/__tests__/discord-connector.test.ts` (1126 lines)
- Modify: `packages/platforms/src/__tests__/discord-attachment.test.ts` (335 lines)

**Implementation:**

The existing tests instantiate DiscordConnector directly with 5 parameters (e.g., line 83: `new DiscordConnector(config, db, "site-1", eventBus, mockLogger)`). Add a mock DiscordClientManager as the 6th parameter.

**In both test files, add a mock factory near the top (after existing mock logger):**

```typescript
import { DiscordClientManager } from "../connectors/discord-client-manager.js";

const createMockClientManager = (): DiscordClientManager => {
    // Tests call onMessage() directly via cast — no real client needed
    return {
        getClient: () => {
            throw new Error("No client in test");
        },
        connect: async () => {},
        disconnect: async () => {},
    } as unknown as DiscordClientManager;
};
```

**Update all DiscordConnector instantiations** — search for `new DiscordConnector(` in both files and add `createMockClientManager()` as the 6th argument:

```typescript
// Before:
const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger);
// After:
const connector = new DiscordConnector(config, db, "site-1", eventBus, mockLogger, createMockClientManager());
```

**For deliver() tests** (discord-connector.test.ts around lines 414-509) that exercise `getDMChannelForThread()`, the mock client manager's `getClient()` must return a mock client with `users.fetch()`. Check the existing deliver test setup — if it uses a mock client injected via `(connector as any).client = mockClient`, update to instead make `createMockClientManager()` return a manager whose `getClient()` returns that mock client:

```typescript
const createMockClientManagerWithClient = (mockClient: unknown): DiscordClientManager => {
    return {
        getClient: () => mockClient,
        connect: async () => {},
        disconnect: async () => {},
    } as unknown as DiscordClientManager;
};
```

No test assertions change — only the setup code that constructs DiscordConnector.

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-connector.test.ts`
Run: `bun test packages/platforms/src/__tests__/discord-attachment.test.ts`
Expected: All existing tests pass with identical assertions

**Commit:** `test(platforms): update Discord tests for DiscordClientManager constructor`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update exports and verify full test suite

**Files:**
- Modify: `packages/platforms/src/index.ts` (5 lines)

**Implementation:**

Add DiscordClientManager to the package exports. Insert after the existing `PlatformConnectorRegistry` export:

```typescript
export type { PlatformConnector } from "./connector.js";
export { PlatformLeaderElection } from "./leader-election.js";
export { PlatformConnectorRegistry } from "./registry.js";
export { DiscordClientManager } from "./connectors/discord-client-manager.js";
export { DiscordConnector } from "./connectors/discord.js";
export { WebhookStubConnector } from "./connectors/webhook-stub.js";
```

**Verification:**
Run: `bun test packages/platforms`
Expected: All platform tests pass (discord-connector, discord-client-manager, discord-attachment, registry, leader-election, intake-pipeline)

Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `refactor(platforms): export DiscordClientManager from platforms package`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->
