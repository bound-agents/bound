import { execFile } from "node:child_process";
import { PROVIDER_IMAGE_RAW_MAX_BYTES } from "@bound/llm";
import { fitPngToByteBudget } from "./png";

/**
 * Read an image off the system clipboard, dependency-free.
 *
 * macOS: `pngpaste -` when installed (fast path), else `osascript` asking for
 * the clipboard as «class PNGf» and parsing the hex blob AppleScript prints.
 * Linux: `wl-paste` (Wayland) then `xclip` (X11), both asking for image/png.
 * Windows: PowerShell (pwsh, then powershell.exe) + System.Windows.Forms,
 * base64-encoding the clipboard Bitmap as PNG on stdout.
 *
 * Returns null when the clipboard holds no image (or no reader exists on
 * this platform) — callers treat null as "nothing to paste", not an error.
 */

export interface ClipboardImage {
	bytes: Uint8Array;
	mediaType: "image/png";
}

/** Injectable process runner (binary-safe stdout). */
export type CommandRunner = (
	cmd: string,
	args: string[],
) => Promise<{ ok: boolean; stdout: Buffer }>;

const defaultRunner: CommandRunner = (cmd, args) =>
	new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
			(err, stdout) => {
				resolve({ ok: !err, stdout: stdout ?? Buffer.alloc(0) });
			},
		);
	});

/**
 * Parse AppleScript's hex data literal: `«data PNGf89504E47…»` (possibly
 * wrapped in whitespace/newline). Returns the decoded bytes or null.
 */
export function parseOsascriptPngHex(output: string): Uint8Array | null {
	const m = output.match(/«data PNGf([0-9A-Fa-f]+)»/);
	if (!m) return null;
	const hex = m[1];
	if (hex.length < 16 || hex.length % 2 !== 0) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(b)) return null;
		bytes[i] = b;
	}
	return bytes;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function looksLikePng(bytes: Uint8Array): boolean {
	return bytes.length > 8 && PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Fit clipboard bytes under the provider image budget (Anthropic caps the
 * BASE64 payload at 5 MB — raw budget is 3/4 of that). A 3200×2080 Retina
 * screenshot exceeds it and the API rejects the whole request, so oversized
 * pastes are downscaled HERE, before the bytes ever board a message. Returns
 * null when the image can't be brought under budget (undecodable exotic
 * PNG) — callers treat that as "nothing to paste" rather than staging a
 * payload the provider is guaranteed to refuse.
 */
function fitToProviderBudget(bytes: Uint8Array): Uint8Array | null {
	const fitted = fitPngToByteBudget(bytes, PROVIDER_IMAGE_RAW_MAX_BYTES);
	return fitted ? fitted.bytes : null;
}

/**
 * Try each platform reader in order; first PNG wins. `platform` and `run`
 * are injectable for tests.
 */
export async function readClipboardImage(
	platform: NodeJS.Platform = process.platform,
	run: CommandRunner = defaultRunner,
): Promise<ClipboardImage | null> {
	if (platform === "darwin") {
		// pngpaste (brew) writes PNG straight to stdout — cheapest path.
		const png = await run("pngpaste", ["-"]);
		if (png.ok && looksLikePng(png.stdout)) {
			const fitted = fitToProviderBudget(new Uint8Array(png.stdout));
			if (fitted) return { bytes: fitted, mediaType: "image/png" };
			return null;
		}
		// Built-in fallback: AppleScript prints the PNG as a hex data literal.
		// A 3MB screenshot round-trips as ~6MB of hex — chunky but bounded by
		// maxBuffer, and it requires nothing installed.
		const osa = await run("osascript", ["-e", "get the clipboard as «class PNGf»"]);
		if (osa.ok) {
			const bytes = parseOsascriptPngHex(osa.stdout.toString("utf8"));
			if (bytes && looksLikePng(bytes)) {
				const fitted = fitToProviderBudget(bytes);
				if (fitted) return { bytes: fitted, mediaType: "image/png" };
			}
		}
		return null;
	}

	if (platform === "linux") {
		for (const [cmd, args] of [
			["wl-paste", ["-t", "image/png"]],
			["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
		] as const) {
			const res = await run(cmd, [...args]);
			if (res.ok && looksLikePng(res.stdout)) {
				const fitted = fitToProviderBudget(new Uint8Array(res.stdout));
				if (fitted) return { bytes: fitted, mediaType: "image/png" };
				return null;
			}
		}
		return null;
	}

	if (platform === "win32") {
		// PowerShell + System.Windows.Forms reads the clipboard image as a
		// Bitmap and base64-encodes its PNG form to stdout. pwsh (7) is the
		// fast path; powershell.exe ships in System32 on every Windows install
		// so it's the guaranteed fallback. -Sta is required — the clipboard
		// needs an STA thread. Base64 is ASCII, so it survives either shell's
		// redirected-stdout codepage. No image → empty stdout → null.
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($null -eq $img) { exit 0 }",
			"$ms = New-Object System.IO.MemoryStream",
			"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
			"[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
			"$ms.Dispose(); $img.Dispose()",
		].join("\n");
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		for (const cmd of ["pwsh", "powershell.exe"]) {
			const res = await run(cmd, [
				"-NoProfile",
				"-NonInteractive",
				"-Sta",
				"-EncodedCommand",
				encoded,
			]);
			if (res.ok && res.stdout.length > 0) {
				const bytes = new Uint8Array(Buffer.from(res.stdout.toString("utf8"), "base64"));
				if (looksLikePng(bytes)) {
					const fitted = fitToProviderBudget(bytes);
					if (fitted) return { bytes: fitted, mediaType: "image/png" };
					return null;
				}
			}
		}
		return null;
	}

	return null;
}
