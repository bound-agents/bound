# Bound System Architecture - Phase 6: Discord Interface

**Goal:** Chat with the agent via Discord DM. Allowlisted users send DMs, receive agent responses. Non-allowlisted users are silently ignored. Cancel via cross reaction.

**Architecture:** `@bound/discord` package wrapping discord.js for gateway connection, DM handling, and thread mapping. The Discord bot maps DMs to agent threads and triggers agent loops. Allowlist enforcement matches Discord IDs against the users table (seeded from allowlist.json).

**Tech Stack:** discord.js (gateway, message events, reactions), @bound/core (DB, users table), @bound/agent (agent loop)

**Scope:** 8 phases from original design (phase 6 of 8)

**Codebase verified:** 2026-03-22 — Phase 1 provides DB with users table (discord_id field), allowlist config. Phase 4 provides agent loop.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.1 Success:** Every package has unit tests that run via `bun test`
- **system-arch.AC4.7 Success:** Tests that depend on external services (real LLM, real Discord) are skippable via environment flag without breaking the test suite

### Phase 6 Verification Criteria (derived from design "Done when")
- **V6.1:** DM the bot, receive agent response
- **V6.2:** Cancel with cross (❌) reaction on bot message
- **V6.3:** Non-allowlisted users get no response (silent rejection per R-W1)

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->
<!-- START_TASK_1 -->
### Task 1: @bound/discord package setup

**Files:**
- Create: `packages/discord/package.json`
- Create: `packages/discord/tsconfig.json`
- Create: `packages/discord/src/index.ts`
- Modify: `tsconfig.json` (root) — add discord to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/discord",
  "version": "0.0.1",
  "description": "Discord bot handler for DM-based agent conversations with allowlist enforcement and reaction-based cancel",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "@bound/agent": "workspace:*",
    "discord.js": "^14.0.0"
  }
}
```

**Step 2: Create tsconfig.json with references to shared, core, agent**

**Step 3: Verify**

Run: `bun install`
Expected: discord.js installs without errors

**Step 4: Commit**

```bash
git add packages/discord/ tsconfig.json bun.lockb
git commit -m "chore(discord): initialize @bound/discord package"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Discord gateway connection and allowlist enforcement

**Verifies:** system-arch.AC4.7

**Files:**
- Create: `packages/discord/src/bot.ts`
- Create: `packages/discord/src/allowlist.ts`
- Modify: `packages/discord/src/index.ts` — add exports

**Implementation:**

`packages/discord/src/allowlist.ts` — Allowlist enforcement:

- `isAllowlisted(discordId: string, db: Database): boolean` — Query users table for a non-deleted user with matching discord_id. Returns true if found, false otherwise. Per spec R-W1: silent rejection for non-allowlisted users (no response, no error).

`packages/discord/src/bot.ts` — Discord bot lifecycle:

- `DiscordBot` class:
  ```typescript
  class DiscordBot {
    constructor(
      private ctx: AppContext,
      private agentLoopFactory: (config: AgentLoopConfig) => AgentLoop,
      private botToken: string,
    ) {}

    async start(): Promise<void>;
    async stop(): Promise<void>;
  }
  ```

  `start()`:
  1. Create discord.js Client with `GatewayIntentBits.DirectMessages` and `GatewayIntentBits.MessageContent`
  2. Register `messageCreate` event handler
  3. Login with bot token (expanded from `${DISCORD_BOT_TOKEN}`)
  4. Log successful connection

  Message handler:
  1. Ignore bot messages (msg.author.bot)
  2. Ignore non-DM messages (msg.channel.type !== DM)
  3. Check allowlist: `isAllowlisted(msg.author.id, db)`. If not allowed → silently ignore (no response).
  4. Find or create thread for this user+interface=discord
  5. Persist user message to DB with change_log
  6. Trigger agent loop for the thread
  7. On agent response: send reply to Discord DM

  `stop()`: destroy discord.js client gracefully.

- `shouldActivate(ctx: AppContext): boolean` — Check if discord.json exists AND this host matches the configured `host` field. Only one host runs the bot.

**Testing:**
- Allowlist check: seed users with discord_id, verify isAllowlisted returns true. Verify non-seeded discord_id returns false.
- Message handling: mock discord.js Client, simulate DM message, verify agent loop triggered
- Non-allowlisted user: simulate DM from unknown discord_id, verify no response sent

Discord gateway tests should be skippable via `SKIP_DISCORD=1`.

Test file: `packages/discord/src/__tests__/allowlist.test.ts` (unit — real SQLite)
Test file: `packages/discord/src/__tests__/bot.test.ts` (unit — mock discord.js)

**Verification:**
Run: `bun test packages/discord/`
Expected: All tests pass (Discord gateway not required)

**Commit:** `feat(discord): add gateway connection with allowlist enforcement`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Thread mapping and cancel via reaction

**Files:**
- Create: `packages/discord/src/thread-mapping.ts`
- Modify: `packages/discord/src/bot.ts` — add reaction handler

**Implementation:**

`packages/discord/src/thread-mapping.ts` — Map Discord DMs to agent threads:

- `findOrCreateThread(db: Database, userId: string, siteId: string): Thread` — Query for existing non-deleted thread with this user_id and interface='discord'. If found, return it. If not, create new thread with random UUID, interface='discord', host_origin=siteId.

- `mapDiscordUser(db: Database, discordId: string): User | null` — Look up user by discord_id. Returns null if not found (not allowlisted).

Reaction-based cancel:
- Register `messageReactionAdd` event on discord.js Client
- When user adds ❌ (cross) reaction to a bot message in a DM → cancel the running agent loop for that thread
- Also handle "cancel" text message as a cancel trigger

**Testing:**
- Thread mapping: create a thread for a discord user, query again, verify same thread returned
- Multiple users get separate threads
- Cancel trigger: mock reaction event, verify agent loop cancel called

Test file: `packages/discord/src/__tests__/thread-mapping.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/discord/`
Expected: All tests pass

**Commit:** `feat(discord): add thread mapping and reaction-based cancel`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Discord integration test

**Files:**
- Create: `packages/discord/src/__tests__/integration.test.ts`

**Implementation:**

Integration test with mock discord.js:
1. Create temp database, seed users with discord_id
2. Create mock discord.js Client
3. Create DiscordBot with mock agent loop factory
4. Simulate incoming DM from allowlisted user
5. Verify: thread created in DB, user message persisted, agent loop spawned
6. Simulate response from mock agent loop
7. Verify: mock Discord client's send() called with response content
8. Simulate DM from non-allowlisted user
9. Verify: no thread created, no agent loop spawned, no response sent

**Verification:**
Run: `bun test packages/discord/`
Expected: All tests pass

**Commit:** `test(discord): add integration test for DM flow`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_A -->
