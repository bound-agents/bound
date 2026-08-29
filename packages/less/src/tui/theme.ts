import type { TextProps } from "ink";

/**
 * Design tokens for the boundless TUI (#247).
 *
 * Three layers, mirroring the web client's token convention
 * (packages/web/src/client/App.svelte `:root`):
 *
 *   1. `palette`  — raw, terminal-native color values. The only layer that
 *      mentions concrete colors. Values are terminal named colors so they
 *      keep following the user's terminal theme (no hex yet — swapping the
 *      palette for a fixed one is a future theming decision, and this
 *      layering is what enables it without touching components).
 *   2. `semantic` — intent names (ok / warn / err / info / accent / …).
 *      Maps palette entries onto meaning. Two roles sharing a semantic
 *      value today can diverge later by editing one line here.
 *   3. `tokens`   — role names, the ONLY layer components import. One entry
 *      per UI role ("selectionCaret", "agentStripe", "contextGaugeCritical").
 *      Same role ⇒ same token ⇒ same color everywhere, by construction.
 *
 * Components must not import palette/semantic directly and must not hardcode
 * color strings — a color literal in a component is a defect (that is the
 * inconsistency class #247 was filed to end). Tests should assert against
 * token values, not literals, for the same reason.
 *
 * No runtime theming yet (per #247: set up the structure now, enable
 * swapping later) — the indirection through this module is the setup.
 */

type InkColor = NonNullable<TextProps["color"]>;

const palette = {
	foreground: "white",
	red: "red",
	green: "green",
	yellow: "yellow",
	blue: "blue",
	magenta: "magenta",
	cyan: "cyan",
	gray: "gray",
} as const satisfies Record<string, InkColor>;

const semantic = {
	/** Neutral foreground for content that is "just text". */
	foreground: palette.foreground,
	/** Primary identity accent (boundless chrome: stripes, frames, carets). */
	accent: palette.cyan,
	/** Secondary identity accent ("special" surfaces: Yard, the inspector). */
	special: palette.magenta,
	ok: palette.green,
	warn: palette.yellow,
	err: palette.red,
	info: palette.cyan,
	idle: palette.gray,
	/** Third-kind distinction for mixed-kind rows (inference nodes). */
	data: palette.blue,
	muted: palette.gray,
} as const;

export const tokens = {
	// --- Connection / status badges ---
	statusRunning: semantic.ok,
	statusFailed: semantic.err,
	statusDisabled: semantic.idle,
	statusConnected: semantic.ok,
	statusConnecting: semantic.info,
	statusDisconnected: semantic.warn,

	// --- Input frame (tracks connection health) ---
	frameConnected: semantic.accent,
	frameConnecting: semantic.warn,
	frameDisconnected: semantic.err,

	// --- Banners & alert/system transcript turns ---
	bannerError: semantic.err,
	bannerInfo: semantic.info,
	alertStripe: semantic.err,
	systemStripe: semantic.warn,

	// --- Transcript stripes (turn identity) ---
	userStripe: semantic.ok,
	agentStripe: semantic.accent,
	pendingStripe: semantic.idle,

	// --- Result indicators ---
	successIndicator: semantic.ok,
	failureIndicator: semantic.err,
	toolRequestMarker: semantic.accent,

	// --- Selection affordances ---
	// One token for every "this row is selected" caret (picker ›, slash
	// completion ❯, inspector ❯) — #247's original complaint was these
	// drifting apart. Selected-row TEXT may carry a surface identity color
	// instead (the inspector keeps its magenta), but the caret itself is
	// always the shared affordance color.
	selectionCaret: semantic.accent,
	selectedRow: semantic.special,

	// --- Command surface ---
	commandHighlight: semantic.info,
	keyHint: semantic.info,
	modelName: semantic.info,
	modalBorder: semantic.accent,

	// --- Gauges & duration grading ---
	contextGaugeCritical: semantic.err,
	contextGaugeCaution: semantic.warn,
	contextGaugeNormal: semantic.ok,
	durationCaution: semantic.warn,
	durationCritical: semantic.err,

	// --- Yard execution cards ---
	yardStripe: semantic.special,
	yardRunning: semantic.warn,
	phaseCompleted: semantic.ok,
	phaseFailed: semantic.err,
	nodeRun: semantic.special,
	nodeTool: semantic.info,
	nodeInference: semantic.data,

	// --- Markdown rendering ---
	inlineCode: semantic.warn,
	link: semantic.info,
	headingPrimary: semantic.special,
	headingSecondary: semantic.info,
	borderMuted: semantic.muted,

	// --- Inspector list glyphs ---
	userMarker: semantic.ok,
	assistantMarker: semantic.foreground,
	otherRoleMarker: semantic.muted,
	toolCallMarker: semantic.info,
	scrollIndicator: semantic.muted,
	overflowIndicator: semantic.muted,

	// --- Diffs ---
	diffAdded: semantic.ok,
	diffRemoved: semantic.err,

	// --- Misc ---
	backgroundWork: semantic.special,
	brand: semantic.accent,
	activeAnnotation: semantic.ok,
	/** Yellow cautionary notes: empty pickers, disabled tags, hydrate errors. */
	warningNotice: semantic.warn,
} as const;

/** A concrete Ink color value exposed by the current semantic theme. */
export type ThemeColor = (typeof tokens)[keyof typeof tokens];
/** @deprecated Use ThemeColor for color prop values; this alias remains source-compatible. */
export type ColorToken = ThemeColor;

/** The eventual theme-swap surface: a future theme is another object of this shape. */
export type Theme = typeof tokens;
