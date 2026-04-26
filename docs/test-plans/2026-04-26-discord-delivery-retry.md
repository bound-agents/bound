# Human Test Plan: Discord Delivery-Retry Nudge

## Context

Thread `a83b945f-d4b1-4b77-904f-bb9b465edc1d` (the reporter's own Discord thread) has historically seen turns where the model responds as plain assistant text instead of calling `discord_send_message`, and the reply silently never reaches Discord. This work adds a post-loop hook that detects the missing send and enqueues a one-shot nudge so the agent gets a second attempt without forcing the tool call.

See commits `963c849`..`1da5f6f` on `main` for the code path.

## Prerequisites

- Fresh install: `bun run build && cp ./dist/bound* ~/.local/bin/` on the node that owns the Discord connector.
- `bun run packages/cli/src/bound.ts start` running, with Discord platform connector configured and a bot running.
- Access to the Discord DM thread used for testing (e.g. the reporter's own DM).
- `sqlite3 ~/bound/data/bound.db` available for spot-checks.
- `bun test --recursive` passing with 0 failures.
- `bun run typecheck` clean.

## Phase 0: Regression guards

| Step | Action | Expected |
|------|--------|----------|
| 0.1 | `sqlite3 ~/bound/data/bound.db "SELECT role, substr(content,1,60) FROM messages WHERE thread_id='a83b945f-d4b1-4b77-904f-bb9b465edc1d' AND created_at > '2026-04-26T07:00:00' AND role IN ('developer','system','assistant') ORDER BY created_at ASC LIMIT 10"` | After rollout, prior `role=system` heartbeat notifications on this thread remain as-is (they're history); any NEW notification landing after rollout shows `role=developer`, not `system`. |
| 0.2 | Trigger a heartbeat (or wait for the next scheduled one). Watch the thread for an assistant turn responding to the heartbeat content. | The agent produces a turn that references the heartbeat observation (e.g. mentions "unfollowed thread" or similar language from the notification text). This proves Invariant #19 is holding — notifications now reach the LLM. |
| 0.3 | `sqlite3 ~/bound/data/bound.db "PRAGMA table_info(messages)"` | Output includes a row for `metadata` with type `TEXT`. |

## Phase 1: Delivery-retry nudge on a missing send

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | In the Discord DM thread, send a message that is known to sometimes trigger a text-only response. If the reporter has a repro recipe, use that; otherwise: ask a short question ("how are you doing today?"). | The agent responds with a Discord message OR the retry flow fires. |
| 1.2 | If the Discord message arrives, the test's happy path already works — no nudge needed. Skip to Phase 2. | Verdict `delivered`. |
| 1.3 | If no Discord message arrives within 30 seconds, `sqlite3 ~/bound/data/bound.db "SELECT role, content, metadata FROM messages WHERE thread_id='a83b945f-...' ORDER BY created_at DESC LIMIT 5"` | Most recent row is `role=developer`, content starts with `[Delivery retry]`, `metadata` contains `discord_platform_delivery_retry`. The row immediately before it is an `assistant` message with no matching tool call. |
| 1.4 | `sqlite3 ~/bound/data/bound.db "SELECT status, event_type FROM dispatch_queue WHERE message_id IN (SELECT id FROM messages WHERE thread_id='a83b945f-...' AND role='developer' AND metadata IS NOT NULL ORDER BY created_at DESC LIMIT 1)"` | Either `processing` (loop running now) or `acknowledged` (loop finished). Never `pending` after 30 seconds. |
| 1.5 | Wait for the follow-up turn to complete. The agent should have read the nudge as `developer` context and called `discord_send_message`. | A Discord message arrives in the DM. |

## Phase 2: No double-nudging on intentional silence

This phase exercises the retry tombstone: after one nudge, if the agent still doesn't call the tool, we must respect that silence and not spam a second nudge.

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | In a fresh Discord message, ask the agent something where silence is a legitimate answer (e.g. "please don't respond to this one, just acknowledge internally"). | Varies — depends on model. |
| 2.2 | If the agent sends a Discord reply, the silence branch can't be tested here; request a second message designed to elicit no reply, or skip to Phase 3. | — |
| 2.3 | If no Discord reply arrives and the nudge fires, wait for the follow-up turn. The agent may or may not call `discord_send_message` on the retry turn. | If it sends, verdict resolves `delivered`. If it stays silent, proceed to 2.4. |
| 2.4 | `sqlite3 ~/bound/data/bound.db "SELECT COUNT(*) FROM messages WHERE thread_id='a83b945f-...' AND role='developer' AND metadata LIKE '%discord_platform_delivery_retry%' AND created_at > <timestamp of 2.1>"` | Count = 1. Exactly one nudge was issued in the window, never two. |
| 2.5 | `sqlite3 ~/bound/data/bound.db "SELECT COUNT(*) FROM messages WHERE thread_id='a83b945f-...' AND role='developer' AND content LIKE '%Delivery retry%' AND created_at > <timestamp of 2.1>"` | Count = 1. Confirms no duplicate nudge content either. |

## Phase 3: Fresh user message un-silences the agent

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Following a Phase 2 intentional-silence turn, send a new user message in Discord (any content). | — |
| 3.2 | The agent's follow-up turn should produce a Discord message OR a new nudge — either way the prior tombstone should no longer count, because the conversation window is bounded by "most recent user message". | Agent replies normally, OR nudge fires afresh (ONE new nudge, not cumulative). |
| 3.3 | `sqlite3 ~/bound/data/bound.db "SELECT COUNT(*) FROM messages WHERE thread_id='a83b945f-...' AND role='developer' AND metadata LIKE '%discord_platform_delivery_retry%' AND created_at > <timestamp of 3.1>"` | Count ≤ 1. Even across phases 2 and 3, the per-user-turn nudge budget is respected. |

## Phase 4: Other platforms unaffected

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | From the web UI or `boundless`, send a message to the agent. | Agent responds normally. No nudge logic fires (no Discord interface on this thread). |
| 4.2 | `sqlite3 ~/bound/data/bound.db "SELECT COUNT(*) FROM messages WHERE role='developer' AND metadata LIKE '%delivery_retry%' AND thread_id = '<web-thread-id>'"` | Count = 0. |

## Observability

Tail the service log while running Phase 1. A "missing" verdict produces no explicit log line today (verifyDelivery is quiet on non-missing), but the insertion of the developer nudge and dispatch entry is observable in the DB. Future work could add a `[delivery-check]` log entry at the "missing" branch if it becomes important.

A `verifyDelivery` throw (transient DB error, unexpected shape) is logged at `warn` level with prefix `[delivery-check]`. Grep `~/bound/logs/*` after each test session; zero matches is expected.

## Rollback

Revert `40e045e..1da5f6f` (the two Phase 2 commits) to disable the nudge while keeping Invariant #19 enforcement. The Phase 1 commits (`963c849..0f96e89`) are the notification-reaches-LLM fix and should remain even if Phase 2 is reverted, since they address a separate live bug.

## Notes

- `DISCORD_DELIVERY_RETRY_NUDGE` text is a const in `packages/platforms/src/connectors/discord.ts`; tweak if the wording needs adjustment after observation.
- The metadata key `discord_platform_delivery_retry` is platform-namespaced per `messages.metadata` convention; a future Slack connector would use `slack_platform_delivery_retry` with the same structural pattern.
- The turn boundary is captured as an ISO timestamp in JS in `handleThread` before `runLocalAgentLoop`; it does NOT rely on SQLite `datetime('now')` (which would risk the space-vs-T comparison trap in `Common Gotchas`).
