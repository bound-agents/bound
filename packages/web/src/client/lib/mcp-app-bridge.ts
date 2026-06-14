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
	type McpUiAppCapabilities,
	type McpUiHostStyles,
	type McpUiResourceCsp,
	type McpUiResourcePermissions,
	type McpUiStyleVariableKey,
	type McpUiStyles,
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
	/**
	 * The view's visual-boundary preference (ext-apps `McpUiResourceMeta.prefersBorder`).
	 * `true` → the view wants the host to paint a visible border + background; `false`
	 * → the view paints its own chrome and wants the host to paint neither; `undefined`
	 * → host decides. GitHub's apps stamp `false`, which is why an unmodified host that
	 * still paints a frame + full-width backdrop leaves the narrow card on a wide canvas.
	 */
	prefersBorder?: boolean;
}

/** ext-apps `_meta.ui` shape we read CSP/permissions/prefersBorder from. */
interface UiMeta {
	csp?: McpUiResourceCsp;
	permissions?: McpUiResourcePermissions;
	prefersBorder?: boolean;
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

	return {
		html,
		csp: uiMeta?.csp,
		permissions: uiMeta?.permissions,
		prefersBorder: uiMeta?.prefersBorder,
	};
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
 * Map of ext-apps host-style variable → the bound CSS custom property whose
 * resolved value fills it. The `McpUiStyleVariableKey` vocabulary is a fixed set
 * an app's CSS reads (`var(--color-background-primary)` etc.); we publish bound's
 * signage palette into it so a well-behaved app themes itself to host chrome
 * instead of falling back to its own (usually stark white) defaults. Only the
 * subset bound has a faithful token for is mapped — unmapped keys are omitted, so
 * the app keeps its own default for those rather than receiving a wrong colour.
 */
const HOST_STYLE_VAR_MAP: ReadonlyArray<readonly [McpUiStyleVariableKey, string]> = [
	["--color-background-primary", "--paper"],
	["--color-background-secondary", "--paper-2"],
	["--color-background-tertiary", "--paper-3"],
	["--color-text-primary", "--ink"],
	["--color-text-secondary", "--ink-2"],
	["--color-text-tertiary", "--ink-3"],
	["--color-text-disabled", "--ink-4"],
	["--color-border-primary", "--rule-soft"],
	["--color-border-secondary", "--rule-faint"],
	["--color-text-danger", "--err"],
	["--color-text-success", "--ok"],
	["--color-text-warning", "--warn"],
	["--font-sans", "--font-body"],
	["--font-mono", "--font-mono"],
];

/**
 * Build the host `styles.variables` payload from a CSS-var reader. Pure: the
 * caller supplies `read` (a `getComputedStyle` wrapper in the browser, a fake in
 * tests). Blank/missing values are trimmed and dropped so the app only receives
 * tokens the host actually defines.
 */
export function buildHostStyles(read: (cssVar: string) => string): McpUiHostStyles {
	const variables: Record<string, string> = {};
	for (const [hostKey, boundVar] of HOST_STYLE_VAR_MAP) {
		const value = read(boundVar).trim();
		if (value) variables[hostKey] = value;
	}
	return { variables: variables as McpUiStyles };
}

/** Host platform + device-capability signals for an app's responsive layout. */
export interface DeviceContext {
	platform: "web" | "mobile";
	deviceCapabilities: { touch: boolean; hover: boolean };
}

/**
 * Derive platform + device capabilities from media-query results. Pure: the
 * caller evaluates the queries (`matchMedia` in the browser, fakes in tests). A
 * coarse primary pointer that cannot hover is the touch-first signal we report as
 * `platform: "mobile"` so apps choose their compact layout; everything else stays
 * `"web"` (a touch laptop reports both, and is not "mobile"). `"desktop"` is
 * reserved for native desktop hosts, which the browser UI is not.
 */
export function buildDeviceContext(mq: { coarsePointer: boolean; hover: boolean }): DeviceContext {
	const { coarsePointer: touch, hover } = mq;
	return {
		platform: touch && !hover ? "mobile" : "web",
		deviceCapabilities: { touch, hover },
	};
}

/** Read bound's live palette off the document root into a host-styles payload. */
function readHostStylesFromDom(): McpUiHostStyles {
	if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
		return { variables: {} as McpUiStyles };
	}
	const cs = getComputedStyle(document.documentElement);
	return buildHostStyles((cssVar) => cs.getPropertyValue(cssVar));
}

/** Probe the browser's pointer/hover media queries into a device context. */
function readDeviceContextFromDom(): DeviceContext {
	const mm = typeof matchMedia === "function" ? matchMedia : null;
	return buildDeviceContext({
		coarsePointer: mm ? mm("(pointer: coarse)").matches : false,
		// Default to hover-capable when matchMedia is unavailable so we don't
		// misreport a headless/SSR context as a touch device.
		hover: mm ? mm("(hover: hover)").matches : true,
	});
}

/**
 * Construct an AppBridge for an app iframe, wired to the in-page MCP client and
 * with host-side handlers registered. Handlers are attached before connect() so
 * the app can issue requests immediately after the init handshake. A
 * ResizeObserver keeps the app informed of container width; it is disconnected
 * on bridge close.
 */
/**
 * Whether the host should offer a fullscreen control for a given app, gated on
 * the app's own declared capabilities. The app reports the display modes it
 * supports via `McpUiAppCapabilities.availableDisplayModes` in its `ui/initialize`
 * request; the host-side AppBridge surfaces them through `getAppCapabilities()`
 * once `oninitialized` fires. We only paint the Fullscreen button when the app
 * declared "fullscreen" — GitHub's `get_me`, for instance, declares only
 * `["inline"]` (the SDK default it never widened), so it gets no button.
 * Default-deny: undefined capabilities (handshake not yet complete) hide it.
 */
export function appSupportsFullscreen(caps: McpUiAppCapabilities | undefined): boolean {
	return caps?.availableDisplayModes?.includes("fullscreen") ?? false;
}

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
	const device = readDeviceContextFromDom();
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
				platform: device.platform,
				deviceCapabilities: device.deviceCapabilities,
				styles: readHostStylesFromDom(),
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

	appBridge.onsizechange = async ({ height }) => {
		// We deliberately ignore the reported `width`. The SDK's default auto-resize
		// (App.setupSizeChangedNotifications) measures content HEIGHT honestly, but
		// reports `width: window.innerWidth` — the iframe's own inner width, i.e. the
		// width the host already handed it, not the content's intrinsic width. There
		// is therefore no content-width signal to shrink the frame to. Inline width is
		// a host-policy decision: the CSS caps `.mcp-app` to a readable column so a
		// narrow app refits instead of floating in a full-column iframe.
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
