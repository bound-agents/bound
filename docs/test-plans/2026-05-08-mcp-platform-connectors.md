# Human Test Plan: MCP Platform Connectors

## Overview

Manual verification of the MCP platform connector system after automated tests pass. These tests exercise the full system end-to-end in a real deployment environment.

## Prerequisites

- A running bound instance with `platforms.json` configured for Discord
- A Discord bot token with DM permissions
- A second bound instance (for multi-host tests) or ability to simulate hub/spoke

## Test Scenarios

### 1. Discord Bot Connects and Discovers Events

**Steps:**
1. Start bound with a valid Discord bot configuration in `platforms.json`
2. Verify in logs: "Platform MCP server 'discord' registered and connected"
3. Verify in logs: "Discovered N tools from server 'discord'"
4. Query `hosts` table: verify `platforms` column contains `["discord"]`

**Expected:** Bot connects to Discord gateway, MCP server registered, tools discovered.

### 2. Dispatcher Task Creates Connector Handle

**Steps:**
1. Send a DM to the bot from an allowlisted Discord user
2. Wait for the dispatcher task to wake (triggered by `connector:list_changed`)
3. Verify in logs: dispatcher task executes
4. Query `connector_handles` table: verify a row exists for the DM channel
5. Query `tasks` table: verify an event task exists with `trigger_spec = "connector:event:{handleId}"`
6. Query `threads` table: verify a thread exists with `interface = "platform"`

**Expected:** Dispatcher discovers new DM, creates handle + task + thread.

### 3. Event Delivery and Agent Response

**Steps:**
1. After connector handle is created (test 2), send another DM
2. Wait for the event to be delivered to the task thread
3. Query `messages` table for the event task's thread: verify a `role = "developer"` message with the DM content
4. Wait for the agent to process and respond
5. Verify the bot sends a reply in Discord

**Expected:** DM → event → developer message → agent processes → discord_send_message tool call → reply appears in Discord.

### 4. Message Chunking (>2000 chars)

**Steps:**
1. Trigger a scenario where the agent generates a response >2000 characters
2. Observe Discord messages received

**Expected:** Response split into multiple messages, each ≤2000 chars, split at paragraph/line/word boundaries.

### 5. Duplicate Event Prevention

**Steps:**
1. Rapidly send the same message twice (or simulate network replay)
2. Query the event task's thread messages

**Expected:** Only one developer-role message persisted (deduplication by eventId).

### 6. Cursor Persistence

**Steps:**
1. Deliver several events to a connector handle
2. Query `connector_handles` table: verify `cursor` column updates after each batch

**Expected:** Cursor advances monotonically after each delivery.

### 7. Leader Election (Multi-Host)

**Steps:**
1. Start two bound instances configured as hub + spoke
2. Verify only the leader instance logs "Platform MCP server 'discord' registered"
3. Stop the leader
4. Verify the standby instance takes over (reconnects subscriptions)
5. Send a DM and verify it's processed by the new leader

**Expected:** Only leader has active MCP servers; failover works transparently.

### 8. Relay Intake (Multi-Host)

**Steps:**
1. In a hub-spoke setup, verify events on the spoke write `relay_outbox` entries
2. Verify the hub routes intake to the host with platform affinity
3. Verify the spoke processes the event with platform tools available

**Expected:** Multi-host routing works correctly via platform affinity.

### 9. Poll Mode Delivery

**Steps:**
1. Create a connector handle with `delivery_mode = "poll"` in the DB
2. Verify periodic polling occurs (check logs for poll activity)
3. Send a DM and verify it arrives via the poll path

**Expected:** Poll timer fires, events delivered identically to push mode.

### 10. Config Compatibility

**Steps:**
1. Use an existing `platforms.json` from a pre-MCP deployment
2. Start bound
3. Verify no config parse errors

**Expected:** Existing config works without modification.

### 11. Legacy Code Removal Verification

**Steps:**
1. Verify `POST /hooks/:platform` returns 404
2. Verify no `platform:deliver` events appear in event bus logs
3. Verify no webhook-related routes in the web server

**Expected:** All legacy endpoints are gone.

## Pass Criteria

All 11 scenarios pass. Critical paths (2, 3, 7) must work without manual intervention after initial setup.
