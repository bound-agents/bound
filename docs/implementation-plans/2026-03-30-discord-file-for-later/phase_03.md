# Discord "File for Later" Implementation Plan — Phase 3

**Goal:** Implement the full message pipeline from interaction to intake relay — reusing DiscordConnector's `onMessage` patterns for user/thread/message creation, with interaction-specific additions: target author trust signal, filing prompt construction, content validation, and allowlist enforcement.

**Architecture:** The `handleInteraction()` method in DiscordInteractionConnector (Phase 2) is extended with the filing flow. It follows the same sequence as `DiscordConnector.onMessage()` (`discord.ts:215-374`): allowlist check → `findOrCreateUser()` → `findOrCreateThread()` → `insertRow("messages")` → `writeOutbox("intake")` → `sync:trigger`. The thread uses `interface = 'discord-interaction'` to distinguish from DM threads. The filing prompt includes metadata (author, channel, timestamp) and a trust signal indicating whether the target author is a recognized bound user, unrecognized, or the bot itself.

**Tech Stack:** TypeScript, Discord.js v14 (dynamic import), bun:sqlite, bun:test

**Scope:** 5 phases from original design (phase 3 of 5)

**Codebase verified:** 2026-03-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### discord-file-for-later.AC2: Interaction handling and ephemeral response
- **discord-file-for-later.AC2.3 Failure:** Interaction from non-allowlisted user receives ephemeral error reply, no message/thread/relay created
- **discord-file-for-later.AC2.4 Failure:** Target message with empty content and no image attachments receives `editReply` with `"Error: This message has no extractable content."`, no pipeline invoked

### discord-file-for-later.AC3: Message pipeline reuse
- **discord-file-for-later.AC3.1 Success:** Interaction creates/reuses user record via `findOrCreateUser` with `interaction.user.id`
- **discord-file-for-later.AC3.2 Success:** Interaction creates/reuses thread with `interface = 'discord-interaction'`
- **discord-file-for-later.AC3.3 Success:** User message persisted via `insertRow("messages", ...)` with filing prompt containing target content, author, channel, timestamp
- **discord-file-for-later.AC3.4 Success:** Intake relay written via `writeOutbox` with `platform: "discord-interaction"`, `sync:trigger` emitted

### discord-file-for-later.AC4: Target author trust signal
- **discord-file-for-later.AC4.1 Success:** Target author found in users table includes `(recognized — bound user "name")` in prompt (note: uses em-dash `—`, matching the design's Architecture section format)
- **discord-file-for-later.AC4.2 Success:** Target author not found includes `(unrecognized)` in prompt
- **discord-file-for-later.AC4.3 Edge:** Target message from the bot itself includes `(this bot)` in prompt

---

<!-- START_TASK_1 -->
### Task 1: Add filing flow to DiscordInteractionConnector

**Files:**
- Modify: `packages/platforms/src/connectors/discord-interaction.ts` (created in Phase 2)

**Implementation:**

Extend the `handleInteraction()` method with the full filing pipeline. Add imports and helper methods following the existing patterns from `DiscordConnector` (`discord.ts:215-374`).

**Add imports at top of file:**

```typescript
import { randomUUID } from "node:crypto";
import { insertRow, writeOutbox } from "@bound/core";
import type { IntakePayload, Thread, User } from "@bound/shared";
```

**Add helper methods to DiscordInteractionConnector class:**

```typescript
private findOrCreateUser(discordId: string, displayName: string): User {
    const existing = this.db
        .query<User, [string]>(
            "SELECT * FROM users WHERE json_extract(platform_ids, '$.discord') = ? AND deleted = 0 LIMIT 1",
        )
        .get(discordId);
    if (existing) return existing;

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
    const result = this.db
        .query<User, [string]>("SELECT * FROM users WHERE id = ? LIMIT 1")
        .get(userId);
    if (!result) {
        throw new Error(`User ${userId} not found after insertRow`);
    }
    return result;
}

private findOrCreateThread(userId: string): Thread {
    const existing = this.db
        .query<Thread, [string]>(
            "SELECT * FROM threads WHERE user_id = ? AND interface = 'discord-interaction' AND deleted = 0 LIMIT 1",
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
            interface: "discord-interaction",
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
    const result = this.db
        .query<Thread, [string]>("SELECT * FROM threads WHERE id = ? LIMIT 1")
        .get(threadId);
    if (!result) {
        throw new Error(`Thread ${threadId} not found after insertRow`);
    }
    return result;
}

private getHubSiteId(): string {
    const hub = this.db
        .query<{ value: string }, []>(
            "SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
        )
        .get();
    return hub?.value ?? this.siteId;
}

/**
 * Resolve trust signal for the target message's author.
 * - Bot itself: "(this bot)"
 * - Recognized bound user: "(recognized — bound user \"name\")"
 * - Unknown: "(unrecognized)"
 */
private resolveTrustSignal(authorId: string, authorBot: boolean): string {
    // AC4.3: Check if target is the bot itself
    try {
        const client = this.clientManager.getClient();
        if (client.user && authorId === client.user.id) {
            return "(this bot)";
        }
    } catch {
        // Client not connected — fall through to DB lookup
    }

    // AC4.1/AC4.2: Look up in users table
    const boundUser = this.db
        .query<{ display_name: string }, [string]>(
            "SELECT display_name FROM users WHERE json_extract(platform_ids, '$.discord') = ? AND deleted = 0 LIMIT 1",
        )
        .get(authorId);

    if (boundUser) {
        return `(recognized — bound user "${boundUser.display_name}")`;
    }
    return "(unrecognized)";
}
```

**Rewrite `handleInteraction()` with full filing flow:**

```typescript
private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    // AC2.5: Only handle message context menu commands named "File for Later"
    if (!interaction.isMessageContextMenuCommand()) return;
    if (interaction.commandName !== "File for Later") return;

    // AC2.1: Defer with ephemeral response as first action
    await interaction.deferReply({ ephemeral: true });

    // AC2.3: Allowlist check on the invoking user
    if (
        this.config.allowed_users.length > 0 &&
        !this.config.allowed_users.includes(interaction.user.id)
    ) {
        await interaction.editReply({ content: "Error: You are not authorized to use this command." });
        return;
    }

    // AC2.4: Validate extractable content
    const targetMessage = interaction.targetMessage;
    const hasContent = targetMessage.content && targetMessage.content.trim().length > 0;
    const hasImages = targetMessage.attachments.some(
        (att) => att.contentType?.startsWith("image/") ?? false,
    );
    if (!hasContent && !hasImages) {
        await interaction.editReply({ content: "Error: This message has no extractable content." });
        return;
    }

    // AC3.1: Find or create user for the invoking user
    const user = this.findOrCreateUser(
        interaction.user.id,
        interaction.user.displayName ?? interaction.user.username,
    );

    // AC3.2: Find or create thread with interface = 'discord-interaction'
    const thread = this.findOrCreateThread(user.id);

    // AC4.1/AC4.2/AC4.3: Resolve trust signal for the target author
    const trustSignal = this.resolveTrustSignal(
        targetMessage.author.id,
        targetMessage.author.bot,
    );

    // Build filing prompt (AC3.3)
    const channelName = interaction.channel && "name" in interaction.channel
        ? `#${interaction.channel.name}` : "unknown channel";
    const guildName = interaction.guild?.name ?? "DM";
    const timestamp = targetMessage.createdAt?.toISOString()
        ?? new Date().toISOString();

    const filingPrompt = [
        "File this message for future reference.",
        "",
        `From: @${targetMessage.author.displayName ?? targetMessage.author.username} ${trustSignal}`,
        `Channel: ${channelName} in ${guildName}`,
        `Sent: ${timestamp}`,
        "",
        targetMessage.content,
    ].join("\n");

    // AC3.3: Persist user message with filing prompt
    const now = new Date().toISOString();
    const messageId = randomUUID();
    insertRow(
        this.db,
        "messages",
        {
            id: messageId,
            thread_id: thread.id,
            role: "user",
            content: filingPrompt,
            model_id: null,
            tool_name: null,
            created_at: now,
            modified_at: now,
            host_origin: this.siteId,
            deleted: 0,
        },
        this.siteId,
    );

    // Store interaction for later delivery (Phase 4 polls and calls deliver())
    this.storeInteraction(thread.id, interaction);

    // AC3.4: Write intake relay
    try {
        const hubSiteId = this.getHubSiteId();
        writeOutbox(this.db, {
            id: randomUUID(),
            source_site_id: this.siteId,
            target_site_id: hubSiteId,
            kind: "intake",
            ref_id: null,
            idempotency_key: `intake:discord-interaction:${targetMessage.id}:${interaction.user.id}`,
            stream_id: null,
            payload: JSON.stringify({
                platform: "discord-interaction",
                platform_event_id: targetMessage.id,
                thread_id: thread.id,
                user_id: user.id,
                message_id: messageId,
                content: filingPrompt,
            } satisfies IntakePayload),
            created_at: now,
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        });

        this.eventBus.emit("sync:trigger", { reason: "discord-interaction-intake" });
    } catch (err) {
        this.logger.error("Failed to write intake relay", { error: String(err) });
        await interaction.editReply({ content: "Error: Failed to process this message. Please try again." });
    }

    this.logger.info("File for Later interaction processed", {
        userId: interaction.user.id,
        messageId: targetMessage.id,
        threadId: thread.id,
    });
}
```

Key decisions:
- `findOrCreateUser` and `findOrCreateThread` are duplicated from DiscordConnector with `interface = 'discord-interaction'`. This avoids touching the already-refactored DiscordConnector.
- The idempotency key includes both the target message ID and the invoking user ID to avoid collisions when multiple users file the same message.
- The filing prompt format matches the design specification exactly.
- `interaction.channel.name` access is guarded since channel type may not have a `name` property in DMs.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** `feat(platforms): add filing flow to DiscordInteractionConnector`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Write filing flow tests

**Verifies:** discord-file-for-later.AC2.3, discord-file-for-later.AC2.4, discord-file-for-later.AC3.1, discord-file-for-later.AC3.2, discord-file-for-later.AC3.3, discord-file-for-later.AC3.4, discord-file-for-later.AC4.1, discord-file-for-later.AC4.2, discord-file-for-later.AC4.3

**Files:**
- Modify: `packages/platforms/src/__tests__/discord-interaction.test.ts` (created in Phase 2)

**Testing:**

Add a new `describe("Filing flow")` block to the existing test file. Tests require a real SQLite test database (using the `applySchema(db)` + randomBytes temp path pattern from `discord-connector.test.ts:42-65`) because the filing flow writes to `users`, `threads`, `messages`, and `relay_outbox` tables.

The mock interaction object must include:
- `isMessageContextMenuCommand()` → true
- `commandName` → "File for Later"
- `deferReply(opts)` → Promise<void> (spy to verify calls)
- `editReply(opts)` → Promise<void> (spy to verify calls)
- `user` → `{ id, displayName, username }`
- `targetMessage` → `{ id, content, author: { id, displayName, username, bot }, attachments, createdAt }`
- `guild` → `{ name }` or null
- `channel` → `{ name }` or null

Initialize `cluster_config` with a `cluster_hub` entry in `beforeEach` (same as `discord-connector.test.ts:59-64`).

**AC test cases:**

- **AC2.3 (allowlist rejection)**: Set `config.allowed_users = ["allowed-user"]`. Fire interaction with `user.id = "other-user"`. Verify `editReply` called with authorization error. Verify NO rows in `users`, `threads`, or `messages` tables. Verify NO rows in `relay_outbox`.

- **AC2.4 (empty content)**: Fire interaction with `targetMessage.content = ""` and `targetMessage.attachments` returning empty collection (`.some()` returns false). Verify `editReply` called with `"Error: This message has no extractable content."`. Verify no pipeline invoked.

- **AC3.1 (user creation)**: Fire interaction. Verify `users` table has a row with `json_extract(platform_ids, '$.discord') = interaction.user.id`. Fire again with same user — verify same user ID reused (not duplicated).

- **AC3.2 (thread creation)**: Fire interaction. Verify `threads` table has a row with `interface = 'discord-interaction'` and correct `user_id`. Fire again — verify same thread reused.

- **AC3.3 (message persistence)**: Fire interaction with known content, author, channel, guild. Verify `messages` table has a row with `role = 'user'` and `content` matching the expected filing prompt format:
  ```
  File this message for future reference.

  From: @AuthorName (trust-signal)
  Channel: #channel-name in GuildName
  Sent: 2026-03-30T14:22:00.000Z

  original message content
  ```
  Also verify `change_log` entry exists (proving `insertRow` was used, not raw SQL).

- **AC3.4 (intake relay)**: Fire interaction. Verify `relay_outbox` has a row with `kind = 'intake'`. Parse payload JSON and verify `platform = "discord-interaction"`, `thread_id`, `user_id`, `message_id`, `content` fields. Verify `sync:trigger` event was emitted (use spy on eventBus).

- **AC4.1 (recognized user)**: Pre-insert a user in the `users` table with `platform_ids = '{"discord": "target-author-id"}'` and `display_name = "alice"`. Fire interaction with `targetMessage.author.id = "target-author-id"`. Verify filing prompt contains `(recognized — bound user "alice")`.

- **AC4.2 (unrecognized user)**: Fire interaction with a target author ID that doesn't exist in `users` table. Verify filing prompt contains `(unrecognized)`.

- **AC4.3 (bot message)**: Configure mock client with `client.user = { id: "bot-id" }`. Fire interaction with `targetMessage.author.id = "bot-id"`. Verify filing prompt contains `(this bot)`.

Follow project testing patterns in:
- `packages/platforms/src/__tests__/discord-connector.test.ts` (real DB, mock logger, change_log verification at line 145-151)
- Root `CLAUDE.md` lines 123-131 (testing conventions)

**Verification:**
Run: `bun test packages/platforms/src/__tests__/discord-interaction.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): add filing flow tests for DiscordInteractionConnector`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Verify full platform test suite

**Files:** None (verification only)

**Verification:**
Run: `bun test packages/platforms`
Expected: All platform tests pass

Run: `tsc -p packages/platforms --noEmit`
Expected: No type errors

**Commit:** No commit — verification only
<!-- END_TASK_3 -->
