export interface TerminalTitleStream {
	isTTY?: boolean;
	write(chunk: string): unknown;
}

export interface TerminalTitleEnv {
	TERM?: string;
}

export const SAVE_TERMINAL_TITLE = "\x1b[22;0t";
export const RESTORE_TERMINAL_TITLE = "\x1b[23;0t";

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

export class TerminalTitleController {
	#saved = false;

	constructor(
		private readonly stream: TerminalTitleStream = process.stdout,
		private readonly env: TerminalTitleEnv = { TERM: process.env.TERM },
	) {}

	set(title: string): void {
		if (!this.shouldWrite()) return;

		if (!this.#saved) {
			this.write(SAVE_TERMINAL_TITLE);
			this.#saved = true;
		}

		this.write(`\x1b]0;${sanitizeTerminalTitle(title)}\x07`);
	}

	restore(): void {
		if (!this.#saved || !this.shouldWrite()) return;
		this.write(RESTORE_TERMINAL_TITLE);
		this.#saved = false;
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
