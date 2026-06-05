import { describe, expect, it } from "bun:test";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
	APP_FRAME_SANDBOX,
	buildAppFrameSrcdoc,
	buildCspString,
	frameAllowAttribute,
	sanitizeCspDomains,
} from "../mcp-app-frame";

describe("APP_FRAME_SANDBOX", () => {
	it("grants scripts + forms but NOT same-origin (opaque-origin isolation)", () => {
		expect(APP_FRAME_SANDBOX).toContain("allow-scripts");
		expect(APP_FRAME_SANDBOX).toContain("allow-forms");
		expect(APP_FRAME_SANDBOX).not.toContain("allow-same-origin");
	});
});

describe("sanitizeCspDomains", () => {
	it("returns [] for undefined", () => {
		expect(sanitizeCspDomains(undefined)).toEqual([]);
	});

	it("keeps clean origins", () => {
		expect(sanitizeCspDomains(["https://api.example.com", "wss://rt.example.com"])).toEqual([
			"https://api.example.com",
			"wss://rt.example.com",
		]);
	});

	it("drops entries that could break out of the directive", () => {
		expect(
			sanitizeCspDomains([
				"https://ok.com",
				"https://evil.com; script-src *", // space + semicolon
				"https://e\nvil.com", // newline
				"https://e'vil.com", // quote
				'https://e"vil.com', // double quote
			]),
		).toEqual(["https://ok.com"]);
	});
});

describe("buildCspString", () => {
	it("emits secure defaults when no csp is provided", () => {
		const csp = buildCspString(undefined);
		expect(csp).toContain("default-src 'self' 'unsafe-inline'");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("frame-src 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		// directives are semicolon-separated
		expect(csp.split(";").length).toBeGreaterThan(5);
	});

	it("adds connectDomains to connect-src", () => {
		const csp = buildCspString({ connectDomains: ["https://api.weather.com"] });
		expect(csp).toContain("connect-src 'self' https://api.weather.com");
	});

	it("adds resourceDomains to script/style/img/font/media/worker-src", () => {
		const csp = buildCspString({ resourceDomains: ["https://cdn.jsdelivr.net"] });
		expect(csp).toContain(
			"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://cdn.jsdelivr.net",
		);
		expect(csp).toContain("style-src 'self' 'unsafe-inline' blob: data: https://cdn.jsdelivr.net");
		expect(csp).toContain("img-src 'self' data: blob: https://cdn.jsdelivr.net");
		expect(csp).toContain("font-src 'self' data: blob: https://cdn.jsdelivr.net");
		expect(csp).toContain("media-src 'self' data: blob: https://cdn.jsdelivr.net");
		expect(csp).toContain("worker-src 'self' blob: https://cdn.jsdelivr.net");
	});

	it("uses frameDomains / baseUriDomains when present", () => {
		const csp = buildCspString({
			frameDomains: ["https://www.youtube.com"],
			baseUriDomains: ["https://cdn.example.com"],
		});
		expect(csp).toContain("frame-src https://www.youtube.com");
		expect(csp).toContain("base-uri https://cdn.example.com");
		expect(csp).not.toContain("frame-src 'none'");
		expect(csp).not.toContain("base-uri 'none'");
	});

	it("sanitizes injected domains before serializing", () => {
		const csp = buildCspString({ connectDomains: ["https://ok.com; img-src *"] });
		expect(csp).not.toContain("img-src *");
		expect(csp).toContain("connect-src 'self'");
	});
});

describe("buildAppFrameSrcdoc", () => {
	const html = "<!doctype html><html><head><title>App</title></head><body>hi</body></html>";

	it("returns the html unchanged when no csp is given", () => {
		expect(buildAppFrameSrcdoc(html)).toBe(html);
	});

	it("injects a CSP meta tag right after <head> when a csp is given", () => {
		const csp: McpUiResourceCsp = { connectDomains: ["https://api.example.com"] };
		const out = buildAppFrameSrcdoc(html, csp);
		expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
		expect(out).toContain("connect-src 'self' https://api.example.com");
		// meta lands inside the head, before the title
		expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<title>"));
		expect(out.indexOf("<head>")).toBeLessThan(out.indexOf("Content-Security-Policy"));
	});

	it("synthesizes a <head> after <html> when the doc has html but no head", () => {
		const noHead = "<!doctype html><html><body>no head here</body></html>";
		const out = buildAppFrameSrcdoc(noHead, { connectDomains: ["https://api.example.com"] });
		expect(out).toContain('<head><meta http-equiv="Content-Security-Policy"');
		expect(out).toContain("connect-src 'self' https://api.example.com");
		expect(out.indexOf("<head>")).toBeLessThan(out.indexOf("<body>"));
	});

	it("prepends the meta when the html has no html/head/scaffold", () => {
		const bare = "<body>just a fragment</body>";
		const out = buildAppFrameSrcdoc(bare, { connectDomains: [] });
		expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
		expect(out).toContain("just a fragment");
		expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("just a fragment"));
	});
});

describe("frameAllowAttribute", () => {
	it("is empty for no permissions", () => {
		expect(frameAllowAttribute(undefined)).toBe("");
	});

	it("maps requested permissions to a Permission-Policy allow value", () => {
		const allow = frameAllowAttribute({ camera: {}, clipboardWrite: {} });
		expect(allow).toContain("camera");
		expect(allow).toContain("clipboard-write");
	});
});
