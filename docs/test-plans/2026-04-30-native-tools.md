# Native Agent Tools — Human Test Plan

## Prerequisites
- Two-node cluster deployed: one spoke (local) and one hub (e.g., `polaris.karashiiro.moe`)
- `bun run build && cp dist/bound* ~/.local/bin/` completed on both nodes
- `bun test --recursive` passing (all packages)
- Web UI accessible at `http://localhost:3001` on the spoke
- Discord platform connector configured on the spoke (for cross-platform notification verification)

## Phase 1: Native Tool Invocation via Web UI

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Open web UI at `http://localhost:3001`. Create a new thread. | Thread created successfully |
| 1.2 | Send: "Schedule a task to run every 30 minutes that checks disk usage. Use cron 0,30 * * * *" | Agent uses the `schedule` native tool (not bash). The tool call shows `schedule` as the tool name with structured parameters `{ task_description: "...", cron: "0,30 * * * *" }`. Response includes a task ID. |
| 1.3 | Send: "Query all pending tasks" | Agent uses the `query` native tool with `{ sql: "SELECT id, status, trigger_spec FROM tasks WHERE status = 'pending' AND deleted = 0" }`. Response shows TSV-formatted table including the task from step 1.2. |
| 1.4 | Send: "Cancel the task you just created" | Agent uses the `cancel` native tool with `{ task_id: "<id-from-1.2>" }`. Response confirms cancellation. |
| 1.5 | Send: "Remember that the disk check cron was cancelled because it was a test" | Agent uses the `memory` native tool with `{ action: "store", key: "...", value: "..." }`. Response confirms memory saved. |
| 1.6 | Send: "Search my memories for disk check" | Agent uses the `memory` native tool with `{ action: "search", key: "disk check" }`. Response contains the memory from step 1.5. |
| 1.7 | Send: "What hosts are in this cluster?" | Agent uses the `hostinfo` native tool with `{}`. Response contains the formatted host report listing all connected nodes. |

## Phase 2: Grouped Tool Action Dispatch

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Send: "Create an advisory titled 'Upgrade Node.js' with detail 'Current version is EOL'" | Agent uses `advisory` tool with `{ title: "Upgrade Node.js", detail: "Current version is EOL" }`. Response contains advisory ID. |
| 2.2 | Send: "List all advisories" | Agent uses `advisory` tool with `{ list: true }`. Response shows the advisory from 2.1 with status "proposed". |
| 2.3 | Send: "Pin the file at /home/user/config/important.yaml in cache" | Agent uses `cache` tool with `{ action: "pin", path: "/home/user/config/important.yaml" }`. If file exists, response confirms pin. If not, response is a descriptive "not found" error (not a crash). |
| 2.4 | Send: "List all skills" | Agent uses `skill` tool with `{ action: "list" }`. Response shows the formatted skill table (may be empty if no skills are activated). |

## Phase 3: Sandbox Tool Scope Verification

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Send: "Run `ls /tmp` in the terminal" | Agent uses the `bash` tool with `{ command: "ls /tmp" }`. Output shows directory listing. |
| 3.2 | Inspect the `bash` tool definition in the API response (via browser devtools, network tab, look at the `tools` array in the LLM request). | The `bash` tool description does NOT mention `query`, `memorize`, `schedule`, `cancel`, `purge`, `cache-warm`, `cache-pin`, `model-hint`, or `hostinfo`. It DOES mention MCP. |
| 3.3 | If MCP servers are configured: Send: "Use the github tool to search for issues" | Agent dispatches through the bash sandbox to the MCP bridge command. The `bash` tool is used, not a native tool. |

## Phase 4: System Prompt Verification

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Inspect the system prompt from a recent turn via `context_debug` in the `turns` table or direct DB query. | The system prompt contains `"## Orientation"` and `"### Host Identity"`. If MCP servers are connected, it contains `"### Additional MCP Commands"`. It does NOT contain `"### Available Commands"`. |
| 4.2 | Check that the `tools` array in the LLM API request includes all 14 native tools: `schedule`, `cancel`, `query`, `emit`, `await_event`, `purge`, `advisory`, `notify`, `archive`, `model_hint`, `hostinfo`, `memory`, `cache`, `skill`. | All 14 tools present with JSON schema parameters. Each has a `description` and `parameters` object. |

## Phase 5: Relay Inference (Hub-Spoke)

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | On the spoke, send a message that requires relay inference (the model is on the hub). | The message is relayed to the hub. The hub dispatches any native tool calls through its own unified tool registry. The response returns to the spoke via `relay_inbox`. |
| 5.2 | On the spoke, trigger a native tool call that gets relayed. For example: "Schedule a daily health check at 9am" | The hub receives the inference request with the full `tools` array (including `schedule`). The task is created on the hub and syncs back to the spoke. Verify the task appears in `SELECT * FROM tasks` on the spoke after sync. |

## End-to-End: Full Conversation Flow

| Step | Action | Expected |
|------|--------|----------|
| E1 | Create a new thread via the web UI | Thread created |
| E2 | "Remember that my project uses TypeScript 6 and Bun 1.2" | `memory` tool with `action: "store"` |
| E3 | "Schedule a daily code review reminder at 9am" | `schedule` tool with `cron: "0 9 * * *"` |
| E4 | "Query how many tasks are scheduled" | `query` tool with `sql: "SELECT COUNT(*) ..."` |
| E5 | "Create an advisory to upgrade to Bun 1.3 when available" | `advisory` tool |
| E6 | "Search my memories for project setup" | `memory` tool with `action: "search"` |
| E7 | "Cancel the daily reminder" | `cancel` tool |
| E8 | "Archive this thread" | `archive` tool with `thread_id: <current>` |
| E9 | Verify the thread is soft-deleted in DB | `SELECT deleted FROM threads WHERE id = '<thread-id>'` returns `1` |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC6.2 (relay round-trip) | Full relay dispatch requires two running nodes | Deploy spoke + hub. Send message triggering native tool call. Verify via spoke's `messages` table that tool result returned from hub. |
| AC7.1 (CLAUDE.md accuracy) | Documentation accuracy requires human judgment | Read "Tool dispatch priority" section — should describe unified `RegisteredTool` registry. |
| AC7.2 (CONTRIBUTING.md checklist) | Checklist correctness requires human evaluation | Read "Adding an agent tool" section — should describe `RegisteredTool` factory pattern. |
| AC7.3 (stale references) | Grep catches keywords but not semantic accuracy | Run stale-reference grep and read updated design docs. |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1-AC1.7 | `cli/__tests__/tool-registry.test.ts` | — |
| AC2.1 | `tools/__tests__/schedule.test.ts` | Phase 1 Step 1.2 |
| AC2.2 | `tools/__tests__/query.test.ts` | Phase 1 Step 1.3 |
| AC2.3 | `tools/__tests__/cancel.test.ts` | Phase 1 Step 1.4 |
| AC2.4 | `tools/__tests__/emit.test.ts` | — |
| AC2.5 | All 11 per-tool test files | End-to-End |
| AC2.6-AC2.7 | All per-tool test files | — |
| AC3.1-AC3.2 | `tools/__tests__/memory.test.ts` | Phase 1 Steps 1.5-1.6 |
| AC3.3 | `tools/__tests__/cache.test.ts` | Phase 2 Step 2.3 |
| AC3.4 | `tools/__tests__/skill.test.ts` | Phase 2 Step 2.4 |
| AC3.5-AC3.6 | Grouped tool test files | — |
| AC4.1 | `agent/__tests__/commands-directory-structure.test.ts` | — |
| AC4.2 | `cli/__tests__/sandbox-imports.test.ts` | — |
| AC4.3 | `cli/__tests__/sandbox-tool-description.test.ts` | Phase 3 Step 3.2 |
| AC4.4 | `agent/__tests__/mcp-bridge.test.ts` | Phase 3 Step 3.3 |
| AC5.1-AC5.2 | `agent/__tests__/context-assembly.test.ts` | Phase 4 Step 4.1 |
| AC5.3 | `agent/__tests__/mcp-bridge.test.ts` | — |
| AC5.4 | `cli/__tests__/tool-registry.test.ts` | Phase 4 Step 4.2 |
| AC6.1 | `shared/__tests__/relay-schemas.test.ts` | — |
| AC6.2 | `cli/__tests__/tool-registry.test.ts` (partial) | Phase 5 Steps 5.1-5.2 |
| AC7.1-AC7.3 | — | Human Verification |
