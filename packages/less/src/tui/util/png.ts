import { deflateSync, inflateSync } from "node:zlib";

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

// ---------------------------------------------------------------------------
// Encoder + downscaler — the return trip. Pasted screenshots that exceed the
// provider image budget (Anthropic caps the BASE64 payload at 5 MB) are
// decoded, bilinear-downscaled, and re-encoded before they ever board a
// message. Filter 0 rows + node:zlib deflate + real CRC32s: providers DO
// validate CRCs, unlike our lenient decoder above.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/**
 * Encode RGBA pixels as an 8-bit color-type-6 PNG (filter 0, max deflate).
 * Always RGBA out — alpha survives, grayscale isn't re-detected. Valid CRCs.
 */
export function encodePng(img: DecodedImage): Uint8Array {
	const { width, height, pixels } = img;
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
	const ihdr = new Uint8Array(13);
	const iv = new DataView(ihdr.buffer);
	iv.setUint32(0, width);
	iv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	// compression / filter / interlace all 0
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const parts = [
		sig,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", new Uint8Array(0)),
	];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const png = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		png.set(p, off);
		off += p.length;
	}
	return png;
}

/**
 * Bilinear resize to exact output dimensions. Good enough for screenshot
 * text at the 0.7–0.9× scales the budget fit needs; nearest-neighbor would
 * shred glyph edges.
 */
export function resizeRgba(img: DecodedImage, outW: number, outH: number): DecodedImage {
	const { width, height, pixels } = img;
	const out = new Uint8Array(outW * outH * 4);
	const xRatio = width / outW;
	const yRatio = height / outH;
	for (let y = 0; y < outH; y++) {
		const sy = Math.min(height - 1, (y + 0.5) * yRatio - 0.5);
		const y0 = Math.max(0, Math.floor(sy));
		const y1 = Math.min(height - 1, y0 + 1);
		const fy = sy - y0;
		for (let x = 0; x < outW; x++) {
			const sx = Math.min(width - 1, (x + 0.5) * xRatio - 0.5);
			const x0 = Math.max(0, Math.floor(sx));
			const x1 = Math.min(width - 1, x0 + 1);
			const fx = sx - x0;
			const d = (y * outW + x) * 4;
			for (let c = 0; c < 4; c++) {
				const p00 = pixels[(y0 * width + x0) * 4 + c];
				const p10 = pixels[(y0 * width + x1) * 4 + c];
				const p01 = pixels[(y1 * width + x0) * 4 + c];
				const p11 = pixels[(y1 * width + x1) * 4 + c];
				const top = p00 + (p10 - p00) * fx;
				const bot = p01 + (p11 - p01) * fx;
				out[d + c] = Math.round(top + (bot - top) * fy);
			}
		}
	}
	return { width: outW, height: outH, pixels: out };
}

export interface FittedPng {
	bytes: Uint8Array;
	width: number;
	height: number;
	/** True when the image was downscaled to fit the budget. */
	scaled: boolean;
}

/**
 * Fit a PNG under a RAW byte budget, downscaling if needed.
 *
 * Under budget → passthrough (original bytes, scaled=false). Over budget →
 * decode, estimate scale from the byte ratio (compressed size tracks pixel
 * area roughly linearly for screenshots), resize from the ORIGINAL pixels
 * each attempt (no generational quality loss), re-encode; back off 0.8× per
 * miss. Returns null when the PNG can't be decoded (exotic variant) or six
 * attempts still miss — callers degrade explicitly rather than shipping a
 * payload the provider is guaranteed to reject.
 */
export function fitPngToByteBudget(bytes: Uint8Array, budget: number): FittedPng | null {
	if (bytes.length <= budget) {
		const dims = pngDimensions(bytes);
		return { bytes, width: dims?.width ?? 0, height: dims?.height ?? 0, scaled: false };
	}
	const decoded = decodePng(bytes);
	if (!decoded) return null;
	let scale = Math.sqrt(budget / bytes.length);
	for (let attempt = 0; attempt < 6; attempt++) {
		const w = Math.max(1, Math.round(decoded.width * scale));
		const h = Math.max(1, Math.round(decoded.height * scale));
		const encoded = encodePng(resizeRgba(decoded, w, h));
		if (encoded.length <= budget) {
			return { bytes: encoded, width: w, height: h, scaled: true };
		}
		scale *= 0.8;
	}
	return null;
}
