# Platform Connectors Implementation Plan — Phase 6: Config Migration + `discord` Package Deletion

**Goal:** Remove the `packages/discord/` package and all `discord.json` references; wire `PlatformConnectorRegistry` into CLI startup; clean up the deprecated `discord_id` field from the `User` type.

**Architecture:** Four changes: (1) Delete `packages/discord/` directory entirely. (2) Replace the Discord bot initialization block in `packages/cli/src/commands/start.ts` with a `PlatformConnectorRegistry` startup block that reads from `optionalConfig.platforms`. (3) Remove `@bound/discord` from `packages/cli/package.json`, add `@bound/platforms`. (4) Remove the `@deprecated discord_id` field from the `User` TypeScript type (added temporarily in Phase 1) and fix any remaining references.

**Note:** The config schema changes (`platforms.json` schema, `configSchemaMap` update, `ConfigType` update, `config-loader.ts` update) were done in Phase 1 Tasks 3–4. Phase 6 only needs to wire the runtime startup and delete the old package.

**Tech Stack:** TypeScript, Bun monorepo workspaces

**Scope:** Phase 6 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Acceptance Criteria Coverage

### platform-connectors.AC2: Config schema and loader (runtime validation)
- **platform-connectors.AC2.1 Success:** `platforms.json` with valid Discord connector config loads successfully
- **platform-connectors.AC2.2 Failure:** `platforms.json` with invalid `leadership` value (`"manual"`) fails Zod validation

### platform-connectors.AC7: discord package deleted + webhook route
- **platform-connectors.AC7.1 Success:** `packages/discord/` directory does not exist after Phase 6
- **platform-connectors.AC7.2 Success:** `bun run build` succeeds with no `@bound/discord` references

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Remove `discord_id` from User TypeScript type

**Verifies:** (structural — removes the `@deprecated` field added in Phase 1)

**Files:**
- Modify: `packages/shared/src/types.ts`

**Implementation:**

In Phase 1, `discord_id` was kept as `@deprecated` on the `User` interface to avoid breaking `packages/discord`. Now that `packages/discord` is being deleted, remove it.

Find the `User` interface in `packages/shared/src/types.ts` and remove the deprecated field:

```typescript
// Before:
export interface User {
  id: string;
  display_name: string;
  platform_ids: string | null;
  /** @deprecated removed in Phase 6 — use platform_ids */
  discord_id?: string | null;
  first_seen_at: string;
  modified_at: string;
  deleted: number;
}

// After:
export interface User {
  id: string;
  display_name: string;
  platform_ids: string | null;
  first_seen_at: string;
  modified_at: string;
  deleted: number;
}
```

After making this change, run typecheck to find any remaining references to `discord_id`:

```bash
grep -rn "discord_id" packages/ --include="*.ts" | grep -v "node_modules" | grep -v ".test." | grep -v "schema.ts"
```

Fix each remaining TypeScript reference. The `packages/discord/` package references will be deleted in Task 2, so they don't need individual fixes.

**Verification:**

Run: `tsc -p packages/shared --noEmit`
Expected: No TypeScript errors in `packages/shared`.

**Commit:** `feat: remove deprecated discord_id from User type (Phase 6 cleanup)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Delete `packages/discord/`

**Verifies:** platform-connectors.AC7.1

**Files:**
- Delete: `packages/discord/` (entire directory)

**Implementation:**

Delete the entire discord package directory. The directory contains:
- `src/allowlist.ts`
- `src/bot.ts`
- `src/client.ts`
- `src/index.ts`
- `src/thread-mapping.ts`
- `src/types.ts`
- `src/__tests__/allowlist.test.ts`
- `src/__tests__/bot.test.ts`
- `src/__tests__/integration.test.ts`
- `src/__tests__/thread-mapping.test.ts`
- `package.json`
- `tsconfig.json` (if it exists)

```bash
rm -rf packages/discord
```

**Verification:**

Run: `ls packages/`
Expected: `discord/` directory is absent from the listing.

Run: `grep -rn "@bound/discord" packages/ --include="*.ts" --include="*.json" | grep -v node_modules`
Expected: No output (no remaining references to `@bound/discord`).

**Commit:** `feat: delete packages/discord (migrated to packages/platforms)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update `packages/cli/package.json`

**Verifies:** AC7.2 (prerequisite — CLI can no longer depend on deleted package)

**Files:**
- Modify: `packages/cli/package.json`

**Implementation:**

Read `packages/cli/package.json` before editing. In the `dependencies` object:

1. Remove `"@bound/discord": "workspace:*"` (line ~15)
2. Add `"@bound/platforms": "workspace:*"`

The result should look like:

```json
{
  "dependencies": {
    "@bound/agent": "workspace:*",
    "@bound/core": "workspace:*",
    "@bound/llm": "workspace:*",
    "@bound/platforms": "workspace:*",
    "@bound/sandbox": "workspace:*",
    "@bound/shared": "workspace:*",
    "@bound/sync": "workspace:*",
    "@bound/web": "workspace:*",
    "reflect-metadata": "^0.2.2"
  }
}
```

After editing, run `bun install` from the repo root to update the workspace lockfile.

**Verification:**

Run: `bun install`
Expected: Installs without errors.

**Commit:** `chore: replace @bound/discord with @bound/platforms in packages/cli`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4) -->

<!-- START_TASK_4 -->
### Task 4: Replace Discord bot init with PlatformConnectorRegistry in CLI startup

**Verifies:** platform-connectors.AC2.1, AC2.2, AC7.2

**Files:**
- Modify: `packages/cli/src/commands/start.ts`

**Implementation:**

Read `packages/cli/src/commands/start.ts` before editing. The Discord initialization block is at lines 721–738. Replace the entire Discord block with a `PlatformConnectorRegistry` startup block.

**Remove:**

```typescript
// Lines 721–738 — DELETE all of this:
// 13. Discord (if configured)
console.log("Initializing Discord...");
let discordBot: { stop(): Promise<void> } | null = null;
const discordResult = appContext.optionalConfig.discord;
if (discordResult?.ok) {
  const { shouldActivate, DiscordBot } = await import("@bound/discord");
  if (shouldActivate(appContext)) {
    const discordConfig = discordResult.value as { bot_token: string; host: string };
    const bot = new DiscordBot(appContext, agentLoopFactory, discordConfig.bot_token);
    await bot.start();
    discordBot = bot;
    console.log("[discord] Bot started");
  } else {
    console.log("[discord] Config present but host does not match, skipping");
  }
} else {
  console.log("[discord] Not configured");
}
```

**Add in its place:**

```typescript
// 13. Platform connectors (if configured)
let platformRegistry: { stop(): void } | null = null;
const platformsResult = appContext.optionalConfig.platforms;
if (platformsResult?.ok) {
  const { PlatformConnectorRegistry } = await import("@bound/platforms");
  const platformsConfig = platformsResult.value as import("@bound/shared").PlatformsConfig;
  platformRegistry = new PlatformConnectorRegistry(appContext, platformsConfig);
  platformRegistry.start();
  console.log("[platforms] Platform connector registry started");
} else {
  console.log("[platforms] Not configured (no platforms.json)");
}
```

**Also update the shutdown handlers** (at lines ~846–852 and ~871–877). Find all `discordBot.stop()` references and replace with `platformRegistry?.stop()`:

```typescript
// In each shutdown handler block where discordBot was stopped:
// Remove:
//   if (discordBot) await discordBot.stop();
// Add:
if (platformRegistry) {
  try {
    platformRegistry.stop();
  } catch (err) {
    console.error("[platforms] Error stopping platform registry:", err);
  }
}
```

**Remove any remaining `@bound/discord` or `discordBot` variable references** in the file. After these changes, run:

```bash
grep -n "discord" packages/cli/src/commands/start.ts
```

Expected: No remaining Discord references (only "platform" references).

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No TypeScript errors.

Run: `bun run build`
Expected: Build succeeds. No `@bound/discord` references in the output.

**Commit:** `feat: replace DiscordBot startup with PlatformConnectorRegistry in CLI (AC7.2)`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Update user seeding in CLI startup

**Verifies:** Prevents `bound start` crash after Phase 1 drops `discord_id` column

**Files:**
- Modify: `packages/cli/src/commands/start.ts`

**Implementation:**

Read `packages/cli/src/commands/start.ts` before editing. The user seeding block (around lines 79–119) iterates the allowlist and creates/updates users using `discord_id`. After Phase 1, the allowlist schema no longer has `discord_id` (it has `platforms` instead), and the `users` table no longer has a `discord_id` column.

Find the user seeding block. It will look similar to:

```typescript
// OLD — remove this pattern:
for (const [displayName, entry] of Object.entries(allowlist.users)) {
  const existing = db.query("SELECT id FROM users WHERE discord_id = ? LIMIT 1").get(entry.discord_id);
  if (!existing) {
    insertRow(db, "users", {
      id: randomUUID(),
      display_name: displayName,
      discord_id: entry.discord_id,  // ← column no longer exists
      first_seen_at: now,
      modified_at: now,
      deleted: 0,
    }, siteId);
  }
}
```

Replace with a platform_ids-based approach:

```typescript
// NEW — use platform_ids instead of discord_id:
for (const [displayName, entry] of Object.entries(allowlist.users)) {
  const userEntry = entry as { display_name?: string; platforms?: Record<string, string> };
  const platformIds = userEntry.platforms ?? {};
  const platformIdsJson = JSON.stringify(platformIds);

  // Check if user already exists by matching any known platform ID
  // For simplicity, check by display_name first (then upsert)
  const existing = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM users WHERE display_name = ? AND deleted = 0 LIMIT 1",
    )
    .get(displayName);

  if (!existing && Object.keys(platformIds).length > 0) {
    insertRow(db, "users", {
      id: randomUUID(),
      display_name: displayName,
      platform_ids: platformIdsJson,
      first_seen_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
      deleted: 0,
    }, siteId);
  } else if (existing && Object.keys(platformIds).length > 0) {
    updateRow(db, "users", existing.id, { platform_ids: platformIdsJson }, siteId);
  }
}
```

**Note:** The exact shape of the seeding block depends on the current implementation. Read the file, understand the current logic, and replicate it using `platform_ids` instead of `discord_id`. The key change is: replace `entry.discord_id` with `JSON.stringify(entry.platforms ?? {})`, and replace any `discord_id` column write with `platform_ids`.

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No TypeScript errors.

Run: `grep -n "discord_id" packages/cli/src/commands/start.ts`
Expected: No output.

**Commit:** `feat: update user seeding to use platform_ids instead of discord_id in CLI startup`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Verify full build and run tests

**Verifies:** platform-connectors.AC7.1, AC7.2 (final verification)

**Files:**
- No file changes — verification only

**Implementation:**

**5a. Verify no Discord references remain:**

```bash
grep -rn "@bound/discord\|from.*discord\|import.*discord" packages/ --include="*.ts" --include="*.json" | grep -v node_modules | grep -v packages/platforms/src/connectors/discord
```

Expected: No output (the only remaining "discord" references should be inside `packages/platforms/src/connectors/discord.ts` which is the migrated connector, not the deleted package).

**5b. Verify packages/discord/ is gone:**

```bash
ls packages/ | grep discord
```

Expected: No output.

**5c. Full test suite:**

```bash
bun test --recursive
```

Expected: All tests pass. The `packages/discord/` tests no longer exist (deleted with the package). All other tests pass without regression.

**5d. Full typecheck:**

```bash
bun run typecheck
```

Expected: All packages pass typecheck. No errors referencing `DiscordConfig`, `discordSchema`, `discord_id`, or `@bound/discord`.

**5e. Build:**

```bash
bun run build
```

Expected: Build succeeds and produces `dist/bound` binary with no Discord package references.

**Commit:** (only if any fixup changes were needed during verification)

If all checks pass without changes: `chore: verify Phase 6 complete — discord package deleted, platforms wired`
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_C -->
