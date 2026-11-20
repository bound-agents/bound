import { describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import {
	type CommandRunner,
	parseOsascriptPngHex,
	readClipboardImage,
} from "../tui/util/clipboard-image";
import {
	type DecodedImage,
	decodePng,
	encodePng,
	fitPngToByteBudget,
	isPng,
	pngDimensions,
	resizeRgba,
} from "../tui/util/png";

/**
 * Hand-assemble a PNG with an explicit color type, bit depth, interlace flag,
 * and per-row filter bytes, so the decoder's filter/color/error branches can be
 * exercised directly. CRCs are zeroed — the lenient decoder ignores them.
 */
function assemblePng(opts: {
	width: number;
	height: number;
	colorType: number;
	bitDepth?: number;
	interlace?: number;
	rows: number[][]; // each row: [filterByte, ...filteredBytes]
	idatCount?: number; // split IDAT into N chunks to exercise Buffer.concat path
	omitIdat?: boolean;
	omitIend?: boolean;
}): Uint8Array {
	const {
		width,
		height,
		colorType,
		bitDepth = 8,
		interlace = 0,
		rows,
		idatCount = 1,
		omitIdat = false,
		omitIend = false,
	} = opts;
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + data.length);
		const view = new DataView(out.buffer);
		view.setUint32(0, data.length);
		for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
		out.set(data, 8);
		return out; // CRC left zero
	};
	const ihdr = new Uint8Array(13);
	const iv = new DataView(ihdr.buffer);
	iv.setUint32(0, width);
	iv.setUint32(4, height);
	ihdr[8] = bitDepth;
	ihdr[9] = colorType;
	ihdr[12] = interlace;
	const raw: number[] = [];
	for (const row of rows) raw.push(...row);
	const deflated = new Uint8Array(deflateSync(Uint8Array.from(raw)));
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const parts: Uint8Array[] = [sig, chunk("IHDR", ihdr)];
	if (!omitIdat) {
		if (idatCount <= 1) {
			parts.push(chunk("IDAT", deflated));
		} else {
			const per = Math.ceil(deflated.length / idatCount);
			for (let i = 0; i < idatCount; i++) {
				parts.push(chunk("IDAT", deflated.subarray(i * per, (i + 1) * per)));
			}
		}
	}
	if (!omitIend) parts.push(chunk("IEND", new Uint8Array(0)));
	const total = parts.reduce((n, p) => n + p.length, 0);
	const png = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		png.set(p, off);
		off += p.length;
	}
	return png;
}

describe("png decoder — color types", () => {
	it("decodes grayscale (color type 0) replicating the gray channel into RGB", () => {
		// 2×1 grayscale, filter 0: two gray samples 10 and 200.
		const png = assemblePng({
			width: 2,
			height: 1,
			colorType: 0,
			rows: [[0, 10, 200]],
		});
		const img = decodePng(png);
		expect(img).not.toBeNull();
		const p = (img as DecodedImage).pixels;
		expect(Array.from(p)).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
	});

	it("decodes gray+alpha (color type 4) using the second channel as alpha", () => {
		// 1×1 gray+alpha: gray=128, alpha=64.
		const png = assemblePng({
			width: 1,
			height: 1,
			colorType: 4,
			rows: [[0, 128, 64]],
		});
		const img = decodePng(png) as DecodedImage;
		expect(Array.from(img.pixels)).toEqual([128, 128, 128, 64]);
	});

	it("rejects palette color type (3) as unsupported", () => {
		const png = assemblePng({ width: 1, height: 1, colorType: 3, rows: [[0, 0]] });
		expect(decodePng(png)).toBeNull();
	});
});

describe("png decoder — unfilter branches", () => {
	// A 2×2 RGB image, reconstructed per filter. We build the *filtered* bytes
	// that encode the same target image under each filter, then assert the
	// decoded pixels match the known target.
	const targetRows = [
		[10, 20, 30, 40, 50, 60], // row 0: px(10,20,30) px(40,50,60)
		[70, 80, 90, 100, 110, 120], // row 1: px(70,80,90) px(100,110,120)
	];
	const channels = 3;

	function filterSub(row: number[]): number[] {
		const out: number[] = [];
		for (let i = 0; i < row.length; i++) {
			const left = i >= channels ? row[i - channels] : 0;
			out.push((row[i] - left) & 0xff);
		}
		return out;
	}
	function filterUp(row: number[], prior: number[]): number[] {
		return row.map((v, i) => (v - prior[i]) & 0xff);
	}
	function filterAvg(row: number[], prior: number[]): number[] {
		const out: number[] = [];
		for (let i = 0; i < row.length; i++) {
			const left = i >= channels ? row[i - channels] : 0;
			out.push((row[i] - ((left + prior[i]) >> 1)) & 0xff);
		}
		return out;
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
	function filterPaeth(row: number[], prior: number[]): number[] {
		const out: number[] = [];
		for (let i = 0; i < row.length; i++) {
			const left = i >= channels ? row[i - channels] : 0;
			const upLeft = i >= channels ? prior[i - channels] : 0;
			out.push((row[i] - paeth(left, prior[i], upLeft)) & 0xff);
		}
		return out;
	}

	function expectDecodes(rows: number[][]) {
		const png = assemblePng({ width: 2, height: 2, colorType: 2, rows });
		const img = decodePng(png) as DecodedImage;
		expect(img).not.toBeNull();
		// Reconstruct expected RGBA from targetRows.
		const expected: number[] = [];
		for (const r of targetRows) {
			for (let x = 0; x < 2; x++) {
				expected.push(r[x * 3], r[x * 3 + 1], r[x * 3 + 2], 255);
			}
		}
		expect(Array.from(img.pixels)).toEqual(expected);
	}

	it("filter 1 (Sub)", () => {
		expectDecodes([
			[1, ...filterSub(targetRows[0])],
			[1, ...filterSub(targetRows[1])],
		]);
	});
	it("filter 2 (Up)", () => {
		const zero = new Array(6).fill(0);
		expectDecodes([
			[2, ...filterUp(targetRows[0], zero)],
			[2, ...filterUp(targetRows[1], targetRows[0])],
		]);
	});
	it("filter 3 (Average)", () => {
		const zero = new Array(6).fill(0);
		expectDecodes([
			[3, ...filterAvg(targetRows[0], zero)],
			[3, ...filterAvg(targetRows[1], targetRows[0])],
		]);
	});
	it("filter 4 (Paeth)", () => {
		const zero = new Array(6).fill(0);
		expectDecodes([
			[4, ...filterPaeth(targetRows[0], zero)],
			[4, ...filterPaeth(targetRows[1], targetRows[0])],
		]);
	});

	it("rejects an unknown filter type (5)", () => {
		const png = assemblePng({
			width: 2,
			height: 2,
			colorType: 2,
			rows: [
				[5, 0, 0, 0, 0, 0, 0],
				[0, 0, 0, 0, 0, 0, 0],
			],
		});
		expect(decodePng(png)).toBeNull();
	});
});

describe("png decoder — error and edge paths", () => {
	it("returns null for a non-8-bit depth", () => {
		const png = assemblePng({
			width: 1,
			height: 1,
			colorType: 2,
			bitDepth: 16,
			rows: [[0, 0, 0, 0, 0, 0, 0]],
		});
		expect(decodePng(png)).toBeNull();
	});

	it("returns null for interlaced PNGs", () => {
		const png = assemblePng({
			width: 1,
			height: 1,
			colorType: 2,
			interlace: 1,
			rows: [[0, 0, 0, 0]],
		});
		expect(decodePng(png)).toBeNull();
	});

	it("returns null when there is no IDAT chunk", () => {
		const png = assemblePng({ width: 1, height: 1, colorType: 2, rows: [], omitIdat: true });
		expect(decodePng(png)).toBeNull();
	});

	it("returns null when inflated data is too short for the declared dimensions", () => {
		// Claim 4×4 but provide one tiny row's worth of data.
		const png = assemblePng({ width: 4, height: 4, colorType: 2, rows: [[0, 1, 2, 3]] });
		expect(decodePng(png)).toBeNull();
	});

	it("returns null when the IDAT payload is not valid zlib", () => {
		// Hand-build a PNG whose IDAT is garbage (not deflate output).
		const chunk = (type: string, data: Uint8Array): Uint8Array => {
			const out = new Uint8Array(12 + data.length);
			const view = new DataView(out.buffer);
			view.setUint32(0, data.length);
			for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
			out.set(data, 8);
			return out;
		};
		const ihdr = new Uint8Array(13);
		const iv = new DataView(ihdr.buffer);
		iv.setUint32(0, 1);
		iv.setUint32(4, 1);
		ihdr[8] = 8;
		ihdr[9] = 2;
		const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const parts = [
			sig,
			chunk("IHDR", ihdr),
			chunk("IDAT", Uint8Array.from([0xff, 0xff, 0xff, 0xff])),
			chunk("IEND", new Uint8Array(0)),
		];
		const total = parts.reduce((n, p) => n + p.length, 0);
		const png = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			png.set(p, off);
			off += p.length;
		}
		expect(decodePng(png)).toBeNull();
	});

	it("rejects absurd dimensions that would overflow allocation", () => {
		const png = assemblePng({
			width: 0x7fff,
			height: 0x7fff,
			colorType: 2,
			rows: [[0, 0, 0, 0]],
		});
		expect(decodePng(png)).toBeNull();
	});

	it("concatenates multiple IDAT chunks", () => {
		const png = assemblePng({
			width: 2,
			height: 1,
			colorType: 2,
			rows: [[0, 1, 2, 3, 4, 5, 6]],
			idatCount: 3,
		});
		const img = decodePng(png) as DecodedImage;
		expect(img).not.toBeNull();
		expect(Array.from(img.pixels.subarray(0, 4))).toEqual([1, 2, 3, 255]);
	});

	it("isPng rejects short buffers and wrong magic", () => {
		expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false);
		expect(isPng(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
	});

	it("pngDimensions rejects when IHDR is not first or buffer is truncated", () => {
		// Valid signature but a non-IHDR first chunk type.
		const buf = new Uint8Array(24);
		buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		buf.set([0x41, 0x41, 0x41, 0x41], 12); // "AAAA" at the IHDR type offset
		expect(pngDimensions(buf)).toBeNull();
		// Signature present but too short overall.
		const short = new Uint8Array(12);
		short.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(pngDimensions(short)).toBeNull();
	});
});

describe("png fitPngToByteBudget — miss path", () => {
	it("returns null when six downscale attempts can't reach the budget", () => {
		// Build a modest decodable RGBA PNG, then demand a 1-byte budget. Every
		// attempt re-encodes to more than 1 byte, so all six miss → null.
		const width = 8;
		const height = 8;
		const pixels = new Uint8Array(width * height * 4);
		for (let i = 0; i < pixels.length; i += 4) {
			pixels[i] = (i * 7) & 0xff;
			pixels[i + 1] = (i * 13) & 0xff;
			pixels[i + 2] = (i * 29) & 0xff;
			pixels[i + 3] = 255;
		}
		const png = encodePng({ width, height, pixels });
		expect(png.length).toBeGreaterThan(1);
		expect(fitPngToByteBudget(png, 1)).toBeNull();
	});

	it("resizeRgba upscales as well as downscales", () => {
		const img: DecodedImage = {
			width: 1,
			height: 1,
			pixels: Uint8Array.from([100, 150, 200, 255]),
		};
		const up = resizeRgba(img, 2, 2);
		expect(up.width).toBe(2);
		expect(up.height).toBe(2);
		// Single-pixel source → every output pixel equals the source.
		expect(Array.from(up.pixels.subarray(0, 4))).toEqual([100, 150, 200, 255]);
	});
});

describe("clipboard-image — parseOsascriptPngHex edge cases", () => {
	it("rejects odd-length hex", () => {
		expect(parseOsascriptPngHex("«data PNGf89504E470»")).toBeNull();
	});
	it("rejects hex shorter than 16 chars", () => {
		expect(parseOsascriptPngHex("«data PNGf8950»")).toBeNull();
	});
	it("parses a valid even-length hex of adequate length", () => {
		const bytes = parseOsascriptPngHex("«data PNGf89504E470D0A1A0A»");
		expect(bytes).not.toBeNull();
		expect(Array.from(bytes as Uint8Array)).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
	});
});

describe("clipboard-image — readClipboardImage platform matrix", () => {
	// A tiny real PNG whose bytes pass looksLikePng and fit under budget.
	function tinyPng(): Uint8Array {
		return encodePng({ width: 1, height: 1, pixels: Uint8Array.from([1, 2, 3, 255]) });
	}

	it("darwin: pngpaste fast path returns the image without osascript", async () => {
		const calls: string[] = [];
		const run: CommandRunner = async (cmd) => {
			calls.push(cmd);
			if (cmd === "pngpaste") return { ok: true, stdout: Buffer.from(tinyPng()) };
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		const img = await readClipboardImage("darwin", run);
		expect(img?.mediaType).toBe("image/png");
		expect(calls).toEqual(["pngpaste"]);
	});

	it("darwin: osascript fallback non-PNG hex yields null", async () => {
		const run: CommandRunner = async (cmd) => {
			if (cmd === "pngpaste") return { ok: false, stdout: Buffer.alloc(0) };
			// osascript returns parseable hex that is NOT a PNG (fails looksLikePng).
			return { ok: true, stdout: Buffer.from("«data PNGf0102030405060708»") };
		};
		expect(await readClipboardImage("darwin", run)).toBeNull();
	});

	it("linux: wl-paste miss then xclip hit", async () => {
		const calls: string[] = [];
		const run: CommandRunner = async (cmd) => {
			calls.push(cmd);
			if (cmd === "xclip") return { ok: true, stdout: Buffer.from(tinyPng()) };
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		const img = await readClipboardImage("linux", run);
		expect(img?.mediaType).toBe("image/png");
		expect(calls).toEqual(["wl-paste", "xclip"]);
	});

	it("linux: all readers miss yields null", async () => {
		const run: CommandRunner = async () => ({ ok: false, stdout: Buffer.alloc(0) });
		expect(await readClipboardImage("linux", run)).toBeNull();
	});

	it("linux: a reader hit with non-PNG bytes falls through to null", async () => {
		const run: CommandRunner = async (cmd) => {
			if (cmd === "wl-paste") return { ok: true, stdout: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) };
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		// wl-paste "succeeds" but bytes aren't a PNG → loop continues, xclip misses → null.
		expect(await readClipboardImage("linux", run)).toBeNull();
	});

	it("win32: pwsh miss then powershell.exe hit (base64 PNG)", async () => {
		const calls: string[] = [];
		const b64 = Buffer.from(tinyPng()).toString("base64");
		const run: CommandRunner = async (cmd) => {
			calls.push(cmd);
			if (cmd === "powershell.exe") return { ok: true, stdout: Buffer.from(b64) };
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		const img = await readClipboardImage("win32", run);
		expect(img?.mediaType).toBe("image/png");
		expect(calls).toEqual(["pwsh", "powershell.exe"]);
	});

	it("win32: non-empty stdout that decodes to non-PNG yields null", async () => {
		const b64 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString("base64");
		const run: CommandRunner = async () => ({ ok: true, stdout: Buffer.from(b64) });
		expect(await readClipboardImage("win32", run)).toBeNull();
	});

	it("unknown platform yields null without invoking any runner", async () => {
		let invoked = false;
		const run: CommandRunner = async () => {
			invoked = true;
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		expect(await readClipboardImage("freebsd" as NodeJS.Platform, run)).toBeNull();
		expect(invoked).toBe(false);
	});

	it("exercises the real default runner against a bogus command (ok:false, empty stdout)", async () => {
		// No injected runner → defaultRunner runs real execFile. On linux the
		// readers are wl-paste/xclip; in CI/sandboxes these are absent, so each
		// execFile errors and the default runner resolves { ok:false, stdout:'' }.
		// Either way the call returns null without throwing — the point is to drive
		// the real execFile seam (defaultRunner), not to assert an image.
		const img = await readClipboardImage("linux");
		expect(img).toBeNull();
	});

	it("darwin: an oversized, undecodable PNG that can't be fit under budget yields null", async () => {
		// Build bytes that pass looksLikePng (valid magic + >8 bytes) and exceed the
		// provider budget, but are NOT a decodable PNG (no IHDR/IDAT). fitPngToByteBudget
		// returns null (over budget + undecodable) → fitToProviderBudget null → the
		// darwin pngpaste branch returns null.
		const oversized = new Uint8Array(5 * 1024 * 1024 + 16);
		oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const run: CommandRunner = async (cmd) => {
			if (cmd === "pngpaste") return { ok: true, stdout: Buffer.from(oversized) };
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		expect(await readClipboardImage("darwin", run)).toBeNull();
	});

	it("linux: an oversized, undecodable PNG from a reader yields null (budget-fit miss)", async () => {
		const oversized = new Uint8Array(5 * 1024 * 1024 + 16);
		oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const run: CommandRunner = async (cmd) => {
			if (cmd === "wl-paste") return { ok: true, stdout: Buffer.from(oversized) };
			return { ok: false, stdout: Buffer.alloc(0) };
		};
		expect(await readClipboardImage("linux", run)).toBeNull();
	});

	it("win32: an oversized, undecodable PNG (base64) yields null (budget-fit miss)", async () => {
		const oversized = new Uint8Array(5 * 1024 * 1024 + 16);
		oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const b64 = Buffer.from(oversized).toString("base64");
		const run: CommandRunner = async () => ({ ok: true, stdout: Buffer.from(b64) });
		expect(await readClipboardImage("win32", run)).toBeNull();
	});
});
