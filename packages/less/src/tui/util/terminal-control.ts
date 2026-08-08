export function stripTerminalControlSequences(input: string): string {
	let output = "";
	let i = 0;

	while (i < input.length) {
		const code = input.charCodeAt(i);

		// ESC-prefixed terminal controls. Treat string controls (OSC/DCS/SOS/PM/APC)
		// as arbitrary payload until BEL/ST; if a terminator is missing, drop the
		// rest of the string rather than leaking a still-open control into stdout.
		if (code === 0x1b) {
			const next = input.charCodeAt(i + 1);
			if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				i = skipStringControl(input, i + 2);
				continue;
			}

			if (next === 0x5b) {
				i = skipCsi(input, i + 2);
				continue;
			}

			// Character set designation and other two/three-byte ESC controls.
			if (next === 0x28 || next === 0x29 || next === 0x2a || next === 0x2b) {
				i = Math.min(input.length, i + 3);
			} else {
				i = Math.min(input.length, i + 2);
			}
			continue;
		}

		// C1 CSI / OSC / string controls.
		if (code === 0x9b) {
			i = skipCsi(input, i + 1);
			continue;
		}
		if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			i = skipStringControl(input, i + 1);
			continue;
		}

		// Preserve layout whitespace, normalize CRLF (including Bun's `\r\r\n`
		// reporter output) to LF, strip every other C0/C1 control byte so
		// untrusted output cannot move the cursor, ring the bell, or leave the
		// terminal in a mode/state. A bare CR remains one newline; only a run
		// terminated by LF is collapsed into one line ending.
		if (code === 0x0d) {
			let crEnd = i;
			while (input.charCodeAt(crEnd) === 0x0d) crEnd++;
			if (input.charCodeAt(crEnd) === 0x0a) {
				output += "\n";
				i = crEnd + 1;
				continue;
			}
			output += "\n";
			i++;
			continue;
		}
		if (code === 0x0a || code === 0x09) {
			output += input[i];
			i++;
			continue;
		}
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			i++;
			continue;
		}

		output += input[i];
		i++;
	}

	return output;
}

function skipStringControl(input: string, start: number): number {
	for (let i = start; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code === 0x07 || code === 0x9c) return i + 1;
		if (code === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return input.length;
}

function skipCsi(input: string, start: number): number {
	for (let i = start; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i + 1;
	}
	return input.length;
}
