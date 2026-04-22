# Command Discovery Redesign Implementation Plan

**Goal:** MCP server-level and proxy commands carry spec-sourced descriptions (with fallback chain) and set `customHelp: true` to opt out of dispatcher `--help` interception.

**Architecture:** Add two getter methods to `MCPClient` to expose the SDK's `InitializeResult` fields. The local MCP command factory in `mcp-bridge.ts` sources descriptions via a 3-tier chain (serverInfo.description -> instructions first sentence -> synthesized tool listing), capped at 80 characters. Remote proxy commands use a synthesized description since they lack server info. Both set `customHelp: true` so the Phase 3 dispatcher interception skips them.

**Tech Stack:** TypeScript 6.x, `@modelcontextprotocol/sdk` v1.28.0, Bun monorepo

**Scope:** 6 phases from original design (phases 1-6). This is phase 2 of 6.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

**Verifies: None** (infrastructure phase — verified operationally via typecheck and manual boot confirmation)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add server info getters to MCPClient

**Files:**
- Modify: `packages/agent/src/mcp-client.ts:80-239` (the `MCPClient` class)

**Implementation:**

The SDK `Client` (imported from `@modelcontextprotocol/sdk/client/index.js`) exposes two methods after `connect()`:
- `getServerVersion(): Implementation | undefined` — returns `{ version, name, description?, websiteUrl?, icons? }`
- `getInstructions(): string | undefined`

The `MCPClient` wrapper has `private client: Client` (line 82) but no public access to these. Add two getter methods after the existing `isConnected()` method (around line 237):

```typescript
/**
 * Get the server's description from its InitializeResult, if available.
 * Only available after connect().
 */
getServerDescription(): string | undefined {
	return this.client.getServerVersion()?.description;
}

/**
 * Get the server's instructions from its InitializeResult, if available.
 * Only available after connect().
 */
getServerInstructions(): string | undefined {
	return this.client.getInstructions();
}
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: Passes. The SDK types confirm these methods exist on `Client`.

**Commit:** Do not commit yet — Task 2 uses these getters.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add description and customHelp to MCP command factories

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts:149-157` (local MCP command factory — the `CommandDefinition` object literal)
- Modify: `packages/agent/src/mcp-bridge.ts:577-585` (remote proxy command factory — the `CommandDefinition` object literal)

**Implementation:**

**Helper function:** Add a `capDescription` utility near the top of `mcp-bridge.ts` (after imports):

```typescript
/** Cap a description string to maxLen characters, truncating with "…" if needed. */
function capDescription(s: string, maxLen = 80): string {
	return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}
```

**Local MCP command factory** (the `generateMCPCommands` function, around line 107-148, which iterates `clients` and builds a `CommandDefinition` per server):

At the construction site where each command's `CommandDefinition` is built (line ~149), the following data is available:
- `client`: `MCPClient` instance (connected, so getters work)
- `serverName`: string
- `dispatchTable`: `Map<string, DispatchEntry>` (the server's tools)

Add description sourcing using the 3-tier fallback chain from the design. Insert this **before** the `CommandDefinition` object literal:

```typescript
// Description sourcing: serverInfo.description -> instructions (first sentence) -> synthesized
let serverDescription: string;
const specDescription = client.getServerDescription();
if (specDescription) {
	serverDescription = capDescription(specDescription);
} else {
	const instructions = client.getServerInstructions();
	if (instructions) {
		// Take first sentence: up to first period+space, period+end, or newline
		const firstSentence = instructions.split(/(?<=\.)\s|\n/)[0] ?? instructions;
		serverDescription = capDescription(firstSentence);
	} else {
		// Synthesized fallback from tool names
		const toolNames = [...dispatchTable.keys()];
		const synthesized = `MCP server exposing ${toolNames.length} tools: ${toolNames.join(", ")}`;
		serverDescription = capDescription(synthesized);
	}
}
```

Then add the two new fields to the `CommandDefinition` object literal:

```typescript
const command: CommandDefinition = {
	name: serverName,
	description: serverDescription,
	customHelp: true,
	args: [
		{
			name: "subcommand",
			required: false,
			description: "Subcommand to run, or omit for usage listing",
		},
	],
	handler: async (/* ... existing handler ... */) => {
		// ... existing handler body unchanged ...
	},
};
```

**Remote MCP proxy command factory** (`generateRemoteMCPProxyCommands`, around line 577):

Remote proxies only have `serverName` and `hostInfo.hostName` — no tool details or server info. Use a synthesized description:

```typescript
const command: CommandDefinition = {
	name: serverName,
	description: capDescription(`Remote MCP server on ${hostInfo.hostName}`),
	customHelp: true,
	args: [
		{
			name: "subcommand",
			required: false,
			description: "Subcommand to run on the remote MCP server",
		},
	],
	handler: async (/* ... existing handler ... */) => {
		// ... existing handler body unchanged ...
	},
};
```

**Verification:**

Run: `bun run typecheck`
Expected: All packages pass. MCP commands now have `description` (satisfying the Phase 1 interface requirement) and `customHelp: true`.

**Commit:** `feat(agent): add MCP command descriptions with spec-sourced fallback chain`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
