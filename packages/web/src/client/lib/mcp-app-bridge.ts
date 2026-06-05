// Commit 3 of the MCP-Apps-in-web-UI feature: see project memory
// project:mcp-apps-web-ui:commit3-sandbox-decision.
//
// Host-side glue that renders an MCP App in the bound web UI and wires its
// ext-apps AppBridge to the in-page MCP SDK client. Adapted from the ext-apps
// reference (examples/basic-host/src/implementation.ts) with one structural
// change for our single-origin (:3001) constraint: there is NO separate
// sandbox-proxy document. The reference double-iframes because its proxy lives
// on a second origin; under a single origin the proxy must be sandboxed to an
// opaque origin, which forces the nested app frame opaque too (sandbox flags
// are inherited + intersected) — so the proxy adds a relay hop and zero extra
// isolation. We render the app directly in ONE iframe with
// sandbox="allow-scripts allow-forms" (opaque origin, isolated from :3001) and
// deliver the app HTML via srcdoc. The host<->app channel is the MCP-Apps
// postMessage protocol (ext-apps PostMessageTransport validates window identity
// via event.source, which works against an opaque-origin frame).
//
// The DOM/iframe wiring (newAppBridge, mountApp) is exercised by typecheck +
// manual smoke; getUiResource is DOM-free and unit tested.
import {
	AppBridge,
	type McpUiResourceCsp,
	type McpUiResourcePermissions,
	PostMessageTransport,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { APP_FRAME_SANDBOX, buildAppFrameSrcdoc, frameAllowAttribute } from "./mcp-app-frame";

const IMPLEMENTATION = { name: "bound web MCP Apps host", version: "1.0.0" };

/** The UI resource payload backing an MCP App, extracted from `resources/read`. */
export interface UiResourceData {
	html: string;
	csp?: McpUiResourceCsp;
	permissions?: McpUiResourcePermissions;
}

/** ext-apps `_meta.ui` shape we read CSP/permissions from. */
interface UiMeta {
	csp?: McpUiResourceCsp;
	permissions?: McpUiResourcePermissions;
}

interface ResourceContent {
	mimeType?: string;
	text?: string;
	blob?: string;
	_meta?: { ui?: UiMeta };
	/** Python SDK quirk: some servers emit `meta` instead of `_meta`. */
	meta?: { ui?: UiMeta };
}

/**
 * Minimal resource-reading surface getUiResource depends on. The real
 * `@modelcontextprotocol/sdk` `Client` satisfies this; tests inject a fake.
 */
export interface UiResourceClient {
	readResource(params: { uri: string }): Promise<{ contents: ResourceContent[] }>;
}

/**
 * Read and validate an MCP App UI resource. Per the MCP Apps spec the resource
 * must be a single `text/html;profile=mcp-app` content; CSP and permissions are
 * read from `_meta.ui` (content-level takes precedence over the optional
 * listing-level meta passed by the caller). Throws on a missing/multi/wrong-mime
 * resource so the caller can surface the failure rather than render garbage.
 */
export async function getUiResource(
	client: UiResourceClient,
	uri: string,
	listingUiMeta?: UiMeta,
): Promise<UiResourceData> {
	const resource = await client.readResource({ uri });
	if (!resource) {
		throw new Error(`Resource not found: ${uri}`);
	}
	if (resource.contents.length !== 1) {
		throw new Error(`Expected exactly one resource content, got ${resource.contents.length}`);
	}

	const content = resource.contents[0];
	if (content.mimeType !== RESOURCE_MIME_TYPE) {
		throw new Error(`Unsupported MIME type for MCP App resource: ${content.mimeType}`);
	}

	const html = content.blob != null ? atob(content.blob) : (content.text ?? "");

	// Content-level meta wins; fall back to listing-level. Accept the Python
	// SDK's `meta` spelling alongside the spec `_meta`.
	const contentMeta = content._meta ?? content.meta;
	const uiMeta = contentMeta?.ui ?? listingUiMeta;

	return { html, csp: uiMeta?.csp, permissions: uiMeta?.permissions };
}

export type ModelContext = Parameters<NonNullable<AppBridge["onupdatemodelcontext"]>>[0];
export type AppMessage = Parameters<NonNullable<AppBridge["onmessage"]>>[0];

/**
 * Flatten an app's outbound content (a `ui/message` or `ui/update-model-context`
 * payload) into a single text string suitable for `client.sendMessage`. The host
 * injects this as a thread message so the model sees what the app sent — the only
 * path that makes an app multi-turn, since bound has no ambient context store and
 * a thread message is what drives the next turn.
 *
 * Text blocks pass through joined by blank lines; non-text blocks are labelled by
 * type rather than silently dropped (so the model knows an image/resource was
 * produced); `structuredContent` is appended as a fenced JSON block for the
 * machine-readable case. Returns "" when there is nothing to send, so callers can
 * skip the round-trip.
 */
export function formatAppContentToMessage(payload: {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}): string {
	const parts: string[] = [];
	for (const block of payload.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else {
			parts.push(`[${block.type} content]`);
		}
	}
	if (payload.structuredContent && Object.keys(payload.structuredContent).length > 0) {
		parts.push(`\`\`\`json\n${JSON.stringify(payload.structuredContent, null, 2)}\n\`\`\``);
	}
	return parts.join("\n\n");
}

export interface AppBridgeCallbacks {
	onContextUpdate?: (context: ModelContext | null) => void;
	onMessage?: (message: AppMessage) => void;
	onDisplayModeChange?: (mode: "inline" | "fullscreen") => void;
}

export interface AppBridgeOptions {
	theme?: "light" | "dark";
	displayMode?: "inline" | "fullscreen";
	containerDimensions?: { maxHeight?: number; width?: number };
	/**
	 * Live, host-owned viewport budget. `maxHeight` is the px ceiling the app is
	 * told to lay out within (and the inline iframe height is clamped to); the
	 * host mutates it — and `fullscreen` — in place when the panel toggles
	 * fullscreen, so the ResizeObserver and `onsizechange` read the current
	 * budget without rebuilding the bridge. Without a real ceiling the app reports
	 * a height proportional to the (wide) container width and the inline iframe
	 * runs away vertically — "the wider the chat, the worse it gets".
	 */
	containerState?: ContainerState;
}

/** Mutable viewport budget shared between the panel and its AppBridge. */
export interface ContainerState {
	/** Px ceiling for the inline iframe height + the app's layout budget. */
	maxHeight: number;
	/** When true, native fullscreen owns the frame height (CSS, not inline). */
	fullscreen: boolean;
}

/** Default inline ceiling when the host supplies neither state nor dimensions. */
const DEFAULT_MAX_HEIGHT = 6000;

/**
 * Push an updated viewport budget to a live app. Mutates `state` in place (the
 * ResizeObserver and `onsizechange` closures read the same object) and re-sends
 * host context so the app re-lays-out to the new ceiling — used when the panel
 * enters/exits fullscreen.
 */
export function applyViewportBudget(appBridge: AppBridge, state: ContainerState): void {
	appBridge.sendHostContextChange({
		displayMode: state.fullscreen ? "fullscreen" : "inline",
		containerDimensions: { maxHeight: state.maxHeight },
	});
}

/**
 * Construct an AppBridge for an app iframe, wired to the in-page MCP client and
 * with host-side handlers registered. Handlers are attached before connect() so
 * the app can issue requests immediately after the init handshake. A
 * ResizeObserver keeps the app informed of container width; it is disconnected
 * on bridge close.
 */
export function newAppBridge(
	client: Client,
	iframe: HTMLIFrameElement,
	callbacks?: AppBridgeCallbacks,
	options?: AppBridgeOptions,
): AppBridge {
	const caps = client.getServerCapabilities();
	const containerState: ContainerState = options?.containerState ?? {
		maxHeight: options?.containerDimensions?.maxHeight ?? DEFAULT_MAX_HEIGHT,
		fullscreen: options?.displayMode === "fullscreen",
	};
	const appBridge = new AppBridge(
		client,
		IMPLEMENTATION,
		{
			openLinks: {},
			serverTools: caps?.tools,
			serverResources: caps?.resources,
			updateModelContext: { text: {} },
		},
		{
			hostContext: {
				theme: options?.theme ?? "light",
				platform: "web",
				containerDimensions: { maxHeight: containerState.maxHeight },
				displayMode: options?.displayMode ?? "inline",
				availableDisplayModes: ["inline", "fullscreen"],
			},
		},
	);

	const resizeObserver = new ResizeObserver(([entry]) => {
		const width = Math.round(entry.contentRect.width);
		if (width > 0) {
			appBridge.sendHostContextChange({
				containerDimensions: { width, maxHeight: containerState.maxHeight },
			});
		}
	});
	resizeObserver.observe(iframe);
	const prevOnclose = appBridge.onclose;
	appBridge.onclose = () => {
		resizeObserver.disconnect();
		prevOnclose?.();
	};

	appBridge.onmessage = async (params) => {
		callbacks?.onMessage?.(params);
		return {};
	};

	appBridge.onopenlink = async (params) => {
		window.open(params.url, "_blank", "noopener,noreferrer");
		return {};
	};

	appBridge.onupdatemodelcontext = async (params) => {
		const hasContent = !!params.content && params.content.length > 0;
		const hasStructured =
			!!params.structuredContent && Object.keys(params.structuredContent).length > 0;
		callbacks?.onContextUpdate?.(hasContent || hasStructured ? params : null);
		return {};
	};

	appBridge.onsizechange = async ({ width, height }) => {
		if (width !== undefined) {
			iframe.style.minWidth = `min(${width}px, 100%)`;
		}
		if (containerState.fullscreen) {
			// In fullscreen the CSS (`height: 100%` under a flex column) owns the
			// frame height; an inline style would fight it.
			iframe.style.height = "";
		} else if (height !== undefined) {
			// Inline: never honor a reported height past the host's viewport budget
			// — that's the runaway where a wide container yields a tall iframe.
			iframe.style.height = `${Math.min(height, containerState.maxHeight)}px`;
		}
	};

	appBridge.onrequestdisplaymode = async (params) => {
		const newMode = params.mode === "fullscreen" ? "fullscreen" : "inline";
		appBridge.sendHostContextChange({ displayMode: newMode });
		callbacks?.onDisplayModeChange?.(newMode);
		return { mode: newMode };
	};

	return appBridge;
}

/** Inputs needed to drive one tool call's app render. */
export interface MountAppParams {
	resource: UiResourceData;
	input: Record<string, unknown>;
	resultPromise: Promise<CallToolResult>;
}

/**
 * Mount an MCP App into an iframe under the single-origin sandbox model and run
 * the tool-call handshake. Order matters: sandbox/allow attributes are set
 * before navigation so they apply to the loaded document; the AppBridge
 * transport starts listening before srcdoc is assigned so the app's
 * `ui/initialize` (sent on load) is not missed. The iframe's WindowProxy is
 * stable across the srcdoc navigation, so the transport's source-identity check
 * keeps matching. Once the app reports initialized, tool input is sent and the
 * tool result (or cancellation) is forwarded when the call settles.
 */
export async function mountApp(
	iframe: HTMLIFrameElement,
	appBridge: AppBridge,
	{ resource, input, resultPromise }: MountAppParams,
): Promise<void> {
	if (iframe.srcdoc) return; // already mounted

	iframe.setAttribute("sandbox", APP_FRAME_SANDBOX);
	const allow = frameAllowAttribute(resource.permissions);
	if (allow) iframe.setAttribute("allow", allow);

	const initialized = new Promise<void>((resolve) => {
		const handler = () => {
			appBridge.removeEventListener("initialized", handler);
			resolve();
		};
		appBridge.addEventListener("initialized", handler);
	});

	const contentWindow = iframe.contentWindow;
	if (!contentWindow) {
		throw new Error("App iframe has no contentWindow; attach it to the DOM before mounting.");
	}

	// Start the transport listener BEFORE the app loads.
	await appBridge.connect(new PostMessageTransport(contentWindow, contentWindow));

	// Navigate the (already-sandboxed) frame to the app HTML.
	iframe.srcdoc = buildAppFrameSrcdoc(resource.html, resource.csp);

	await initialized;

	appBridge.sendToolInput({ arguments: input });
	resultPromise.then(
		(result) => appBridge.sendToolResult(result),
		(error) =>
			appBridge.sendToolCancelled({
				reason: error instanceof Error ? error.message : String(error),
			}),
	);
}
