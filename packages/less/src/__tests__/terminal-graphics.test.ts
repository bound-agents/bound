import { describe, expect, it } from "bun:test";
import {
	detectGraphicsProtocol,
	encodeItermImage,
	encodeKittyImage,
	fitCellBox,
} from "../tui/util/terminal-graphics";

const ESC = "\u001b";
const ST = "\u001b\\";
const BEL = "\u0007";

describe("detectGraphicsProtocol", () => {
	it("honors the BOUND_TERM_GRAPHICS override, case-insensitively", () => {
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "kitty" })).toBe("kitty");
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "ITERM2" })).toBe("iterm2");
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "iterm" })).toBe("iterm2");
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "none" })).toBeNull();
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "off" })).toBeNull();
	});

	it("override=none wins even when a supporting terminal is present", () => {
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "none", TERM: "xterm-kitty" })).toBeNull();
	});

	it("override=auto falls through to sniffing", () => {
		expect(detectGraphicsProtocol({ BOUND_TERM_GRAPHICS: "auto", KITTY_WINDOW_ID: "1" })).toBe(
			"kitty",
		);
	});

	it("detects kitty-protocol terminals", () => {
		expect(detectGraphicsProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
		expect(detectGraphicsProtocol({ KITTY_WINDOW_ID: "3" })).toBe("kitty");
		expect(detectGraphicsProtocol({ TERM_PROGRAM: "ghostty" })).toBe("kitty");
		expect(detectGraphicsProtocol({ GHOSTTY_RESOURCES_DIR: "/x" })).toBe("kitty");
		expect(detectGraphicsProtocol({ KONSOLE_VERSION: "220370" })).toBe("kitty");
	});

	it("detects iTerm2 and WezTerm as iterm2", () => {
		expect(detectGraphicsProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
		expect(detectGraphicsProtocol({ LC_TERMINAL: "iTerm2" })).toBe("iterm2");
		expect(detectGraphicsProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("iterm2");
		expect(detectGraphicsProtocol({ WEZTERM_EXECUTABLE: "/usr/bin/wezterm" })).toBe("iterm2");
	});

	it("returns null for an unknown / unsupported terminal", () => {
		expect(detectGraphicsProtocol({ TERM: "xterm-256color" })).toBeNull();
		expect(detectGraphicsProtocol({ TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
		expect(detectGraphicsProtocol({})).toBeNull();
	});

	it("prefers kitty over iterm2 when a terminal advertises both signals", () => {
		// WezTerm sets TERM_PROGRAM=WezTerm but a user may also export
		// TERM=xterm-kitty; kitty is checked first.
		expect(detectGraphicsProtocol({ TERM: "xterm-kitty", TERM_PROGRAM: "WezTerm" })).toBe("kitty");
	});
});

describe("fitCellBox", () => {
	it("fits a wide image width-constrained, correcting for cell aspect", () => {
		// 3200×2090 into 80×24. colsPerRow = (3200/2090)*2 ≈ 3.062.
		// width-first: cols=80, rows=round(80/3.062)=26 > 24 → clamp rows=24,
		// cols=round(24*3.062)=73.
		const box = fitCellBox(3200, 2090, 80, 24);
		expect(box.rows).toBe(24);
		expect(box.cols).toBe(73);
	});

	it("fits a tall image height-constrained", () => {
		// 400×1200 into 80×24. colsPerRow=(400/1200)*2=0.667.
		// width-first: cols=80, rows=round(80/0.667)=120 > 24 → rows=24,
		// cols=round(24*0.667)=16.
		const box = fitCellBox(400, 1200, 80, 24);
		expect(box.rows).toBe(24);
		expect(box.cols).toBe(16);
	});

	it("never exceeds the max box and never returns zero", () => {
		const box = fitCellBox(1, 1, 80, 24);
		expect(box.cols).toBeGreaterThanOrEqual(1);
		expect(box.rows).toBeGreaterThanOrEqual(1);
		expect(box.cols).toBeLessThanOrEqual(80);
		expect(box.rows).toBeLessThanOrEqual(24);
	});

	it("degrades to 1×1 for a degenerate image", () => {
		expect(fitCellBox(0, 0, 80, 24)).toEqual({ cols: 1, rows: 1 });
	});
});

describe("encodeKittyImage", () => {
	it("emits a single APC escape for a small payload with control keys (reserve)", () => {
		const out = encodeKittyImage("AAAA", { cols: 10, rows: 5 });
		expect(out).toBe(`${ESC}_Ga=T,f=100,C=1,c=10,r=5;AAAA${ST}`);
	});

	it("reserve mode sets C=1 (no cursor move) so the height Box owns the reservation", () => {
		expect(encodeKittyImage("AAAA", { cols: 2, rows: 1 }, "reserve")).toContain("C=1");
	});

	it("advance mode omits C=1 so the terminal advances the cursor past the image", () => {
		const out = encodeKittyImage("AAAA", { cols: 2, rows: 1 }, "advance");
		expect(out).not.toContain("C=1");
		expect(out).toBe(`${ESC}_Ga=T,f=100,c=2,r=1;AAAA${ST}`);
	});

	it("chunks payloads over 4096 base64 bytes: m=1 continuations, m=0 final", () => {
		const payload = "x".repeat(4096 + 100);
		const out = encodeKittyImage(payload, { cols: 4, rows: 2 });
		// First chunk carries control keys + m=1.
		expect(out).toContain(`${ESC}_Ga=T,f=100,C=1,c=4,r=2,m=1;`);
		// Final chunk carries only m=0.
		expect(out).toContain(`${ESC}_Gm=0;`);
		// Exactly two chunks for 4196 bytes at a 4096 boundary.
		const chunks = out.split(ST).filter((s) => s.length > 0);
		expect(chunks.length).toBe(2);
		// Reassembled payload equals the original.
		const rejoined = chunks.map((c) => c.slice(c.indexOf(";") + 1)).join("");
		expect(rejoined).toBe(payload);
	});
});

describe("encodeItermImage", () => {
	it("reserve mode brackets the OSC 1337 escape in DECSC/DECRC (net-zero cursor)", () => {
		const out = encodeItermImage("AAAA", { cols: 10, rows: 5 }, 2792561, "reserve");
		expect(out).toBe(
			`${ESC}7${ESC}]1337;File=inline=1;width=10;height=5;preserveAspectRatio=1;size=2792561:AAAA${BEL}${ESC}8`,
		);
	});

	it("defaults to reserve mode", () => {
		const out = encodeItermImage("AAAA", { cols: 4, rows: 3 }, 100);
		expect(out.startsWith(`${ESC}7`)).toBe(true);
		expect(out.endsWith(`${ESC}8`)).toBe(true);
	});

	it("advance mode emits the bare escape so the terminal owns the cursor advance", () => {
		const out = encodeItermImage("AAAA", { cols: 10, rows: 5 }, 2792561, "advance");
		expect(out).toBe(
			`${ESC}]1337;File=inline=1;width=10;height=5;preserveAspectRatio=1;size=2792561:AAAA${BEL}`,
		);
		expect(out.startsWith(`${ESC}7`)).toBe(false);
		expect(out.endsWith(`${ESC}8`)).toBe(false);
	});

	it("preserves aspect ratio so the image never exceeds its reserved rows", () => {
		expect(encodeItermImage("AAAA", { cols: 3, rows: 2 }, 100)).toContain("preserveAspectRatio=1");
	});
});
