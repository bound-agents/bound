/**
 * Terminal-resize redraw coordination for the `<Static>` scrollback region.
 *
 * THE BUG (input field "leaves junk" on resize): Ink renders the live region
 * through `log-update`, which records `previousLineCount` as the *logical*
 * (`\n`-split) line count of the last frame it wrote. On the next render it
 * erases that many lines with `eraseLines(previousLineCount)`. That count is
 * only correct while the terminal width is unchanged. When the terminal is
 * resized NARROWER, the terminal reflows the already-printed frame: a line that
 * fit in one physical row now wraps to several, so the old frame occupies more
 * physical rows than `previousLineCount`. `eraseLines` then clears too few rows
 * and strands the top of the old input box (border fragments, prompt) above the
 * freshly drawn one — permanent junk, since nothing ever erases it.
 *
 * Ink's own `resized` handler (ink/build/ink.js) only recalculates Yoga layout
 * and re-renders; it never clears the stale frame, so the miscount is baked in.
 *
 * THE FIX: on a *width* change (height-only resizes don't reflow line content,
 * so they never strand anything), debounce to the end of the resize gesture,
 * then wipe the screen + scrollback with `clearTerminal` and force `<Static>`
 * to repaint every committed item from scratch. Repainting through React
 * re-wraps the history at the *new* width — which Ink's own `fullStaticOutput`
 * replay (the overflow branch) cannot do, since that replays the literal
 * strings captured at their original commit widths. History is bounded
 * (initial attach caps at 200 messages), so the one-shot repaint per gesture is
 * cheap.
 */

/**
 * Erase screen + erase scrollback + cursor home. Matches `ansiEscapes.clearTerminal`
 * on non-Windows; inlined to avoid pulling `ansi-escapes` in as a direct dep
 * (it's only a transitive dep of Ink). Windows terminals don't support the
 * `3J` scrollback-erase, so they get screen-erase + home only.
 */
export const CLEAR_TERMINAL =
	process.platform === "win32" ? "\u001B[2J\u001B[0f" : "\u001B[2J\u001B[3J\u001B[H";

/** How long after the last resize event to wait before repainting (gesture settle). */
export const RESIZE_REDRAW_DEBOUNCE_MS = 100;

/** Opaque timer handle — whatever the injected (or global) `setTimeout` returns. */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface ResizeRedrawHandler {
	/** Call on each terminal `resize` event with the current column count. */
	onResize(columns: number): void;
	/** Cancel any pending redraw. Call on unmount. */
	dispose(): void;
}

export interface ResizeRedrawOptions {
	/** Column count at mount, used to detect the first width change. */
	initialColumns: number;
	/** Writes a raw escape sequence to the terminal (e.g. `stdout.write`). */
	write: (data: string) => void;
	/** Forces `<Static>` to repaint from scratch (e.g. bump a key/nonce). */
	redraw: () => void;
	/** Settle window; defaults to {@link RESIZE_REDRAW_DEBOUNCE_MS}. */
	debounceMs?: number;
	/** Clear sequence; defaults to {@link CLEAR_TERMINAL}. */
	clearSequence?: string;
	/** Injectable timer hooks for deterministic tests. */
	setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
	clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * Build a resize→repaint coordinator. Pure of React/Ink so it can be unit
 * tested with injected timers; the host wires `write`/`redraw` to stdout and a
 * `<Static>` key bump and feeds it `stdout.columns` on each `resize` event.
 */
export function createResizeRedrawHandler(opts: ResizeRedrawOptions): ResizeRedrawHandler {
	const debounceMs = opts.debounceMs ?? RESIZE_REDRAW_DEBOUNCE_MS;
	const clearSequence = opts.clearSequence ?? CLEAR_TERMINAL;
	const setT: (fn: () => void, ms: number) => TimerHandle =
		opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
	const clearT: (handle: TimerHandle) => void =
		opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle));

	let lastColumns = opts.initialColumns;
	let pending: TimerHandle | undefined;

	return {
		onResize(columns: number) {
			// Height-only resize: line content does not reflow, so log-update's
			// erase count stays accurate and no junk is stranded. Skip the
			// (expensive) repaint entirely.
			if (columns === lastColumns) return;
			lastColumns = columns;

			if (pending !== undefined) clearT(pending);
			pending = setT(() => {
				pending = undefined;
				// Order matters: wipe the stale frame + history first, THEN trigger
				// the React repaint that re-emits <Static> at the new width.
				opts.write(clearSequence);
				opts.redraw();
			}, debounceMs);
		},
		dispose() {
			if (pending !== undefined) {
				clearT(pending);
				pending = undefined;
			}
		},
	};
}
