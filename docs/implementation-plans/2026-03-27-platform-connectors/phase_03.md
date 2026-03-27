# Platform Connectors Implementation Plan — Phase 3: `platforms` Package

**Goal:** Create the new `packages/platforms/` package with the `PlatformConnector` interface, `PlatformLeaderElection`, `PlatformConnectorRegistry`, `DiscordConnector` (migrated from `packages/discord/`), and `WebhookStubConnector`.

**Architecture:** A new monorepo package `@bound/platforms` is created. It depends on `@bound/core` and `@bound/shared`; `discord.js` is a peer/dev dependency. The `DiscordConnector` replaces the old `DiscordBot`: instead of running its own agent loop it writes an `intake` relay to `relay_outbox`, targeting the hub. The `PlatformLeaderElection` class reads and writes to `cluster_config` (synced table) to determine which host should hold the platform connection. The `PlatformConnectorRegistry` wires connectors to the eventBus at startup.

**Tech Stack:** TypeScript, bun:sqlite, discord.js v14.25.1, existing `insertRow`/`updateRow`/`writeOutbox` helpers from `@bound/core`

**Scope:** Phase 3 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Acceptance Criteria Coverage

### platform-connectors.AC5: platforms package — leader election and registry
- **platform-connectors.AC5.1 Success:** `PlatformLeaderElection` claims leadership when `cluster_config` has no leader
- **platform-connectors.AC5.2 Success:** `PlatformLeaderElection` enters standby when another host is already leader
- **platform-connectors.AC5.3 Success:** Standby host promotes itself when leader `hosts.modified_at` exceeds `failover_threshold_ms`
- **platform-connectors.AC5.4 Success:** Leader writes heartbeat to `hosts.modified_at` every `failover_threshold_ms / 3`
- **platform-connectors.AC5.5 Success:** `PlatformConnectorRegistry` routes `"platform:deliver"` to correct connector by platform name
- **platform-connectors.AC5.6 Success:** `WebhookStubConnector` has `delivery = "exclusive"`
- **platform-connectors.AC5.7 Success:** `WebhookStubConnector.deliver()` throws

### platform-connectors.AC6: Discord connector migrated
- **platform-connectors.AC6.1 Success:** `DiscordConnector.onMessage()` writes `intake` relay to outbox (no direct agent loop)
- **platform-connectors.AC6.2 Success:** `DiscordConnector.onMessage()` persists user message via `insertRow`
- **platform-connectors.AC6.3 Success:** `DiscordConnector.deliver()` sends message content to correct Discord channel
- **platform-connectors.AC6.4 Success:** `DiscordConnector` has no hostname check (`shouldActivate` removed)
- **platform-connectors.AC6.5 Success:** `DiscordConnector` reads `allowed_users` from `platforms.json` connector config

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Create package scaffold

**Verifies:** None — infrastructure setup

**Files:**
- Create: `packages/platforms/package.json`
- Create: `packages/platforms/tsconfig.json`
- Create: `packages/platforms/src/index.ts`

**Implementation:**

Create the directory structure first:

```bash
mkdir -p packages/platforms/src/connectors
mkdir -p packages/platforms/src/__tests__
```

**`packages/platforms/package.json`:**

```json
{
  "name": "@bound/platforms",
  "version": "0.0.1",
  "description": "Platform connector framework for @bound — leader election, intake pipeline, Discord connector",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/core": "workspace:*",
    "@bound/shared": "workspace:*"
  },
  "devDependencies": {
    "discord.js": "^14.0.0"
  },
  "peerDependencies": {
    "discord.js": "^14.0.0"
  },
  "peerDependenciesMeta": {
    "discord.js": {
      "optional": true
    }
  }
}
```

**`packages/platforms/tsconfig.json`:**

Check an existing package's tsconfig (e.g., `packages/discord/tsconfig.json`) and copy the same `extends` path and structure. It should look similar to:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src"]
}
```

If `tsconfig.base.json` does not exist at the repo root, check what `packages/discord/tsconfig.json` actually extends and use the same path.

**`packages/platforms/src/index.ts`:**

```typescript
export type { PlatformConnector } from "./connector.js";
export { PlatformLeaderElection } from "./leader-election.js";
export { PlatformConnectorRegistry } from "./registry.js";
export { DiscordConnector } from "./connectors/discord.js";
export { WebhookStubConnector } from "./connectors/webhook-stub.js";
```

**Verification:**

Run: `tsc -p packages/platforms --noEmit`
Expected: Compiles (may have module-not-found errors until later tasks create the files — that is expected at this stage).

Run: `bun install` from repo root to register the new workspace package.

**Commit:** `chore: scaffold @bound/platforms package`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: PlatformConnector interface + WebhookStubConnector

**Verifies:** platform-connectors.AC5.6, AC5.7

**Files:**
- Create: `packages/platforms/src/connector.ts`
- Create: `packages/platforms/src/connectors/webhook-stub.ts`

**Implementation:**

**`packages/platforms/src/connector.ts`:**

```typescript
/**
 * A PlatformConnector integrates one external messaging platform (Discord, Slack, Telegram, etc.)
 * with the bound relay pipeline.
 *
 * Broadcast connectors (Discord) maintain a persistent gateway connection; only the elected
 * leader connects. Exclusive-delivery connectors (Telegram, Slack Events API) receive events
 * via webhook HTTP POST and re-register their URL on leader failover.
 */
export interface PlatformConnector {
  /** Platform identifier, e.g. "discord", "slack", "telegram". Must be unique per registry. */
  readonly platform: string;

  /**
   * Delivery model:
   * - "broadcast": connector maintains a persistent connection (gateway/websocket).
   *   Only the elected leader connects.
   * - "exclusive": connector receives events via HTTP webhook.
   *   On failover the new leader re-registers its own URL.
   */
  readonly delivery: "broadcast" | "exclusive";

  /**
   * Establish the platform connection.
   * For broadcast connectors: open the gateway websocket.
   * For exclusive-delivery connectors: register the webhook URL at the platform.
   *
   * @param hostBaseUrl - Base URL of this host (e.g. "https://host.example.com").
   *   Used by exclusive-delivery connectors to register the webhook URL.
   *   Broadcast connectors may ignore this parameter.
   */
  connect(hostBaseUrl?: string): Promise<void>;

  /** Tear down the platform connection. */
  disconnect(): Promise<void>;

  /**
   * Send a response message to the platform.
   *
   * @param threadId  - Internal thread ID (used to look up the platform channel/user).
   * @param messageId - Internal message ID of the assistant response.
   * @param content   - Text content to send. May need chunking per platform limits.
   * @param attachments - Optional attachments (platform-specific format).
   */
  deliver(
    threadId: string,
    messageId: string,
    content: string,
    attachments?: unknown[],
  ): Promise<void>;

  /**
   * Handle an inbound webhook payload from the platform.
   * Only exclusive-delivery connectors implement this method.
   *
   * @param rawBody - Raw HTTP request body (string).
   * @param headers - HTTP request headers (for signature verification).
   */
  handleWebhookPayload?(rawBody: string, headers: Record<string, string>): Promise<void>;
}
```

**`packages/platforms/src/connectors/webhook-stub.ts`:**

```typescript
import type { PlatformConnector } from "../connector.js";

/**
 * Stub connector that validates the exclusive-delivery contract.
 * Exists solely to test that PlatformLeaderElection and PlatformConnectorRegistry
 * correctly handle exclusive-delivery connectors (webhook URL rotation on leader promotion).
 *
 * @remarks DELETE when first real exclusive-delivery connector (Slack, Telegram, etc.) ships.
 * @see docs/design-plans/2026-03-27-platform-connectors.md
 */
export class WebhookStubConnector implements PlatformConnector {
  readonly platform = "webhook-stub";
  readonly delivery = "exclusive" as const;

  async connect(_hostBaseUrl?: string): Promise<void> {
    // no-op — stub only
  }

  async disconnect(): Promise<void> {
    // no-op — stub only
  }

  async deliver(
    _threadId: string,
    _messageId: string,
    _content: string,
    _attachments?: unknown[],
  ): Promise<void> {
    throw new Error("not implemented — stub only");
  }

  async handleWebhookPayload(
    _rawBody: string,
    _headers: Record<string, string>,
  ): Promise<void> {
    // no-op — stub only
  }
}
```

**Verification:**

Run: `tsc -p packages/platforms --noEmit`
Expected: No errors in connector.ts or webhook-stub.ts.

**Commit:** `feat: add PlatformConnector interface and WebhookStubConnector`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: PlatformLeaderElection

**Verifies:** platform-connectors.AC5.1, AC5.2, AC5.3, AC5.4

**Files:**
- Create: `packages/platforms/src/leader-election.ts`

**Implementation:**

Before writing the class, verify the `cluster_config` table schema:

```bash
# From a quick test or the REPL:
db.query("PRAGMA table_info(cluster_config)").all()
```

The table has columns: `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`, `modified_at TEXT NOT NULL`. There is no `deleted` column. The hub's site ID is stored at `key = 'cluster_hub'`. For leader election, the key is `platform_leader:{platform}` (e.g., `platform_leader:discord`).

**`packages/platforms/src/leader-election.ts`:**

```typescript
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { PlatformConnectorConfig } from "@bound/shared";
import type { PlatformConnector } from "./connector.js";

/**
 * Manages which host is the active connector leader for one platform.
 *
 * On start():
 *   - If no leader exists in cluster_config, this host claims leadership (LWW race).
 *   - If this host is already leader, it reclaims (idempotent).
 *   - If another host is leader, enter standby and poll for staleness.
 *
 * Heartbeat: leader bumps hosts.modified_at every failover_threshold_ms / 3.
 * Failover: standby promotes if leader's modified_at is older than failover_threshold_ms.
 */
export class PlatformLeaderElection {
  private isLeaderFlag = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly connector: PlatformConnector,
    private readonly config: PlatformConnectorConfig,
    private readonly db: Database,
    private readonly siteId: string,
    private readonly hostBaseUrl?: string,
  ) {}

  async start(): Promise<void> {
    const leaderKey = `platform_leader:${this.connector.platform}`;
    const existing = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM cluster_config WHERE key = ? LIMIT 1",
      )
      .get(leaderKey);

    if (!existing || existing.value === this.siteId) {
      await this.claimLeadership(leaderKey);
    } else {
      this.startStalenessCheck(leaderKey);
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.stalenessTimer) {
      clearInterval(this.stalenessTimer);
      this.stalenessTimer = null;
    }
    if (this.isLeaderFlag) {
      this.connector.disconnect().catch(() => {
        // Disconnect errors are non-fatal during shutdown
      });
    }
    this.isLeaderFlag = false;
  }

  isLeader(): boolean {
    return this.isLeaderFlag;
  }

  private async claimLeadership(leaderKey: string): Promise<void> {
    const now = new Date().toISOString();

    // Write self as leader using INSERT OR REPLACE + manual change_log entry.
    // cluster_config uses `key` as its PK (not `id`), so insertRow/updateRow cannot be used.
    // Follow the pattern from packages/cli/src/commands/set-hub.ts.
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO cluster_config (key, value, modified_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at`,
        [leaderKey, this.siteId, now],
      );
      // Insert change_log entry to propagate the leadership claim via sync.
      // change_log columns: table_name, row_id, site_id, timestamp, row_data
      this.db.run(
        `INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
         VALUES ('cluster_config', ?, ?, ?, ?)`,
        [
          leaderKey,
          this.siteId,
          now,
          JSON.stringify({ key: leaderKey, value: this.siteId, modified_at: now }),
        ],
      );
    })();

    this.isLeaderFlag = true;
    await this.connector.connect(this.hostBaseUrl);

    // Heartbeat: bump hosts.modified_at every failover_threshold_ms / 3.
    // The hosts table PK is site_id (not id), so updateRow() cannot be used.
    // Use manual SQL + change_log entry following the same pattern as claimLeadership().
    const heartbeatInterval = Math.floor(this.config.failover_threshold_ms / 3);
    this.heartbeatTimer = setInterval(() => {
      try {
        const ts = new Date().toISOString();
        this.db.transaction(() => {
          this.db.run(
            "UPDATE hosts SET modified_at = ? WHERE site_id = ?",
            [ts, this.siteId],
          );
          this.db.run(
            `INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
             VALUES ('hosts', ?, ?, ?, ?)`,
            [this.siteId, this.siteId, ts, JSON.stringify({ site_id: this.siteId, modified_at: ts })],
          );
        })();
      } catch {
        // DB write failure is non-fatal — next heartbeat will retry
      }
    }, heartbeatInterval);
  }

  private startStalenessCheck(leaderKey: string): void {
    this.isLeaderFlag = false;
    const checkInterval = Math.floor(this.config.failover_threshold_ms / 3);

    this.stalenessTimer = setInterval(async () => {
      // Read current leader's modified_at from hosts table
      const row = this.db
        .query<{ modified_at: string }, [string]>(
          `SELECT h.modified_at
           FROM cluster_config cc
           JOIN hosts h ON h.site_id = cc.value
           WHERE cc.key = ? AND h.deleted = 0
           LIMIT 1`,
        )
        .get(leaderKey);

      if (!row) {
        // Leader host record gone — take over
        clearInterval(this.stalenessTimer!);
        this.stalenessTimer = null;
        await this.claimLeadership(leaderKey);
        return;
      }

      const leaderAgeMs = Date.now() - new Date(row.modified_at).getTime();
      if (leaderAgeMs > this.config.failover_threshold_ms) {
        clearInterval(this.stalenessTimer!);
        this.stalenessTimer = null;
        await this.claimLeadership(leaderKey);
      }
    }, checkInterval);
  }
}
```

**Verification:**

Run: `tsc -p packages/platforms --noEmit`
Expected: No errors in leader-election.ts.

**Commit:** `feat: add PlatformLeaderElection with heartbeat and standby failover`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: PlatformConnectorRegistry

**Verifies:** platform-connectors.AC5.5

**Files:**
- Create: `packages/platforms/src/registry.ts`

**Implementation:**

**`packages/platforms/src/registry.ts`:**

```typescript
import type { PlatformConnectorConfig, PlatformsConfig, TypedEventEmitter } from "@bound/shared";
import type { AppContext } from "@bound/core";
import { PlatformLeaderElection } from "./leader-election.js";
import type { PlatformConnector } from "./connector.js";
import { DiscordConnector } from "./connectors/discord.js";
import { WebhookStubConnector } from "./connectors/webhook-stub.js";

/**
 * Instantiates all configured platform connectors, starts their leader elections,
 * and routes "platform:deliver" and "platform:webhook" eventBus events to the
 * correct connector.
 *
 * Usage:
 *   const registry = new PlatformConnectorRegistry(ctx, platformsConfig);
 *   registry.start();
 *   // ... on shutdown:
 *   registry.stop();
 */
export class PlatformConnectorRegistry {
  private elections = new Map<string, PlatformLeaderElection>();

  constructor(
    private readonly ctx: AppContext,
    private readonly platformsConfig: PlatformsConfig,
    private readonly hostBaseUrl?: string,
  ) {}

  start(): void {
    for (const connectorConfig of this.platformsConfig.connectors) {
      const connector = this.createConnector(connectorConfig);
      const election = new PlatformLeaderElection(
        connector,
        connectorConfig,
        this.ctx.db,
        this.ctx.siteId,
        this.hostBaseUrl,
      );
      this.elections.set(connectorConfig.platform, election);
      election.start().catch((err) => {
        this.ctx.logger.error(
          "platforms",
          `Leader election failed to start for ${connectorConfig.platform}: ${String(err)}`,
        );
      });
    }

    // Route platform:deliver to the correct connector (leader only)
    this.ctx.eventBus.on("platform:deliver", (payload) => {
      const election = this.elections.get(payload.platform);
      if (!election?.isLeader()) return;
      election.connector
        .deliver(payload.thread_id, payload.message_id, payload.content, payload.attachments)
        .catch((err) => {
          this.ctx.logger.error(
            "platforms",
            `Deliver failed for ${payload.platform}: ${String(err)}`,
          );
        });
    });

    // Route platform:webhook to the correct connector (leader only)
    this.ctx.eventBus.on("platform:webhook", (payload) => {
      const election = this.elections.get(payload.platform);
      if (!election?.isLeader()) return;
      election.connector.handleWebhookPayload?.(payload.rawBody, payload.headers).catch((err) => {
        this.ctx.logger.error(
          "platforms",
          `Webhook handling failed for ${payload.platform}: ${String(err)}`,
        );
      });
    });
  }

  stop(): void {
    for (const election of this.elections.values()) {
      election.stop();
    }
    this.elections.clear();
  }

  private createConnector(config: PlatformConnectorConfig): PlatformConnector {
    switch (config.platform) {
      case "discord":
        return new DiscordConnector(
          config,
          this.ctx.db,
          this.ctx.siteId,
          this.ctx.eventBus,
          this.ctx.logger,
        );
      case "webhook-stub":
        return new WebhookStubConnector();
      default:
        throw new Error(`Unknown platform: ${config.platform}`);
    }
  }
}
```

**Note on `AppContext` import:** `AppContext` is exported from `@bound/core`. Check the export with `grep -n "export.*AppContext" packages/core/src/` to find the exact module.

**Note on `start()` and fire-and-forget:** `start()` launches leader elections asynchronously via `.catch()` callbacks. Callers receive control back immediately — connectors are not yet connected when `start()` returns. This is intentional: leader election involves DB reads and potentially long `connect()` calls (network login). Errors are logged but do not prevent the registry from starting other connectors.

**Note on `cluster_config` primary key:** The `cluster_config` table uses `key TEXT PRIMARY KEY`, not `id`. Existing codebase code that writes to this table (e.g., `packages/cli/src/commands/set-hub.ts`, `stop-resume.ts`) uses manual SQL rather than `insertRow`/`updateRow` because `insertRow` expects a column named `id`. Verify `insertRow`'s implementation handles this, or fall back to: `db.run("INSERT OR REPLACE INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)", [leaderKey, siteId, now])` followed by a manual change_log insert. Check how `set-hub.ts` writes to cluster_config and replicate that pattern.

**Verification:**

Run: `tsc -p packages/platforms --noEmit`
Expected: No errors in registry.ts.

**Commit:** `feat: add PlatformConnectorRegistry with eventBus dispatch and leader-aware routing`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->

<!-- START_TASK_5 -->
### Task 5: DiscordConnector

**Verifies:** platform-connectors.AC6.1, AC6.2, AC6.3, AC6.4, AC6.5

**Files:**
- Create: `packages/platforms/src/connectors/discord.ts`

**Implementation:**

Key behavioral changes from the old `DiscordBot`:

| Old `DiscordBot` | New `DiscordConnector` |
|---|---|
| Calls `agentLoopFactory()` on message | Writes `intake` relay to `relay_outbox` |
| Uses `shouldActivate()` hostname check | Leader election handles this — no hostname check |
| Reads Discord user allowlist from `discord_id` DB column | Reads `allowed_users` from `PlatformConnectorConfig` |
| `start()` / `stop()` | `connect()` / `disconnect()` (PlatformConnector interface) |
| Depends on `@bound/agent` | Only depends on `@bound/core`, `@bound/shared`, `discord.js` |

**`packages/platforms/src/connectors/discord.ts`:**

```typescript
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { insertRow, writeOutbox } from "@bound/core";
import type {
  PlatformConnectorConfig,
  TypedEventEmitter,
  Logger,
  IntakePayload,
  ProcessPayload,
  Thread,
  User,
} from "@bound/shared";
import type { PlatformConnector } from "../connector.js";

// Discord.js types only — imported dynamically in connect() to avoid hard dep at module load
type DiscordClient = import("discord.js").Client;
type DiscordMessage = import("discord.js").Message;

/**
 * Platform connector for Discord DM-based conversations.
 *
 * On message receipt: persists the user + message via insertRow(), then writes
 * an `intake` relay to relay_outbox targeting the hub. The relay processor on
 * the hub routes it to the appropriate host via the intake pipeline.
 *
 * On deliver: looks up the Discord user ID from the thread's user.platform_ids,
 * opens a DM channel, and sends the content chunked at 2000 characters.
 */
export class DiscordConnector implements PlatformConnector {
  readonly platform = "discord";
  readonly delivery = "broadcast" as const;

  private client: DiscordClient | null = null;

  constructor(
    private readonly config: PlatformConnectorConfig,
    private readonly db: Database,
    private readonly siteId: string,
    private readonly eventBus: TypedEventEmitter,
    private readonly logger: Logger,
  ) {}

  async connect(_hostBaseUrl?: string): Promise<void> {
    const token = this.config.token;
    if (!token) {
      throw new Error("DiscordConnector: token is required in platforms.json connector config");
    }

    const { Client, GatewayIntentBits, Partials, ChannelType } = await import("discord.js");

    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.client.on("ready", (client) => {
      this.logger.info("discord", `Logged in as ${client.user.tag}`);
    });

    this.client.on("messageCreate", (msg) => {
      // Filter: only handle non-bot DM messages
      if (msg.author.bot) return;
      if (msg.channel.type !== ChannelType.DM) return;

      this.onMessage(msg).catch((err) => {
        this.logger.error("discord", `onMessage error: ${String(err)}`);
      });
    });

    await this.client.login(token);
  }

  async disconnect(): Promise<void> {
    this.client?.destroy();
    this.client = null;
  }

  async deliver(
    threadId: string,
    _messageId: string,
    content: string,
    _attachments?: unknown[],
  ): Promise<void> {
    if (!this.client) {
      throw new Error("DiscordConnector: not connected");
    }

    const channel = await this.getDMChannelForThread(threadId);
    if (!channel) {
      this.logger.warn("discord", `No DM channel found for thread ${threadId}`);
      return;
    }

    // Chunk content at Discord's 2000-character limit (AC6.3)
    for (let i = 0; i < content.length; i += 2000) {
      await channel.send(content.slice(i, i + 2000));
    }
  }

  private async onMessage(msg: DiscordMessage): Promise<void> {
    // Allowlist check — reads allowed_users from platforms.json config (AC6.5)
    if (this.config.allowed_users.length > 0 && !this.config.allowed_users.includes(msg.author.id)) {
      return; // Silently reject non-allowlisted users
    }

    // Find or create the bound user record (using platform_ids JSON)
    const user = this.findOrCreateUser(msg.author.id, msg.author.displayName ?? msg.author.username);

    // Find or create the thread for this user
    const thread = this.findOrCreateThread(user.id);

    // Persist the incoming message via insertRow (AC6.2)
    const messageId = randomUUID();
    const now = new Date().toISOString();
    insertRow(
      this.db,
      "messages",
      {
        id: messageId,
        thread_id: thread.id,
        role: "user",
        content: msg.content,
        model_id: null,
        tool_name: null,
        created_at: now,
        modified_at: now,
        host_origin: this.siteId,
        deleted: 0,
      },
      this.siteId,
    );

    // Write intake relay to outbox — no direct agent loop invocation (AC6.1)
    const hubSiteId = this.getHubSiteId();
    writeOutbox(this.db, {
      id: randomUUID(),
      source_site_id: this.siteId,
      target_site_id: hubSiteId,
      kind: "intake",
      ref_id: null,
      idempotency_key: `intake:discord:${msg.id}`,
      stream_id: null,
      payload: JSON.stringify({
        platform: "discord",
        platform_event_id: msg.id,
        thread_id: thread.id,
        user_id: user.id,
        message_id: messageId,
        content: msg.content,
      } satisfies IntakePayload),
      created_at: now,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    this.eventBus.emit("sync:trigger", { reason: "discord-intake" });
  }

  private findOrCreateUser(discordId: string, displayName: string): User {
    // Look up user by platform_ids.discord JSON field
    const existing = this.db
      .query<User, [string]>(
        "SELECT * FROM users WHERE json_extract(platform_ids, '$.discord') = ? AND deleted = 0 LIMIT 1",
      )
      .get(discordId);
    if (existing) return existing;

    // Create new user with platform_ids = {"discord": "<id>"}
    const userId = randomUUID();
    const now = new Date().toISOString();
    insertRow(
      this.db,
      "users",
      {
        id: userId,
        display_name: displayName,
        platform_ids: JSON.stringify({ discord: discordId }),
        first_seen_at: now,
        modified_at: now,
        deleted: 0,
      },
      this.siteId,
    );
    return this.db.query<User, [string]>("SELECT * FROM users WHERE id = ? LIMIT 1").get(userId)!;
  }

  private findOrCreateThread(userId: string): Thread {
    const existing = this.db
      .query<Thread, [string]>(
        "SELECT * FROM threads WHERE user_id = ? AND interface = 'discord' AND deleted = 0 LIMIT 1",
      )
      .get(userId);
    if (existing) return existing;

    const threadId = randomUUID();
    const now = new Date().toISOString();
    insertRow(
      this.db,
      "threads",
      {
        id: threadId,
        user_id: userId,
        interface: "discord",
        host_origin: this.siteId,
        color: 0,
        title: null,
        summary: null,
        summary_through: null,
        summary_model_id: null,
        extracted_through: null,
        created_at: now,
        last_message_at: now,
        modified_at: now,
        deleted: 0,
      },
      this.siteId,
    );
    return this.db.query<Thread, [string]>("SELECT * FROM threads WHERE id = ? LIMIT 1").get(threadId)!;
  }

  private async getDMChannelForThread(threadId: string): Promise<{ send(content: string): Promise<unknown> } | null> {
    const thread = this.db
      .query<{ user_id: string }, [string]>(
        "SELECT user_id FROM threads WHERE id = ? AND deleted = 0 LIMIT 1",
      )
      .get(threadId);
    if (!thread) return null;

    const user = this.db
      .query<{ platform_ids: string | null }, [string]>(
        "SELECT platform_ids FROM users WHERE id = ? AND deleted = 0 LIMIT 1",
      )
      .get(thread.user_id);
    if (!user?.platform_ids) return null;

    const platformIds = JSON.parse(user.platform_ids) as Record<string, string>;
    const discordId = platformIds.discord;
    if (!discordId) return null;

    const discordUser = await this.client!.users.fetch(discordId);
    return discordUser.createDM();
  }

  private getHubSiteId(): string {
    const hub = this.db
      .query<{ value: string }, []>(
        "SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
      )
      .get();
    return hub?.value ?? this.siteId; // Fall back to self in single-host mode
  }
}
```

**Note on `messages` table columns:** The exact column list (especially `tool_calls`, `tool_name`) should be verified with `PRAGMA table_info(messages)` before implementation. Include only columns that exist in the table. The `insertRow()` call will fail at runtime if a column doesn't exist; a TypeScript error won't catch this.

**Verification:**

Run: `tsc -p packages/platforms --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add DiscordConnector migrated from packages/discord — intake relay pipeline, no direct agent loop`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 6) -->

<!-- START_TASK_6 -->
### Task 6: Tests

**Verifies:** platform-connectors.AC5.1, AC5.2, AC5.3, AC5.4, AC5.5, AC5.6, AC5.7, AC6.1, AC6.2, AC6.3, AC6.4, AC6.5

**Files:**
- Create: `packages/platforms/src/__tests__/leader-election.test.ts`
- Create: `packages/platforms/src/__tests__/registry.test.ts`
- Create: `packages/platforms/src/__tests__/discord-connector.test.ts`

**Testing:**

All test files use `bun:test`. Create a temp DB with `new Database(":memory:")`, apply schema with `applySchema(db)` (imported from `@bound/core`). Follow the existing test patterns from `packages/agent/src/__tests__/relay-processor.test.ts` (mock event bus using real `TypedEventEmitter`, mock logger, temp DB).

---

**`packages/platforms/src/__tests__/leader-election.test.ts`:**

Use a very short `failover_threshold_ms` (e.g., 50ms) to test timers without long waits. Use `await new Promise(resolve => setTimeout(resolve, 200))` to advance time past thresholds.

Tests must verify:

- **AC5.1:** After `election.start()` with no existing `cluster_config` entry, `election.isLeader()` is `true` AND `connector.connect()` was called.
- **AC5.2:** Pre-insert `cluster_config` row with `key = 'platform_leader:discord'` and `value = 'other-host'`. After `election.start()`, `election.isLeader()` is `false` AND `connector.connect()` was NOT called.
- **AC5.3:** Pre-insert a stale `cluster_config` leader pointing to 'other-host', and a `hosts` row for 'other-host' with `modified_at` set to 10 minutes ago. After `election.start()` and waiting > `failover_threshold_ms * 2`, `election.isLeader()` becomes `true`.
- **AC5.4:** After `election.start()` (this host claims leadership), wait for at least one heartbeat interval (`failover_threshold_ms / 3 + 50ms`). Assert `hosts.modified_at` for this siteId has changed from its initial value.

Create a mock connector that tracks `connect()` and `disconnect()` call counts:

```typescript
class MockConnector implements PlatformConnector {
  readonly platform = "discord";
  readonly delivery = "broadcast" as const;
  connectCallCount = 0;
  disconnectCallCount = 0;
  async connect(): Promise<void> { this.connectCallCount++; }
  async disconnect(): Promise<void> { this.disconnectCallCount++; }
  async deliver(): Promise<void> { /* no-op */ }
}
```

---

**`packages/platforms/src/__tests__/registry.test.ts`:**

Tests must verify:

- **AC5.5:** Create a registry with a single connector config `{ platform: "discord", ... }`. Replace the `createConnector` internal factory by passing a mock connector. Call `registry.start()`. Emit `"platform:deliver"` on eventBus with `platform: "discord"`. Assert mock `deliver()` was called with correct arguments.

To test routing without actually connecting to Discord, create a spy-based mock. The registry's `createConnector()` is private — test it through the public `start()` behavior by using a `platforms.json` config with `platform: "webhook-stub"` (which has a no-op `connect()`) and verifying that `"platform:deliver"` with `platform: "webhook-stub"` calls the stub connector's `deliver()` (which throws, so catch it).

---

**`packages/platforms/src/__tests__/discord-connector.test.ts`:**

Tests must verify:

- **AC6.1:** Call `connector.onMessage(mockMsg)` (expose `onMessage` as `public` for testing OR test through a spy). Assert `relay_outbox` has an entry with `kind = 'intake'` and correct `platform_event_id`.
- **AC6.2:** Same call. Assert `messages` table has a new row with `role = 'user'` and `content = mockMsg.content`.
- **AC6.3:** Call `connector.deliver(threadId, msgId, content)` where content is 3001 chars. Assert the mock Discord channel's `send()` was called twice (first call: chars 0–1999, second call: chars 2000–3000).
- **AC6.4:** Verify there is no `shouldActivate` method on `DiscordConnector` (structural check: `expect("shouldActivate" in new DiscordConnector(...)).toBe(false)`).
- **AC6.5:** Create connector with `config.allowed_users = ["allowed123"]`. Call `onMessage` with `msg.author.id = "other456"`. Assert no new row in `messages` table and no new row in `relay_outbox`.

For mocking Discord messages, create a plain object that satisfies the shape used in `onMessage`:

```typescript
const mockMsg = {
  id: "discord-msg-1",
  author: { id: "user123", bot: false, displayName: "Alice", username: "alice" },
  channel: { type: 1 /* ChannelType.DM */, send: mock(() => Promise.resolve()) },
  content: "Hello!",
};
```

For `deliver()` test, seed the DB with a thread and user (with `platform_ids = '{"discord":"user123"}'`), then mock `client.users.fetch()` to return an object with `createDM()` returning a channel mock.

Note: `DiscordConnector.connect()` imports `discord.js` dynamically. For unit tests, do NOT call `connect()` — instead, inject a mock `client` by exposing it as `protected` or through a constructor option, or test `onMessage()` as a protected method via a test subclass.

**Verification:**

Run: `bun test packages/platforms`
Expected: All tests pass.

Run: `bun run typecheck`
Expected: All packages pass typecheck.

**Commit:** `test: add platform-connectors Phase 3 tests for PlatformLeaderElection, PlatformConnectorRegistry, DiscordConnector (AC5.1–5.7, AC6.1–6.5)`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_D -->
