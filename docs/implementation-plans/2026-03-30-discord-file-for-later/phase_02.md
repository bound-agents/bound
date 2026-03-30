# Discord "File for Later" Implementation Plan — Phase 2

**Goal:** Create the DiscordInteractionConnector that registers the "File for Later" context menu command, handles interaction events with ephemeral deferral, manages an interaction token map with TTL, and delivers responses via editReply.

**Architecture:** New connector implements PlatformConnector, receives shared DiscordClientManager from Phase 1. Registers a global Message context menu command on connect. Stores interaction references in an in-memory Map with 14-minute TTL (safety margin under Discord's 15-minute limit). The filing pipeline (Phase 3) and response polling (Phase 4) plug into this connector's interaction handler.

**Tech Stack:** TypeScript, Discord.js v14 (dynamic import), bun:test

**Scope:** 5 phases from original design (phase 2 of 5)

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### discord-file-for-later.AC1: Context menu command registration
- **discord-file-for-later.AC1.1 Success:** On `connect()`, "File for Later" command is registered globally via `client.application.commands.create()` with type `ApplicationCommandType.Message` (3)
- **discord-file-for-later.AC1.2 Success:** Re-connecting does not duplicate the command (idempotent upsert)

### discord-file-for-later.AC2: Interaction handling and ephemeral response
- **discord-file-for-later.AC2.1 Success:** Selecting "File for Later" on a message triggers `deferReply({ ephemeral: true })` as first action
- **discord-file-for-later.AC2.5 Edge:** Non-"File for Later" context menu interactions are ignored

### discord-file-for-later.AC6: Interaction connector deliver()
- **discord-file-for-later.AC6.1 Success:** `deliver()` with valid stored interaction calls `editReply` with content
- **discord-file-for-later.AC6.2 Success:** Content > 2000 chars truncated to 2000 chars before `editReply`
- **discord-file-for-later.AC6.3 Failure:** Interaction token expired or missing logs warning, does not throw

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create DiscordInteractionConnector with command registration and interaction handler

**Files:**
- Create: `packages/platforms/src/connectors/discord-interaction.ts`

**Implementation:**

Create the DiscordInteractionConnector that implements `PlatformConnector` (defined at `packages/platforms/src/connector.ts:11-83`). Follow the type-only import pattern from `discord.ts:16-18`.

Constructor takes the same dependencies as DiscordConnector (Phase 1 refactored version): `config`, `db`, `siteId`, `eventBus`, `logger`, `clientManager`.

```typescript
import type { Database } from "bun:sqlite";
import type { Logger, PlatformConnectorConfig, TypedEventEmitter } from "@bound/shared";
import type { PlatformConnector } from "../connector.js";
import type { DiscordClientManager } from "./discord-client-manager.js";

// Discord.js types — imported dynamically in connect()
type DiscordInteraction = import("discord.js").Interaction;

/** Interaction token expires in 15 min; use 14 min for safety margin. */
const INTERACTION_TTL_MS = 14 * 60 * 1000;

/** Discord's message content limit. */
const DISCORD_MAX_LENGTH = 2000;

interface StoredInteraction {
	/** The Discord.js interaction object — needed for editReply. */
	interaction: { editReply(options: { content: string }): Promise<unknown> };
	/** ISO timestamp when this entry expires. */
	expiresAt: string;
}

export class DiscordInteractionConnector implements PlatformConnector {
	readonly platform = "discord-interaction";
	readonly delivery = "broadcast" as const;

	/** Map from bound thread ID to stored interaction. Pruned lazily on access. */
	private interactions = new Map<string, StoredInteraction>();
	private onInteractionCreate: ((interaction: DiscordInteraction) => void) | null = null;

	constructor(
		private readonly config: PlatformConnectorConfig,
		private readonly db: Database,
		private readonly siteId: string,
		private readonly eventBus: TypedEventEmitter,
		private readonly logger: Logger,
		private readonly clientManager: DiscordClientManager,
	) {}

	async connect(_hostBaseUrl?: string): Promise<void> {
		const client = this.clientManager.getClient();

		// Register "File for Later" context menu command (idempotent upsert — AC1.1, AC1.2)
		if (!client.application) {
			throw new Error("DiscordInteractionConnector: client.application not available");
		}
		await client.application.commands.create({
			name: "File for Later",
			type: 3, // ApplicationCommandType.Message
		});
		this.logger.info("Registered 'File for Later' context menu command");

		// Register interaction listener
		this.onInteractionCreate = (interaction) => {
			this.handleInteraction(interaction).catch((err) => {
				this.logger.error("Interaction handler error", { error: String(err) });
			});
		};
		client.on("interactionCreate", this.onInteractionCreate);
	}

	async disconnect(): Promise<void> {
		try {
			const client = this.clientManager.getClient();
			if (this.onInteractionCreate) {
				client.off("interactionCreate", this.onInteractionCreate);
			}
		} catch {
			// Client already disconnected
		}
		this.onInteractionCreate = null;
		this.interactions.clear();
	}

	/**
	 * Deliver agent response via editReply on the stored interaction.
	 * AC6.1: valid interaction -> editReply
	 * AC6.2: truncate to 2000 chars
	 * AC6.3: expired/missing -> warn, don't throw
	 */
	async deliver(threadId: string, _messageId: string, content: string): Promise<void> {
		const stored = this.interactions.get(threadId);

		if (!stored) {
			this.logger.warn("No stored interaction for thread", { threadId });
			return;
		}

		// Lazy TTL check
		if (new Date(stored.expiresAt) <= new Date()) {
			this.logger.warn("Interaction token expired", { threadId, expiresAt: stored.expiresAt });
			this.interactions.delete(threadId);
			return;
		}

		// AC6.2: truncate to Discord's limit
		const truncated = content.length > DISCORD_MAX_LENGTH
			? content.slice(0, DISCORD_MAX_LENGTH)
			: content;

		try {
			await stored.interaction.editReply({ content: truncated });
		} catch (err) {
			// Discord may reject if token actually expired (race with TTL check)
			this.logger.warn("editReply failed", { threadId, error: String(err) });
		} finally {
			this.interactions.delete(threadId);
		}
	}

	/**
	 * Store an interaction for later delivery via editReply.
	 * Called from the interaction handler after pipeline setup.
	 */
	storeInteraction(
		threadId: string,
		interaction: { editReply(options: { content: string }): Promise<unknown> },
	): void {
		this.interactions.set(threadId, {
			interaction,
			expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString(),
		});
	}

	private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
		// AC2.5: Only handle message context menu commands named "File for Later"
		if (!interaction.isMessageContextMenuCommand()) return;
		if (interaction.commandName !== "File for Later") return;

		// AC2.1: Defer with ephemeral response as first action
		await interaction.deferReply({ ephemeral: true });

		// Phase 3 adds: allowlist check, content validation, filing pipeline
		// Phase 4 adds: response polling and delivery

		this.logger.info("File for Later interaction received", {
			userId: interaction.user.id,
			messageId: interaction.targetMessage.id,
		});
	}
}
```

Key design decisions:
- `storeInteraction()` is public — called by the filing flow (Phase 3) after creating the thread, so the thread ID is known at store time.
- `handleInteraction()` is private — the public entry point is via the `interactionCreate` event listener.
- `deliver()` does lazy TTL pruning — checks expiry on access rather than a background timer.
- The `interactions` Map is cleared on `disconnect()` since all tokens become invalid when the client is destroyed.
- `client.application.commands.create()` is an idempotent upsert (AC1.2) — calling it on reconnect doesn't duplicate the command.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): add DiscordInteractionConnector with command registration and delivery`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Write DiscordInteractionConnector tests

**Verifies:** discord-file-for-later.AC1.1, discord-file-for-later.AC1.2, discord-file-for-later.AC2.1, discord-file-for-later.AC2.5, discord-file-for-later.AC6.1, discord-file-for-later.AC6.2, discord-file-for-later.AC6.3

**Files:**
- Create: `packages/platforms/src/__tests__/discord-interaction.test.ts`

**Testing:**

Tests must verify each AC listed above. The test approach uses a mock DiscordClientManager and mock Discord.js client to avoid needing a real Discord gateway.

**Test setup pattern** (follow `discord-connector.test.ts:42-78`):
- Create real SQLite test database with `applySchema(db)` and randomBytes temp path
- Create mock logger via `createMockLogger()` pattern
- Create mock DiscordClientManager whose `getClient()` returns a mock client object
- Mock client must have:
  - `application.commands.create()` that captures call args (to verify AC1.1)
  - `on()` / `off()` methods that capture registered listeners
  - Ability to fire `interactionCreate` events with mock interaction objects

**AC test cases:**

- **AC1.1**: After `connect()`, verify `client.application.commands.create()` was called with `{ name: "File for Later", type: 3 }`
- **AC1.2**: Call `connect()` twice, verify `commands.create()` was called twice (idempotent upsert — the command is not duplicated because Discord.js handles dedup server-side; test verifies the call happens each time)
- **AC2.1**: Fire a mock `interactionCreate` event with `isMessageContextMenuCommand() = true` and `commandName = "File for Later"`. Verify `deferReply({ ephemeral: true })` was called.
- **AC2.5**: Fire a mock interaction where `isMessageContextMenuCommand()` returns `false`, or where `commandName !== "File for Later"`. Verify `deferReply` was NOT called.
- **AC6.1**: Call `storeInteraction(threadId, mockInteraction)`, then `deliver(threadId, msgId, "response")`. Verify `mockInteraction.editReply({ content: "response" })` was called.
- **AC6.2**: Store interaction, then `deliver()` with a 2500-char string. Verify `editReply` received content truncated to exactly 2000 chars.
- **AC6.3**: Call `deliver()` with a threadId that has no stored interaction. Verify no throw, logger.warn was called. Also test with an expired interaction (set expiresAt to the past).

Follow project testing patterns in:
- `packages/platforms/src/__tests__/discord-connector.test.ts` (mock setup, real DB)
- Root `CLAUDE.md` lines 123-131 (testing conventions)

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-interaction.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): add DiscordInteractionConnector unit tests`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Update exports and verify

**Files:**
- Modify: `packages/platforms/src/index.ts` (6 lines after Phase 1)

**Implementation:**

Add DiscordInteractionConnector to the package exports:

```typescript
export type { PlatformConnector } from "./connector.js";
export { PlatformLeaderElection } from "./leader-election.js";
export { PlatformConnectorRegistry } from "./registry.js";
export { DiscordClientManager } from "./connectors/discord-client-manager.js";
export { DiscordConnector } from "./connectors/discord.js";
export { DiscordInteractionConnector } from "./connectors/discord-interaction.js";
export { WebhookStubConnector } from "./connectors/webhook-stub.js";
```

**Verification:**
Run: `bun test packages/platforms`
Expected: All platform tests pass

Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): export DiscordInteractionConnector`
<!-- END_TASK_3 -->
