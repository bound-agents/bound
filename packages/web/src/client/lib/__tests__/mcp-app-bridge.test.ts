import { describe, expect, it } from "bun:test";
import {
	type UiResourceClient,
	buildDeviceContext,
	buildHostStyles,
	formatAppContentToMessage,
	getUiResource,
} from "../mcp-app-bridge";

const MIME = "text/html;profile=mcp-app";

function fakeClient(contents: unknown[]): UiResourceClient {
	return {
		readResource: async () =>
			({ contents }) as Awaited<ReturnType<UiResourceClient["readResource"]>>,
	};
}

describe("getUiResource", () => {
	it("returns html + csp + permissions from content-level _meta.ui", async () => {
		const client = fakeClient([
			{
				mimeType: MIME,
				text: "<html><body>app</body></html>",
				_meta: {
					ui: {
						csp: { connectDomains: ["https://api.example.com"] },
						permissions: { camera: {} },
					},
				},
			},
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.html).toBe("<html><body>app</body></html>");
		expect(data.csp).toEqual({ connectDomains: ["https://api.example.com"] });
		expect(data.permissions).toEqual({ camera: {} });
	});

	it("returns prefersBorder from content-level _meta.ui", async () => {
		const client = fakeClient([
			{
				mimeType: MIME,
				text: "<html><body>app</body></html>",
				_meta: { ui: { prefersBorder: false } },
			},
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.prefersBorder).toBe(false);
	});

	it("returns prefersBorder true when the view requests a frame", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>x</p>", _meta: { ui: { prefersBorder: true } } },
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.prefersBorder).toBe(true);
	});

	it("leaves prefersBorder undefined when the view omits it (host decides)", async () => {
		const client = fakeClient([{ mimeType: MIME, text: "<p>x</p>", _meta: { ui: {} } }]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.prefersBorder).toBeUndefined();
	});

	it("decodes base64 blob content", async () => {
		const html = "<html><body>blobbed</body></html>";
		const client = fakeClient([{ mimeType: MIME, blob: btoa(html) }]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.html).toBe(html);
	});

	it("accepts the Python-SDK `meta` spelling as a fallback", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>x</p>", meta: { ui: { csp: { connectDomains: [] } } } },
		]);
		const data = await getUiResource(client, "ui://x/app.html");
		expect(data.csp).toEqual({ connectDomains: [] });
	});

	it("prefers content-level meta over the listing-level fallback", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>x</p>", _meta: { ui: { permissions: { microphone: {} } } } },
		]);
		const data = await getUiResource(client, "ui://x/app.html", {
			permissions: { camera: {} },
		});
		expect(data.permissions).toEqual({ microphone: {} });
	});

	it("falls back to listing-level meta when content has none", async () => {
		const client = fakeClient([{ mimeType: MIME, text: "<p>x</p>" }]);
		const data = await getUiResource(client, "ui://x/app.html", {
			csp: { connectDomains: ["https://fallback.example.com"] },
		});
		expect(data.csp).toEqual({ connectDomains: ["https://fallback.example.com"] });
	});

	it("throws on the wrong MIME type", async () => {
		const client = fakeClient([{ mimeType: "text/html", text: "<p>x</p>" }]);
		await expect(getUiResource(client, "ui://x/app.html")).rejects.toThrow(/Unsupported MIME/);
	});

	it("throws when the resource has more than one content", async () => {
		const client = fakeClient([
			{ mimeType: MIME, text: "<p>a</p>" },
			{ mimeType: MIME, text: "<p>b</p>" },
		]);
		await expect(getUiResource(client, "ui://x/app.html")).rejects.toThrow(/exactly one/);
	});
});

describe("buildHostStyles", () => {
	it("maps bound palette vars into ext-apps host-style keys", () => {
		const palette: Record<string, string> = {
			"--paper": "#EFEAE0",
			"--paper-2": "#E8E2D5",
			"--ink": "#1A1814",
			"--rule-soft": "rgba(26,24,20,0.18)",
			"--font-mono": "JetBrains Mono, monospace",
		};
		const styles = buildHostStyles((v) => palette[v] ?? "");
		expect(styles.variables?.["--color-background-primary"]).toBe("#EFEAE0");
		expect(styles.variables?.["--color-background-secondary"]).toBe("#E8E2D5");
		expect(styles.variables?.["--color-text-primary"]).toBe("#1A1814");
		expect(styles.variables?.["--color-border-primary"]).toBe("rgba(26,24,20,0.18)");
		expect(styles.variables?.["--font-mono"]).toBe("JetBrains Mono, monospace");
	});

	it("trims values and omits keys whose bound var resolves blank", () => {
		const styles = buildHostStyles((v) => (v === "--paper" ? "  #EFEAE0  " : "   "));
		expect(styles.variables?.["--color-background-primary"]).toBe("#EFEAE0");
		expect("--color-text-primary" in (styles.variables ?? {})).toBe(false);
	});
});

describe("buildDeviceContext", () => {
	it("reports mobile for a touch-only (coarse pointer, no hover) device", () => {
		const ctx = buildDeviceContext({ coarsePointer: true, hover: false });
		expect(ctx.platform).toBe("mobile");
		expect(ctx.deviceCapabilities).toEqual({ touch: true, hover: false });
	});

	it("reports web for a hover-capable pointer device", () => {
		const ctx = buildDeviceContext({ coarsePointer: false, hover: true });
		expect(ctx.platform).toBe("web");
		expect(ctx.deviceCapabilities).toEqual({ touch: false, hover: true });
	});

	it("keeps web for a hybrid coarse+hover device (touch laptop)", () => {
		const ctx = buildDeviceContext({ coarsePointer: true, hover: true });
		expect(ctx.platform).toBe("web");
		expect(ctx.deviceCapabilities).toEqual({ touch: true, hover: true });
	});
});

describe("formatAppContentToMessage", () => {
	it("joins text content blocks with blank lines", () => {
		const text = formatAppContentToMessage({
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
		});
		expect(text).toBe("first\n\nsecond");
	});

	it("renders structuredContent as a fenced json block", () => {
		const text = formatAppContentToMessage({ structuredContent: { selected: 3, label: "x" } });
		expect(text).toBe('```json\n{\n  "selected": 3,\n  "label": "x"\n}\n```');
	});

	it("combines text content and structuredContent", () => {
		const text = formatAppContentToMessage({
			content: [{ type: "text", text: "the user picked:" }],
			structuredContent: { id: 7 },
		});
		expect(text).toBe('the user picked:\n\n```json\n{\n  "id": 7\n}\n```');
	});

	it("labels non-text content blocks by type rather than dropping them", () => {
		const text = formatAppContentToMessage({
			content: [
				{ type: "text", text: "see image" },
				{ type: "image", data: "…", mimeType: "image/png" },
			],
		});
		expect(text).toBe("see image\n\n[image content]");
	});

	it("returns an empty string when there is nothing to send", () => {
		expect(formatAppContentToMessage({})).toBe("");
		expect(formatAppContentToMessage({ content: [], structuredContent: {} })).toBe("");
	});
});
