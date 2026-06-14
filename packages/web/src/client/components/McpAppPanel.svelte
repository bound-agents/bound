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
import { client } from "../lib/bound";
import {
	type AppBridgeCallbacks,
	type ContainerState,
	appSupportsFullscreen,
	applyViewportBudget,
	formatAppContentToMessage,
	getUiResource,
	mountApp,
	newAppBridge,
} from "../lib/mcp-app-bridge";
import type { McpAppInstance } from "../lib/mcp-app-store";

const { instance }: { instance: McpAppInstance } = $props();

let panelEl = $state<HTMLDivElement | null>(null);
let iframeEl = $state<HTMLIFrameElement | null>(null);
let status = $state<"loading" | "ready" | "error">("loading");
let errorMessage = $state<string | null>(null);
// The panel renders INLINE in the conversation stream and scrolls away with the
// chat (it lives inside MessageList's scroll container). "Fullscreen" is a real
// fullscreen — the native Fullscreen API promotes panelEl to the browser's top
// layer, which is immune to the transformed-ancestor containing-block trap that
// made the old `position: fixed` overlay fill only the top half. Crucially the
// API does NOT move the iframe in the DOM, so the app doesn't reload / lose
// canvas state on enter or exit.
let isFullscreen = $state(false);
// The view's visual-boundary preference (ext-apps `McpUiResourceMeta.prefersBorder`,
// read off the UI resource in onMount). `false` → the view paints its own chrome and
// asks the host to paint NO border and NO background; we honor that by going chromeless
// so the app's card sits directly on the chat flow instead of on a host-painted panel
// (the "narrow card on a wide backdrop" the GitHub apps showed). `true`/undefined keep
// the default bordered card.
let prefersBorder = $state<boolean | undefined>(undefined);
// Whether to offer the Fullscreen control, gated on the app's declared
// `availableDisplayModes` (read from getAppCapabilities() after the ui/initialize
// handshake). Default-deny: an app that declares only "inline" — like GitHub's
// get_me — never gets the button, and the button stays hidden until the handshake
// lands. See appSupportsFullscreen in mcp-app-bridge.
let canFullscreen = $state(false);

// Inline panels are capped to a fraction of the viewport so a wide chat column
// can't make the app report (and the iframe grow to) a runaway height. The
// budget is a plain mutable object the bridge reads on every resize/size-change;
// fullscreen swaps the ceiling to the full viewport and hands height back to CSS.
const INLINE_MAX_VH = 0.6;
function viewportHeight(): number {
	return globalThis.window?.innerHeight ?? 800;
}
function inlineMaxHeight(): number {
	return Math.round(viewportHeight() * INLINE_MAX_VH);
}
const containerState: ContainerState = { maxHeight: inlineMaxHeight(), fullscreen: false };

// The AppBridge holds the live transport; closed on teardown. Typed via
// ReturnType so applyViewportBudget can re-send host context without importing
// the AppBridge class into this component.
let bridge: ReturnType<typeof newAppBridge> | null = null;

function syncFullscreen(): void {
	const fs = document.fullscreenElement === panelEl;
	isFullscreen = fs;
	containerState.fullscreen = fs;
	containerState.maxHeight = fs ? viewportHeight() : inlineMaxHeight();
	if (bridge) applyViewportBudget(bridge, containerState);
}

async function toggleFullscreen(): Promise<void> {
	try {
		if (document.fullscreenElement === panelEl) {
			await document.exitFullscreen();
		} else {
			// requestFullscreen needs user activation — this runs from a click, so
			// it's satisfied. Bridge-driven requests (no gesture) are caught below.
			await panelEl?.requestFullscreen();
		}
	} catch {
		// Browser refused (no activation, or feature blocked). Leave inline.
	}
}

onMount(async () => {
	const iframe = iframeEl;
	if (!iframe) return;
	document.addEventListener("fullscreenchange", syncFullscreen);
	try {
		// instance.client is the in-page SDK Client (registered as McpClientLike at
		// the host; it also satisfies UiResourceClient and AppBridge's Client).
		const sdkClient = instance.client as unknown as Client;
		const resource = await getUiResource(sdkClient, instance.uiResourceUri);
		prefersBorder = resource.prefersBorder;

		// An app pushing content back to the model splits by intent. An explicit
		// `ui/message` (onMessage) is `ui/message` semantics: persist a real user
		// turn AND drive inference now, via client.sendMessage. A
		// `ui/update-model-context` (onContextUpdate) is staging: persist a
		// developer-role context message WITHOUT firing a turn, via
		// client.stageContext — it merges into the NEXT user turn (invariant #9),
		// so the update is silent until the user next interacts, and an orphan
		// stage with no following turn is naturally dropped. The source tag lets
		// the model distinguish app-originated input from the user typing.
		const sendToThread = (text: string): void => {
			if (!text) return;
			client.sendMessage(instance.threadId, `[${instance.serverName} app] ${text}`);
		};
		const stageToThread = (text: string): void => {
			if (!text) return;
			client.stageContext(instance.threadId, `[${instance.serverName} app] ${text}`);
		};
		const callbacks: AppBridgeCallbacks = {
			onMessage: (message) => {
				sendToThread(formatAppContentToMessage({ content: message.content }));
			},
			onContextUpdate: (context) => {
				if (!context) return;
				stageToThread(
					formatAppContentToMessage({
						content: context.content,
						structuredContent: context.structuredContent,
					}),
				);
			},
			onDisplayModeChange: (mode) => {
				// The app asked to change display mode. Drive native fullscreen to
				// match; if there's no user activation the request is caught and the
				// panel stays inline (the header button is the reliable path).
				if (mode === "fullscreen" && document.fullscreenElement !== panelEl) {
					void toggleFullscreen();
				} else if (mode === "inline" && document.fullscreenElement === panelEl) {
					void document.exitFullscreen().catch(() => {});
				}
			},
		};
		const appBridge = newAppBridge(sdkClient, iframe, callbacks, {
			displayMode: "inline",
			containerState,
		});
		bridge = appBridge;

		await mountApp(iframe, appBridge, {
			resource,
			// $state.snapshot strips the Svelte reactive Proxy off the props-derived
			// input. postMessage uses structured clone, which throws DataCloneError
			// on a Proxy — so without this the app never receives its arguments.
			input: $state.snapshot(instance.input) as Record<string, unknown>,
			resultPromise: instance.resultPromise,
		});
		// mountApp resolves only after the ui/initialize handshake, so the app's
		// declared capabilities are populated now. Gate the Fullscreen control on
		// what the app actually supports rather than offering it unconditionally.
		canFullscreen = appSupportsFullscreen(appBridge.getAppCapabilities());
		status = "ready";
	} catch (err) {
		status = "error";
		errorMessage = err instanceof Error ? err.message : String(err);
	}
});

onDestroy(() => {
	document.removeEventListener("fullscreenchange", syncFullscreen);
	bridge?.close();
});
</script>

<div
	class="mcp-app"
	class:fullscreen={isFullscreen}
	class:chromeless={prefersBorder === false}
	bind:this={panelEl}
>
	<div class="app-head">
		<span class="kicker">App · {instance.serverName}</span>
		<div class="head-right">
			{#if status === "loading"}
				<span class="state mono">Loading…</span>
			{:else if status === "error"}
				<span class="state state-error mono">Failed</span>
			{/if}
			<button type="button" class="head-btn" onclick={toggleFullscreen}>
				{isFullscreen ? "Exit fullscreen" : "Fullscreen"}
			</button>
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
		/* Inline width is host policy, not an app signal: the ext-apps auto-resize
		   reports `width: window.innerWidth` (the width we already handed the frame),
		   never the card's intrinsic width, so a full-column iframe leaves a narrow
		   app stranded in dead space. Cap to a readable column — a narrow app refits
		   inside it (the next size-change echoes the smaller innerWidth), and a wide
		   app is bounded the same as message text. Fullscreen overrides below. */
		max-width: 640px;
	}

	/* The view declared `prefersBorder: false` (ext-apps McpUiResourceMeta): it
	   paints its own chrome and asks the host to paint NO border + NO background.
	   We honor that by stripping the container frame, the frame backdrop, and the
	   header's card styling, so the app's own card sits directly on the chat flow
	   instead of on a host-painted panel (which is what left a narrow card on a
	   wide --paper backdrop). Fullscreen still gets its background from the
	   :fullscreen rule below, which wins by specificity. */
	.mcp-app.chromeless {
		border: none;
		background: transparent;
		overflow: visible;
	}

	.mcp-app.chromeless .app-frame {
		background: transparent;
	}

	.mcp-app.chromeless .app-head {
		border-bottom: none;
		background: transparent;
	}

	.app-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 12px;
		border-bottom: 1px solid var(--rule-faint);
		background: var(--paper-2);
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

	/* Real fullscreen via the native Fullscreen API. The :fullscreen element is
	   promoted to the browser's top layer (immune to the transformed-ancestor
	   containing-block trap that made the old position:fixed overlay fill only
	   the top half), and the iframe is NOT moved in the DOM, so the app keeps its
	   canvas state across enter/exit. Lay the panel out as a column so the frame
	   fills all the space below the header. */
	.mcp-app:fullscreen {
		width: 100vw;
		height: 100vh;
		max-width: none;
		margin: 0;
		display: flex;
		flex-direction: column;
		background: var(--paper);
	}

	.mcp-app:fullscreen .app-frame {
		flex: 1;
		min-height: 0;
		height: 100%;
	}

	.app-frame.hidden {
		display: none;
	}
</style>
