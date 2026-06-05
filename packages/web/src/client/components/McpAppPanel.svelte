<script lang="ts">
// Commit 4 of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:design-and-progress.
//
// Renders one UI-bearing MCP tool call as an inline app. On mount it reads the
// app's `ui://` resource, builds an AppBridge wired to the in-page MCP SDK
// client, and mounts the app into a single opaque-origin srcdoc iframe (the
// single-origin sandbox model; see project:mcp-apps-web-ui:commit3-sandbox-decision).
// All DOM/iframe wiring is exercised by typecheck + manual smoke — bun:test has
// no DOM env in the web package.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { onDestroy, onMount } from "svelte";
import {
	type AppBridgeCallbacks,
	getUiResource,
	mountApp,
	newAppBridge,
} from "../lib/mcp-app-bridge";
import { type McpAppInstance, mcpAppInstances } from "../lib/mcp-app-store";

const { instance }: { instance: McpAppInstance } = $props();

let iframeEl = $state<HTMLIFrameElement | null>(null);
let status = $state<"loading" | "ready" | "error">("loading");
let errorMessage = $state<string | null>(null);
let displayMode = $state<"inline" | "fullscreen">("inline");

// The AppBridge holds the live transport; closed on teardown.
let bridge: { close: () => void } | null = null;

onMount(async () => {
	const iframe = iframeEl;
	if (!iframe) return;
	try {
		// instance.client is the in-page SDK Client (registered as McpClientLike at
		// the host; it also satisfies UiResourceClient and AppBridge's Client).
		const sdkClient = instance.client as unknown as Client;
		const resource = await getUiResource(sdkClient, instance.uiResourceUri);

		const callbacks: AppBridgeCallbacks = {
			onDisplayModeChange: (mode) => {
				displayMode = mode;
			},
		};
		const appBridge = newAppBridge(sdkClient, iframe, callbacks, { displayMode });
		bridge = appBridge;

		await mountApp(iframe, appBridge, {
			resource,
			// $state.snapshot strips the Svelte reactive Proxy off the props-derived
			// input. postMessage uses structured clone, which throws DataCloneError
			// on a Proxy — so without this the app never receives its arguments.
			input: $state.snapshot(instance.input) as Record<string, unknown>,
			resultPromise: instance.resultPromise,
		});
		status = "ready";
	} catch (err) {
		status = "error";
		errorMessage = err instanceof Error ? err.message : String(err);
	}
});

onDestroy(() => {
	bridge?.close();
});

/** Dismiss the panel: tear down the bridge and drop the instance from the store. */
function close() {
	bridge?.close();
	bridge = null;
	mcpAppInstances.remove(instance.callId);
}
</script>

<div class="mcp-app" class:fullscreen={displayMode === "fullscreen"}>
	<div class="app-head">
		<span class="kicker">App · {instance.serverName}</span>
		<div class="head-right">
			{#if status === "loading"}
				<span class="state mono">Loading…</span>
			{:else if status === "error"}
				<span class="state state-error mono">Failed</span>
			{/if}
			{#if displayMode === "fullscreen"}
				<button type="button" class="head-btn" onclick={() => (displayMode = "inline")}>
					Exit fullscreen
				</button>
			{/if}
			<button type="button" class="head-btn close" onclick={close} aria-label="Close app">✕</button>
		</div>
	</div>

	{#if status === "error"}
		<div class="app-error">
			<p>Could not render this app.</p>
			<code>{errorMessage}</code>
		</div>
	{/if}

	<!-- Opaque-origin sandbox: no allow-same-origin. srcdoc + sandbox/allow attrs
	     are set imperatively in mountApp so they apply before the app loads. -->
	<iframe
		bind:this={iframeEl}
		class="app-frame"
		class:hidden={status === "error"}
		title={`MCP App: ${instance.boundName}`}
		sandbox="allow-scripts allow-forms"
	></iframe>
</div>

<style>
	.mcp-app {
		border: 1px solid var(--rule-soft);
		background: var(--paper);
		margin: 10px 0;
		overflow: hidden;
	}

	.mcp-app.fullscreen {
		position: fixed;
		inset: 0;
		z-index: 50;
		margin: 0;
		border: none;
	}

	.app-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 12px;
		border-bottom: 1px solid var(--rule-faint);
		background: var(--paper-2);
	}

	/* In fullscreen the head must sit above the iframe so its controls stay
	   clickable (the frame would otherwise paint over them). */
	.mcp-app.fullscreen .app-head {
		position: relative;
		z-index: 1;
	}

	.head-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.head-btn {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1;
		padding: 4px 8px;
		border: 1px solid var(--rule-soft);
		border-radius: 3px;
		background: var(--paper);
		color: var(--ink-2);
		cursor: pointer;
	}

	.head-btn:hover {
		background: var(--paper-2);
		color: var(--ink-1);
	}

	.head-btn.close {
		padding: 4px 7px;
	}

	.kicker {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.state {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-4);
	}

	.state-error {
		color: var(--danger, #c0392b);
	}

	.app-error {
		padding: 14px 16px;
		font-size: 13px;
		color: var(--ink-2);
	}

	.app-error code {
		display: block;
		margin-top: 6px;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--ink-3);
		word-break: break-word;
	}

	.app-frame {
		display: block;
		width: 100%;
		min-height: 320px;
		border: none;
		background: var(--paper);
	}

	.mcp-app.fullscreen .app-frame {
		height: 100%;
	}

	.app-frame.hidden {
		display: none;
	}
</style>
