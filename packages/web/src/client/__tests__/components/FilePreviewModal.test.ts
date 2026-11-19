import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { FileMetadata } from "../../lib/file-tree";
import { installDom } from "../harness/dom";

// FilePreviewModal fetches a file via client.getFile (GET /api/files/<path>),
// then renders it by category: code/markdown go through dynamic markdown
// imports, images build a blob URL, text/binary render raw. Escape + the close
// buttons call onClose; Download navigates to the download endpoint.

// One harness for the whole file (matches harness.test.ts): a per-test
// reinstall races the harness's async svelte unmount against the restored
// globals. Routes are re-registered per test; later registrations win.
const dom = installDom({ url: "http://localhost/#/files" });
afterAll(() => dom.teardown());

// jsdom lacks Blob URL support; record createObjectURL / revokeObjectURL.
// `window.location.href = ...` navigation is silently dropped by jsdom and
// cannot be observed, so the download tests only drive the handler (covering
// its body) rather than asserting the resulting (dropped) navigation.
const createdBlobs: Blob[] = [];
const revoked: string[] = [];
(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (
	b: Blob,
) => {
	createdBlobs.push(b);
	return `blob:fake/${createdBlobs.length}`;
};
(globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (
	u: string,
) => {
	revoked.push(u);
};

let FilePreviewModal: typeof import("../../components/FilePreviewModal.svelte").default;

function meta(over: Partial<FileMetadata>): FileMetadata {
	return {
		id: "f1",
		path: "notes.txt",
		is_binary: 0,
		size_bytes: 10,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		created_by: null,
		host_origin: null,
		deleted: 0,
		...over,
	} as FileMetadata;
}

beforeEach(() => {
	createdBlobs.length = 0;
	revoked.length = 0;
});

async function load() {
	FilePreviewModal = (await import("../../components/FilePreviewModal.svelte")).default;
	return FilePreviewModal;
}

describe("FilePreviewModal", () => {
	it("shows a loading state while the fetch is in flight, then resolves", async () => {
		let release: (() => void) | null = null;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		dom.route("GET", /\/api\/files\//, async () => {
			await gate;
			return { path: "notes.txt", content: "hello world", is_binary: 0, size_bytes: 11 };
		});
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {},
		});
		// Fetch pending: loading UI visible.
		expect(target.textContent).toContain("Loading preview");
		release?.();
		await dom.settle();
		expect(target.textContent).not.toContain("Loading preview");
		expect(target.querySelector(".preview-text")?.textContent).toBe("hello world");
		unmount();
	});

	it("renders plain text content in a <pre>", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "notes.txt",
			content: "line one\nline two",
			is_binary: 0,
			size_bytes: 17,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {},
		});
		await dom.settle();
		const pre = target.querySelector("pre.preview-text");
		expect(pre?.textContent).toBe("line one\nline two");
		expect(dom.requests.some((r) => r.path === "/api/files/notes.txt")).toBe(true);
		unmount();
	});

	it("renders an empty file with the empty-state message", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "empty.txt",
			content: "",
			is_binary: 0,
			size_bytes: 0,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "empty.txt", size_bytes: 0 }),
			onClose() {},
		});
		await dom.settle();
		expect(target.querySelector(".modal-empty")?.textContent).toContain("This file is empty");
		unmount();
	});

	it("surfaces a fetch error and retries on Retry click", async () => {
		let attempt = 0;
		dom.route("GET", /\/api\/files\//, () => {
			attempt++;
			if (attempt === 1) {
				return new Response(JSON.stringify({ error: "boom" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			return { path: "notes.txt", content: "recovered", is_binary: 0, size_bytes: 9 };
		});
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {},
		});
		await dom.settle();
		const errBox = target.querySelector(".modal-error");
		expect(errBox).not.toBeNull();
		expect(errBox?.textContent).toContain("boom");
		const retry = target.querySelector(".retry-btn") as HTMLButtonElement;
		await dom.fire(retry, "click");
		await dom.settle();
		expect(target.querySelector(".modal-error")).toBeNull();
		expect(target.querySelector(".preview-text")?.textContent).toBe("recovered");
		expect(attempt).toBe(2);
		unmount();
	});

	it("renders highlighted code for a .ts file", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "x.ts",
			content: "const a = 1;",
			is_binary: 0,
			size_bytes: 12,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "x.ts" }),
			onClose() {},
		});
		await dom.settle();
		const codeBox = target.querySelector(".preview-code");
		expect(codeBox).not.toBeNull();
		// highlightCode wraps output in a <pre>; the source text survives.
		expect(codeBox?.textContent).toContain("const a = 1;");
		unmount();
	});

	it("renders markdown to HTML for a .md file", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "r.md",
			content: "# Title\n\nbody text",
			is_binary: 0,
			size_bytes: 18,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "r.md" }),
			onClose() {},
		});
		await dom.settle();
		const mdBox = target.querySelector(".preview-markdown");
		expect(mdBox).not.toBeNull();
		expect(mdBox?.querySelector("h1")?.textContent).toContain("Title");
		unmount();
	});

	it("builds a blob URL for a raw-text SVG image (is_binary=0)", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "logo.svg",
			content: "<svg></svg>",
			is_binary: 0,
			size_bytes: 11,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "logo.svg", is_binary: 0 }),
			onClose() {},
		});
		await dom.settle();
		const img = target.querySelector(".preview-image img") as HTMLImageElement;
		expect(img).not.toBeNull();
		expect(img.getAttribute("src")).toMatch(/^blob:fake\//);
		expect(createdBlobs.length).toBe(1);
		expect(createdBlobs[0].type).toBe("image/svg+xml");
		unmount();
	});

	it("decodes base64 for a binary image (is_binary=1)", async () => {
		// "AAAA" decodes to 3 zero bytes.
		dom.route("GET", /\/api\/files\//, () => ({
			path: "pic.png",
			content: "AAAA",
			is_binary: 1,
			size_bytes: 3,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "pic.png", is_binary: 1 }),
			onClose() {},
		});
		await dom.settle();
		const img = target.querySelector(".preview-image img") as HTMLImageElement;
		expect(img).not.toBeNull();
		expect(createdBlobs.length).toBe(1);
		expect(createdBlobs[0].type).toBe("image/png");
		unmount();
	});

	it("renders the binary fallback for an unknown binary type", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "data.bin",
			content: "AAAA",
			is_binary: 1,
			size_bytes: 3,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "data.bin", is_binary: 1 }),
			onClose() {},
		});
		await dom.settle();
		expect(target.querySelector(".preview-binary")?.textContent).toContain("Preview not available");
		// The binary fallback exposes a download button; firing it runs download()
		// (jsdom drops the navigation but the handler body executes).
		const bigBtn = target.querySelector(".download-btn-large") as HTMLButtonElement;
		expect(bigBtn).not.toBeNull();
		await dom.fire(bigBtn, "click");
		unmount();
	});

	it("calls onClose when the header close button is clicked", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "notes.txt",
			content: "hi",
			is_binary: 0,
			size_bytes: 2,
		}));
		let closed = 0;
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {
				closed++;
			},
		});
		await dom.settle();
		const closeBtn = target.querySelector(".close-btn") as HTMLButtonElement;
		await dom.fire(closeBtn, "click");
		expect(closed).toBe(1);
		unmount();
	});

	it("calls onClose when the backdrop is clicked", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "notes.txt",
			content: "hi",
			is_binary: 0,
			size_bytes: 2,
		}));
		let closed = 0;
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {
				closed++;
			},
		});
		await dom.settle();
		const backdrop = target.querySelector(".backdrop-close") as HTMLButtonElement;
		await dom.fire(backdrop, "click");
		expect(closed).toBe(1);
		unmount();
	});

	it("closes on Escape keydown and does not close on other keys", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "notes.txt",
			content: "hi",
			is_binary: 0,
			size_bytes: 2,
		}));
		let closed = 0;
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {
				closed++;
			},
		});
		await dom.settle();
		const panel = target.querySelector(".modal-panel") as HTMLElement;
		await dom.fire(panel, "keydown", { key: "a" });
		expect(closed).toBe(0);
		await dom.fire(panel, "keydown", { key: "Escape" });
		expect(closed).toBe(1);
		unmount();
	});

	it("wraps Tab focus from last to first element (focus trap)", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "notes.txt",
			content: "hi",
			is_binary: 0,
			size_bytes: 2,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "notes.txt" }),
			onClose() {},
		});
		await dom.settle();
		const panel = target.querySelector(".modal-panel") as HTMLElement;
		const focusable = panel.querySelectorAll<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		expect(focusable.length).toBeGreaterThan(0);
		const last = focusable[focusable.length - 1];
		const first = focusable[0];
		last.focus();
		expect(dom.document.activeElement).toBe(last);
		// Tab at the last element wraps to the first.
		await dom.fire(panel, "keydown", { key: "Tab" });
		expect(dom.document.activeElement).toBe(first);
		// Shift+Tab at the first element wraps to the last.
		await dom.fire(panel, "keydown", { key: "Tab", shiftKey: true });
		expect(dom.document.activeElement).toBe(last);
		unmount();
	});

	it("navigates to the download endpoint when Download is clicked", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "my file.txt",
			content: "hi",
			is_binary: 0,
			size_bytes: 2,
		}));
		const Comp = await load();
		const { target, unmount } = await dom.mount(Comp, {
			file: meta({ path: "my file.txt" }),
			onClose() {},
		});
		await dom.settle();
		const dl = target.querySelector(".action-btn") as HTMLButtonElement;
		expect(dl?.textContent).toContain("Download");
		// Firing the header Download button runs download() (jsdom drops the
		// window.location.href navigation but the handler body executes).
		await dom.fire(dl, "click");
		unmount();
	});

	it("revokes the blob URL on unmount", async () => {
		dom.route("GET", /\/api\/files\//, () => ({
			path: "logo.svg",
			content: "<svg></svg>",
			is_binary: 0,
			size_bytes: 11,
		}));
		const Comp = await load();
		const { unmount } = await dom.mount(Comp, {
			file: meta({ path: "logo.svg", is_binary: 0 }),
			onClose() {},
		});
		await dom.settle();
		expect(createdBlobs.length).toBe(1);
		unmount();
		await dom.settle();
		expect(revoked.length).toBe(1);
		expect(revoked[0]).toMatch(/^blob:fake\//);
	});
});
