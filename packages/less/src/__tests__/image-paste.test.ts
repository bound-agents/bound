import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import { parseOsascriptPngHex, readClipboardImage } from "../tui/util/clipboard-image";
import { renderHalfBlocks } from "../tui/util/half-blocks";
import {
	clearImagePreviews,
	getImagePreview,
	hashImageBytes,
	parseImageDescription,
	stampImageDescription,
	storeImagePreview,
} from "../tui/util/image-preview";
import {
	decodePng,
	encodePng,
	fitPngToByteBudget,
	isPng,
	pngDimensions,
	resizeRgba,
} from "../tui/util/png";

/**
 * Build a minimal valid-enough PNG in-test (no encoder dependency): real
 * signature, IHDR, one deflated IDAT, IEND. CRCs are zeroed — the decoder
 * deliberately ignores them.
 */
function buildPng(
	width: number,
	height: number,
	colorType: 0 | 2 | 6,
	pixelBytes: number[],
): Uint8Array {
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(data, 8);
		// CRC left as zeroes.
		return out;
	};
	const ihdr = new Uint8Array(13);
	const iv = new DataView(ihdr.buffer);
	iv.setUint32(0, width);
	iv.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = colorType;
	// compression/filter/interlace all 0
	const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
	const stride = width * channels;
	// Prepend filter byte 0 to each row.
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		raw.set(pixelBytes.slice(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}
	const idat = new Uint8Array(deflateSync(raw));
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const png = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		png.set(p, off);
		off += p.length;
	}
	return png;
}

describe("png decoder", () => {
	it("decodes a 2×2 RGB PNG to RGBA pixels", () => {
		// red, green / blue, white
		const png = buildPng(2, 2, 2, [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
		expect(isPng(png)).toBe(true);
		const img = decodePng(png);
		expect(img).not.toBeNull();
		expect(img?.width).toBe(2);
		expect(img?.height).toBe(2);
		// Pixel (0,0) red, alpha filled to 255.
		expect(Array.from(img?.pixels.slice(0, 4) ?? [])).toEqual([255, 0, 0, 255]);
		// Pixel (1,1) white.
		expect(Array.from(img?.pixels.slice(12, 16) ?? [])).toEqual([255, 255, 255, 255]);
	});

	it("decodes RGBA (color type 6) preserving alpha", () => {
		const png = buildPng(1, 1, 6, [10, 20, 30, 128]);
		const img = decodePng(png);
		expect(Array.from(img?.pixels ?? [])).toEqual([10, 20, 30, 128]);
	});

	it("reads dimensions without a full decode", () => {
		const png = buildPng(7, 3, 2, new Array(7 * 3 * 3).fill(0));
		expect(pngDimensions(png)).toEqual({ width: 7, height: 3 });
	});

	it("returns null for non-PNG bytes", () => {
		expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
		expect(pngDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
	});
});

describe("half-block renderer", () => {
	it("emits one text row per two pixel rows, cells = ▀ glyphs", () => {
		const png = buildPng(4, 4, 2, new Array(4 * 4 * 3).fill(200));
		const img = decodePng(png);
		if (!img) throw new Error("decode failed");
		const lines = renderHalfBlocks(img, { maxCols: 10, maxRows: 10 });
		expect(lines.length).toBe(2); // 4px tall → 2 rows
		// Strip SGR: each line is exactly 4 half-block glyphs wide.
		for (const line of lines) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping is the point
			const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
			expect(visible).toBe("▀▀▀▀");
		}
		// Uniform 200-gray image blended over opaque alpha: 24-bit SGR present.
		expect(lines[0]).toContain("[38;2;200;200;200m");
		expect(lines[0]).toContain("[48;2;200;200;200m");
		// Every line resets.
		expect(lines[0]?.endsWith("\u001b[0m")).toBe(true);
	});

	it("downscales to fit maxCols preserving aspect", () => {
		const png = buildPng(8, 4, 2, new Array(8 * 4 * 3).fill(100));
		const img = decodePng(png);
		if (!img) throw new Error("decode failed");
		const lines = renderHalfBlocks(img, { maxCols: 4, maxRows: 10 });
		// 8×4 scaled to 4 wide → 2px tall → 1 row.
		expect(lines.length).toBe(1);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping is the point
		expect(lines[0]?.replace(/\u001b\[[0-9;]*m/g, "")).toBe("▀▀▀▀");
	});
});

describe("clipboard image reading", () => {
	it("parses osascript's «data PNGf…» hex literal", () => {
		const png = buildPng(1, 1, 2, [1, 2, 3]);
		const hex = Buffer.from(png).toString("hex").toUpperCase();
		const parsed = parseOsascriptPngHex(`«data PNGf${hex}»\n`);
		expect(parsed).not.toBeNull();
		expect(Buffer.from(parsed ?? []).equals(Buffer.from(png))).toBe(true);
	});

	it("rejects malformed hex output", () => {
		expect(parseOsascriptPngHex("no data here")).toBeNull();
		expect(parseOsascriptPngHex("«data PNGfZZZZZZZZZZZZZZZZZZ»")).toBeNull();
	});

	it("darwin: falls back from pngpaste to osascript, validates PNG magic", async () => {
		const png = buildPng(1, 1, 2, [9, 9, 9]);
		const hex = Buffer.from(png).toString("hex");
		const calls: string[] = [];
		const img = await readClipboardImage("darwin", async (cmd) => {
			calls.push(cmd);
			if (cmd === "pngpaste") return { ok: false, stdout: Buffer.alloc(0) };
			return { ok: true, stdout: Buffer.from(`«data PNGf${hex}»`) };
		});
		expect(calls).toEqual(["pngpaste", "osascript"]);
		expect(img?.mediaType).toBe("image/png");
		expect(Buffer.from(img?.bytes ?? []).equals(Buffer.from(png))).toBe(true);
	});

	it("returns null when the clipboard has no image", async () => {
		const img = await readClipboardImage("darwin", async () => ({
			ok: false,
			stdout: Buffer.alloc(0),
		}));
		expect(img).toBeNull();
	});
});

describe("image preview cache + description stamp", () => {
	it("round-trips: stamp → parse recovers label and hash", () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const hash = hashImageBytes(bytes);
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
		const desc = stampImageDescription(640, 480, hash);
		const parsed = parseImageDescription(desc);
		expect(parsed.label).toBe("pasted image 640×480");
		expect(parsed.hash).toBe(hash);
	});

	it("foreign descriptions parse as label-only (no preview key)", () => {
		expect(parseImageDescription("a discord attachment")).toEqual({
			label: "a discord attachment",
			hash: null,
		});
		expect(parseImageDescription(undefined)).toEqual({ label: "image", hash: null });
	});

	it("stores and retrieves preview lines by hash", () => {
		clearImagePreviews();
		storeImagePreview("cafe0123", ["line1", "line2"]);
		expect(getImagePreview("cafe0123")).toEqual(["line1", "line2"]);
		expect(getImagePreview("deadbeef")).toBeUndefined();
		clearImagePreviews();
	});
});

describe("png encoder + budget fit", () => {
	it("encode → decode round-trips pixels exactly (RGBA, valid CRCs)", () => {
		const width = 5;
		const height = 3;
		const pixels = new Uint8Array(width * height * 4);
		for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + 11) & 0xff;
		const encoded = encodePng({ width, height, pixels });
		expect(isPng(encoded)).toBe(true);
		const back = decodePng(encoded);
		expect(back).not.toBeNull();
		expect(back?.width).toBe(width);
		expect(back?.height).toBe(height);
		expect(back?.pixels).toEqual(pixels);
	});

	it("bilinear resize halves dimensions and averages neighbors", () => {
		// 2×2 checkerboard: black/white — the 1×1 output should land mid-gray.
		const pixels = new Uint8Array([
			0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
		]);
		const out = resizeRgba({ width: 2, height: 2, pixels }, 1, 1);
		expect(out.width).toBe(1);
		expect(out.height).toBe(1);
		// All four corners blend equally → ~127/128 per channel, alpha 255.
		expect(Math.abs(out.pixels[0] - 128)).toBeLessThanOrEqual(1);
		expect(out.pixels[3]).toBe(255);
	});

	it("passthrough when already under budget", () => {
		const png = buildPng(2, 2, 6, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
		const fit = fitPngToByteBudget(png, 1024 * 1024);
		expect(fit).not.toBeNull();
		expect(fit?.scaled).toBe(false);
		expect(fit?.bytes).toBe(png);
		expect(fit?.width).toBe(2);
		expect(fit?.height).toBe(2);
	});

	it("downscales an over-budget PNG under the budget", () => {
		// Random noise compresses terribly — a 200×200 noise PNG lands well
		// over a 20 KB budget, forcing the downscale path.
		const width = 200;
		const height = 200;
		const pixels = new Uint8Array(width * height * 4);
		let seed = 0x2545f491;
		for (let i = 0; i < pixels.length; i++) {
			// xorshift32 — an LCG's LOW bits have period ≤ 2^k (bit 7 repeats
			// every 256 samples), which deflate flattens; xorshift's full-width
			// mixing keeps every byte position genuinely incompressible.
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			seed >>>= 0;
			pixels[i] = (seed >>> 8) & 0xff;
		}
		const big = encodePng({ width, height, pixels });
		const budget = 20 * 1024;
		expect(big.length).toBeGreaterThan(budget);
		const fit = fitPngToByteBudget(big, budget);
		expect(fit).not.toBeNull();
		expect(fit?.scaled).toBe(true);
		expect(fit?.bytes.length).toBeLessThanOrEqual(budget);
		// Still a decodable PNG with the reported (smaller) dimensions.
		const back = fit ? decodePng(fit.bytes) : null;
		expect(back).not.toBeNull();
		expect(back?.width).toBe(fit?.width);
		expect(back?.height).toBe(fit?.height);
		expect((fit?.width ?? 0) < width).toBe(true);
	});

	it("returns null for an over-budget PNG the decoder can't handle", () => {
		// Interlaced flag makes decodePng bail; over budget + undecodable → null.
		const png = buildPng(2, 2, 6, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
		png[8 + 8 + 12] = 1; // IHDR interlace byte (sig 8 + len/type 8 + 12 offset)
		expect(fitPngToByteBudget(png, 10)).toBeNull();
	});
});
