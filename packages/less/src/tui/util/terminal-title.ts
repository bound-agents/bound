export interface TerminalTitleStream {
	isTTY?: boolean;
	write(chunk: string): unknown;
}

export interface TerminalTitleEnv {
	TERM?: string;
	/** Set by Windows Terminal for every session it hosts. */
	WT_SESSION?: string;
}

export const SAVE_TERMINAL_TITLE = "\x1b[22;0t";
export const RESTORE_TERMINAL_TITLE = "\x1b[23;0t";

/**
 * OSC 0 with an empty payload. Restore fallback for terminals with no title
 * stack: clearing the title makes the emulator fall back to its own default —
 * the profile name in Windows Terminal, the shell-set title elsewhere — which
 * is what the operator started with in the overwhelmingly common case. It is
 * not a true restore (the pre-boundless string is unrecoverable without the
 * stack), but it beats stranding a dead thread title on the tab.
 */
export const CLEAR_TERMINAL_TITLE = "\x1b]0;\x07";

/**
 * Collapse a bound thread title into an OSC-safe terminal title payload.
 *
 * OSC strings terminate on BEL/ST, and ESC/C0/C1 bytes can smuggle further
 * terminal controls into stdout. Strip them before writing a title derived from
 * synced thread state, then collapse the whitespace left behind so a multi-line
 * title stays a tab label rather than terminal soup.
 */
export function sanitizeTerminalTitle(title: string): string {
	let cleaned = "";
	for (const ch of title) {
		const code = ch.charCodeAt(0);
		cleaned += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
	}

	return cleaned.replace(/\s+/g, " ").trim();
}

export function formatThreadTitleForTerminal(title: string | null | undefined): string {
	return sanitizeTerminalTitle(title ?? "") || "(untitled)";
}

/**
 * Whether a terminal honors the xterm title stack (`CSI 22 t` / `CSI 23 t`).
 *
 * Windows Terminal parses XTWINOPS but implements only a subset of the
 * parameter values (1, 2, 7, 8, 14, 16, 18); 22 and 23 are absent from its
 * `WindowManipulationType` enum, so both the push and the pop are silently
 * swallowed. conhost is no better. Pushing a title we can never pop leaves the
 * tab showing boundless's last thread title after exit, so on Windows we skip
 * the stack entirely and restore by clearing instead.
 */
export function supportsTitleStack(
	platform: NodeJS.Platform = process.platform,
	env: TerminalTitleEnv = {},
): boolean {
	if (platform === "win32") return false;
	// Windows Terminal also hosts WSL sessions, where `platform` is `linux` but
	// the emulator swallowing the sequences is still WinTerm.
	return env.WT_SESSION === undefined;
}

export class TerminalTitleController {
	/** A title was pushed onto the terminal's stack and is waiting to be popped. */
	#pushed = false;
	/** We have written at least one title, so exit owes the terminal a restore. */
	#dirty = false;

	constructor(
		private readonly stream: TerminalTitleStream = process.stdout,
		private readonly env: TerminalTitleEnv = {
			TERM: process.env.TERM,
			WT_SESSION: process.env.WT_SESSION,
		},
		private readonly platform: NodeJS.Platform = process.platform,
	) {}

	set(title: string): void {
		if (!this.shouldWrite()) return;

		if (!this.#pushed && this.titleStackAvailable()) {
			this.write(SAVE_TERMINAL_TITLE);
			this.#pushed = true;
		}

		this.#dirty = true;
		this.write(`\x1b]0;${sanitizeTerminalTitle(title)}\x07`);
	}

	restore(): void {
		if (!this.#dirty || !this.shouldWrite()) return;

		// Pop where the stack exists; otherwise clear so the emulator falls back
		// to its own default title rather than keeping ours.
		this.write(this.#pushed ? RESTORE_TERMINAL_TITLE : CLEAR_TERMINAL_TITLE);
		this.#pushed = false;
		this.#dirty = false;
	}

	private titleStackAvailable(): boolean {
		return supportsTitleStack(this.platform, this.env);
	}

	private shouldWrite(): boolean {
		return this.stream.isTTY === true && this.env.TERM !== "dumb";
	}

	private write(chunk: string): void {
		try {
			this.stream.write(chunk);
		} catch {
			// Terminal-title support is cosmetic. Never make shutdown or startup fail
			// because a terminal rejected a control sequence.
		}
	}
}
