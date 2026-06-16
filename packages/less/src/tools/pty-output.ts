/**
 * ConPTY output normalization for the Windows IsolationSession sandbox backend.
 *
 * The IsolationSession exec path runs commands through node-pty, which on Windows
 * drives a ConPTY (pseudo-console). Unlike the piped POSIX backends, ConPTY does
 * not emit a clean command-output stream — it paints a full terminal VIEWPORT:
 * an init handshake, a screen-clear (`ESC[2J`), an OSC window-title sequence
 * naming the exec binary, then one `ESC[K` erase-line per viewport row (dozens of
 * them), and only after all that the real command output. Left raw, every byte of
 * that terminal-control noise lands in the captured stdout the model reads.
 *
 * {@link createPtyOutputCleaner} returns a STATEFUL cleaner — one per exec,
 * because it buffers an escape sequence split across chunk boundaries and tracks
 * whether real content has begun. It:
 *   1. strips ANSI/OSC control sequences,
 *   2. normalizes CRLF to LF,
 *   3. suppresses the leading run of blank lines the viewport-clear paints, up to
 *      the first real output — while preserving blank lines AFTER real content
 *      (those are the command's own output, not viewport noise).
 *
 * Pure and SDK-free so it can be unit tested against captured ConPTY fixtures
 * without a live sandbox.
 */

// OSC (Operating System Command): `ESC]` … terminated by BEL (`\u0007`) or
// ST (`ESC\`). Its payload is ARBITRARY text — ConPTY uses it for the window
// title, which on Windows is a full path (backslashes, spaces, a drive colon).
// A fixed-charset matcher (e.g. ansi-regex's OSC branch) leaks such titles, so
// this matches any payload up to the terminator. Stripped before CSI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the entire purpose
const OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

// CSI (`ESC[`) and other escape sequences: cursor moves, screen/line clears,
// mode sets (`?25l`), SGR colors. Payload here IS a constrained charset, so the
// standard ansi-regex CSI branch is correct once OSC has been removed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the entire purpose
const CSI_PATTERN = /[\u001B\u009B][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]/g;

/**
 * Index of a trailing INCOMPLETE escape sequence (one that a later chunk will
 * finish), or -1 when the string ends cleanly. Two forms are detected: an
 * unterminated OSC (`ESC]` with no BEL/ST yet — its payload is arbitrary text
 * like a file path, so it cannot be matched by a fixed charset) and an
 * unterminated CSI or a lone trailing ESC.
 */
function incompleteEscapeIndex(s: string): number {
	const osc = s.lastIndexOf("\u001b]");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the entire purpose
	if (osc !== -1 && !/\u0007|\u001b\\/.test(s.slice(osc + 2))) return osc;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control bytes is the entire purpose
	const csi = s.match(/\u001b[[\]()#;?0-9]*$/);
	if (csi && csi.index !== undefined) return csi.index;
	return -1;
}

export function createPtyOutputCleaner(): (chunk: string) => string {
	let carry = "";
	let sawContent = false;
	return (raw: string): string => {
		let s = carry + raw;
		carry = "";
		// Hold back a trailing partial escape so the next chunk can complete it
		// before we strip — otherwise a sequence split mid-stream leaks its bytes.
		const partial = incompleteEscapeIndex(s);
		if (partial !== -1) {
			carry = s.slice(partial);
			s = s.slice(0, partial);
		}
		s = s.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(/\r\n/g, "\n");
		if (!sawContent) {
			const trimmed = s.replace(/^\s+/, "");
			// Still inside the viewport-clear's leading blank run: emit nothing.
			if (trimmed.length === 0) return "";
			sawContent = true;
			s = trimmed;
		}
		return s;
	};
}

/** Convenience one-shot for a fully-buffered string (tests, non-streaming callers). */
export function cleanPtyOutput(raw: string): string {
	return createPtyOutputCleaner()(raw);
}
