import { inflateSync } from "node:zlib";

/**
 * Minimal PNG decoder for clipboard-pasted screenshots.
 *
 * Deliberately dependency-free and deliberately partial: 8-bit depth,
 * color types 0 (gray), 2 (RGB), 4 (gray+alpha), 6 (RGBA), no Adam7
 * interlace, CRCs ignored. That covers every screenshot macOS/Linux
 * clipboards produce; anything else returns null and the caller degrades
 * to a text placeholder. Inflate rides node:zlib (Bun-native).
 */

export interface DecodedImage {
	width: number;
	height: number;
	/** RGBA, 4 bytes per pixel, row-major. */
	pixels: Uint8Array;
}

/** PNG magic: \x89PNG\r\n\x1a\n */
export function isPng(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	);
}

/** Bytes-per-pixel for the supported color types (8-bit only). */
function channelsFor(colorType: number): number | null {
	switch (colorType) {
		case 0:
			return 1; // grayscale
		case 2:
			return 3; // RGB
		case 4:
			return 2; // gray + alpha
		case 6:
			return 4; // RGBA
		default:
			return null; // palette (3) and exotics unsupported
	}
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * Decode a PNG buffer to RGBA pixels. Returns null on any unsupported
 * feature or malformed structure — callers treat null as "no preview".
 */
export function decodePng(bytes: Uint8Array): DecodedImage | null {
	if (!isPng(bytes)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = -1;
	let interlace = 0;
	const idatParts: Uint8Array[] = [];

	let off = 8;
	while (off + 8 <= bytes.length) {
		const len = view.getUint32(off);
		const type = String.fromCharCode(
			bytes[off + 4],
			bytes[off + 5],
			bytes[off + 6],
			bytes[off + 7],
		);
		const dataStart = off + 8;
		if (dataStart + len > bytes.length) return null;
		if (type === "IHDR") {
			width = view.getUint32(dataStart);
			height = view.getUint32(dataStart + 4);
			bitDepth = bytes[dataStart + 8];
			colorType = bytes[dataStart + 9];
			interlace = bytes[dataStart + 12];
		} else if (type === "IDAT") {
			idatParts.push(bytes.subarray(dataStart, dataStart + len));
		} else if (type === "IEND") {
			break;
		}
		off = dataStart + len + 4; // skip CRC (unvalidated)
	}

	if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0) return null;
	const channels = channelsFor(colorType);
	if (channels === null || idatParts.length === 0) return null;
	// Guard absurd allocations (clipboard can't hold a 100MP screenshot,
	// but a corrupt header could claim one).
	if (width * height > 64_000_000) return null;

	let raw: Uint8Array;
	try {
		const idat = idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts);
		raw = inflateSync(idat);
	} catch {
		return null;
	}

	const stride = width * channels;
	if (raw.length < (stride + 1) * height) return null;

	// Unfilter in place into `prior`-relative buffers.
	const pixels = new Uint8Array(width * height * 4);
	const line = new Uint8Array(stride);
	const prior = new Uint8Array(stride);

	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		const filter = raw[rowStart];
		const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
		switch (filter) {
			case 0:
				line.set(src);
				break;
			case 1: // Sub
				for (let i = 0; i < stride; i++) {
					line[i] = (src[i] + (i >= channels ? line[i - channels] : 0)) & 0xff;
				}
				break;
			case 2: // Up
				for (let i = 0; i < stride; i++) {
					line[i] = (src[i] + prior[i]) & 0xff;
				}
				break;
			case 3: // Average
				for (let i = 0; i < stride; i++) {
					const left = i >= channels ? line[i - channels] : 0;
					line[i] = (src[i] + ((left + prior[i]) >> 1)) & 0xff;
				}
				break;
			case 4: // Paeth
				for (let i = 0; i < stride; i++) {
					const left = i >= channels ? line[i - channels] : 0;
					const upLeft = i >= channels ? prior[i - channels] : 0;
					line[i] = (src[i] + paeth(left, prior[i], upLeft)) & 0xff;
				}
				break;
			default:
				return null;
		}

		// Expand to RGBA.
		const out = y * width * 4;
		for (let x = 0; x < width; x++) {
			const s = x * channels;
			const d = out + x * 4;
			if (colorType === 2) {
				pixels[d] = line[s];
				pixels[d + 1] = line[s + 1];
				pixels[d + 2] = line[s + 2];
				pixels[d + 3] = 255;
			} else if (colorType === 6) {
				pixels[d] = line[s];
				pixels[d + 1] = line[s + 1];
				pixels[d + 2] = line[s + 2];
				pixels[d + 3] = line[s + 3];
			} else if (colorType === 0) {
				pixels[d] = pixels[d + 1] = pixels[d + 2] = line[s];
				pixels[d + 3] = 255;
			} else {
				// gray + alpha
				pixels[d] = pixels[d + 1] = pixels[d + 2] = line[s];
				pixels[d + 3] = line[s + 1];
			}
		}
		prior.set(line);
	}

	return { width, height, pixels };
}

/** Read PNG dimensions without a full decode (IHDR only). */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	if (!isPng(bytes) || bytes.length < 24) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// IHDR is required first: signature(8) + len(4) + "IHDR"(4) + data
	if (
		String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR" ||
		bytes.length < 24
	) {
		return null;
	}
	return { width: view.getUint32(16), height: view.getUint32(20) };
}
