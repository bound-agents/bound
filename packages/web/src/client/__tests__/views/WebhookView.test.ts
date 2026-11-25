import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ClusterModelInfo, WebhookListEntry, WebhookUrlEntry } from "@bound/client";
import { installDom } from "../harness/dom";

const dom = installDom();
afterAll(() => dom.teardown());

/** Query a required element; throws (rather than returning null) so tests read
 * without non-null assertions. */
function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`no element for selector: ${selector}`);
	return el;
}

/** Find a required <button> by predicate; throws if none matches. */
function findButton(
	root: ParentNode,
	predicate: (b: HTMLButtonElement) => boolean | undefined,
): HTMLButtonElement {
	const btn = [...root.querySelectorAll("button")].find(predicate);
	if (!btn) throw new Error("no matching button");
	return btn;
}

/** The last <form> under root; throws if there are none. */
function lastForm(root: ParentNode): HTMLFormElement {
	const form = [...root.querySelectorAll("form")].at(-1);
	if (!form) throw new Error("no form present");
	return form;
}

// Components reach the server through the shared BoundClient in lib/bound.ts,
// which issues relative-path fetches. The harness fakes fetch via its route
// table, so these tests assert on what the operator sees (rendered list,
// forms, error banners) and what the component sends (dom.requests).
const WebhookView = (await import("../../views/WebhookView.svelte")).default;

function makeWebhook(over: Partial<WebhookListEntry> = {}): WebhookListEntry {
	return {
		id: "wh-1",
		name: "github-push",
		signature_format: "github",
		description: "Push events",
		task_id: "task-1",
		thread_id: "thread-1",
		created_at: "2026-01-02T00:00:00.000Z",
		modified_at: "2026-01-03T00:00:00.000Z",
		prompt: null,
		model_hint: null,
		no_history: false,
		...over,
	};
}

const MODELS: ClusterModelInfo[] = [
	{ id: "opus", host: "local", via: "local", status: "online" } as ClusterModelInfo,
	{ id: "glm-5", host: "msi", via: "relay", status: "offline?" } as ClusterModelInfo,
];

/** Register the three onMount loads with sensible defaults; override per-test by
 * re-registering (later routes win in the harness). */
function baseRoutes(webhooks: WebhookListEntry[]): void {
	dom.route("GET", "/api/webhooks", () => webhooks);
	dom.route("GET", "/api/status/models", () => ({ models: MODELS, default: "opus" }));
	dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
		allow_unauthenticated: false,
	}));
}

beforeEach(() => {
	dom.requests.length = 0;
	globalThis.confirm = () => true;
});

describe("WebhookView — list", () => {
	it("loads and renders webhooks with the active count", async () => {
		baseRoutes([makeWebhook(), makeWebhook({ id: "wh-2", name: "stripe-hook" })]);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();

		expect(target.textContent).toContain("github-push");
		expect(target.textContent).toContain("stripe-hook");
		expect(target.textContent).toContain("Webhooks · 2");
		expect(target.textContent).toContain("2 active");
		// Date column formatted, not raw ISO.
		expect(target.textContent).not.toContain("2026-01-02T00:00:00.000Z");

		const paths = dom.requests.map((r) => r.path);
		expect(paths).toContain("/api/webhooks");
		expect(paths).toContain("/api/status/models");
		expect(paths).toContain("/api/webhooks/unauthenticated-switch");
		unmount();
	});

	it("shows the empty state when there are no webhooks", async () => {
		baseRoutes([]);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		expect(target.textContent).toContain("No webhooks configured yet.");
		expect(target.textContent).toContain("Webhooks · 0");
		unmount();
	});

	it("renders an error banner when the list load fails, dismissable", async () => {
		dom.route("GET", "/api/webhooks", () => new Response("boom", { status: 500 }));
		dom.route("GET", "/api/status/models", () => ({ models: [], default: "" }));
		dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
			allow_unauthenticated: false,
		}));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();

		const banner = target.querySelector(".error-banner");
		expect(banner).not.toBeNull();
		const dismiss = target.querySelector<HTMLButtonElement>(".dismiss-btn");
		expect(dismiss).not.toBeNull();
		await dom.fire(dismiss, "click");
		expect(target.querySelector(".error-banner")).toBeNull();
		unmount();
	});
});

describe("WebhookView — unauthenticated switch", () => {
	it("reflects the loaded switch state and flips it on toggle", async () => {
		baseRoutes([makeWebhook()]);
		dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
			allow_unauthenticated: false,
		}));
		dom.route("PUT", "/api/webhooks/unauthenticated-switch", (req) => ({
			allow_unauthenticated: (req.body as { allow_unauthenticated: boolean }).allow_unauthenticated,
		}));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();

		const toggle = target.querySelector<HTMLInputElement>(".unauth-toggle input");
		expect(toggle).not.toBeNull();
		expect(toggle.checked).toBe(false);

		toggle.checked = true;
		await dom.fire(toggle, "change");

		const put = dom.requests.find(
			(r) => r.method === "PUT" && r.path === "/api/webhooks/unauthenticated-switch",
		);
		expect(put).toBeTruthy();
		expect((put.body as { allow_unauthenticated: boolean }).allow_unauthenticated).toBe(true);
		unmount();
	});

	it("surfaces a switch error without crashing the view", async () => {
		baseRoutes([makeWebhook()]);
		dom.route(
			"PUT",
			"/api/webhooks/unauthenticated-switch",
			() => new Response("nope", { status: 403 }),
		);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		const toggle = target.querySelector<HTMLInputElement>(".unauth-toggle input");
		toggle.checked = true;
		await dom.fire(toggle, "change");
		// List still rendered; the switch error is held in component state.
		expect(target.textContent).toContain("github-push");
		unmount();
	});
});

describe("WebhookView — create", () => {
	it("validates a missing name before sending anything", async () => {
		baseRoutes([]);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();

		// Enter create view.
		const newBtn = findButton(target, (b) => b.textContent?.includes("New Webhook"));
		await dom.fire(newBtn, "click");
		expect(target.textContent).toContain("Create Webhook");

		const form = q(target, "form");
		await dom.fire(form, "submit");
		expect(target.textContent).toContain("Name is required");
		expect(dom.requests.some((r) => r.method === "POST")).toBe(false);
		unmount();
	});

	it("creates a webhook, shows the secret modal, and reloads the list", async () => {
		const created = makeWebhook({ id: "wh-new", name: "my-hook" });
		let listCalls = 0;
		dom.route("GET", "/api/webhooks", () => {
			listCalls++;
			return listCalls === 1 ? [] : [created];
		});
		dom.route("GET", "/api/status/models", () => ({ models: MODELS, default: "opus" }));
		dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
			allow_unauthenticated: false,
		}));
		dom.route("POST", "/api/webhooks", (req) => ({
			...created,
			name: (req.body as { name: string }).name,
			secret: "sekret-123",
		}));

		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		const newBtn = findButton(target, (b) => b.textContent?.includes("New Webhook"));
		await dom.fire(newBtn, "click");

		const nameInput = q<HTMLInputElement>(target, "#name");
		await dom.type(nameInput, "my-hook");
		const descInput = q<HTMLInputElement>(target, "#description");
		await dom.type(descInput, "a description");

		const form = q(target, "form");
		await dom.fire(form, "submit");
		await dom.settle();

		const post = dom.requests.find((r) => r.method === "POST" && r.path === "/api/webhooks");
		expect(post).toBeTruthy();
		const body = post.body as Record<string, unknown>;
		expect(body.name).toBe("my-hook");
		expect(body.description).toBe("a description");
		expect(body.format).toBe("github");

		// Secret modal visible with the returned secret.
		expect(target.textContent).toContain("sekret-123");
		unmount();
	});

	it("surfaces a create error and stays on the form", async () => {
		baseRoutes([]);
		dom.route("POST", "/api/webhooks", () => new Response("bad", { status: 400 }));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		const newBtn = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("New Webhook"),
		);
		await dom.fire(newBtn, "click");
		await dom.type(q<HTMLInputElement>(target, "#name"), "x");
		await dom.fire(q(target, "form"), "submit");
		await dom.settle();
		expect(target.querySelector(".error-box")).not.toBeNull();
		expect(target.textContent).toContain("Create Webhook");
		unmount();
	});

	it("Cancel returns to the list view", async () => {
		baseRoutes([makeWebhook()]);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(
			[...target.querySelectorAll("button")].find((b) => b.textContent?.includes("New Webhook")),
			"click",
		);
		expect(target.textContent).toContain("Create Webhook");
		const cancel = [...target.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Cancel",
		);
		await dom.fire(cancel, "click");
		expect(target.textContent).toContain("Webhooks · 1");
		unmount();
	});
});

describe("WebhookView — detail", () => {
	async function openDetail(over: Partial<WebhookListEntry> = {}) {
		const wh = makeWebhook(over);
		baseRoutes([wh]);
		const urls: WebhookUrlEntry[] = [
			{ url: "https://hub.example/webhook/github-push", source: "hub" },
			{ url: "http://localhost:3000/webhook/github-push", source: "local", host_name: "me" },
			{ url: "https://peer.example/webhook/github-push", source: "cluster", host_name: "peer" },
		];
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => ({ name: wh.name, urls }));
		const mounted = await dom.mount(WebhookView);
		await dom.settle();
		// DataTable renders each clickable row as a div.data-row with role="button".
		const row = mounted.target.querySelector<HTMLElement>(".data-row");
		expect(row).not.toBeNull();
		await dom.fire(row, "click");
		await dom.settle();
		return { wh, ...mounted };
	}

	it("opens detail, lists cluster URLs with source labels, and loads them", async () => {
		const { target, unmount } = await openDetail();
		expect(target.textContent).toContain("Endpoint URLs");
		expect(target.textContent).toContain("Hub");
		expect(target.textContent).toContain("Local (me)");
		expect(target.textContent).toContain("Cluster (peer)");
		expect(target.textContent).toContain("https://hub.example/webhook/github-push");
		const urlReq = dom.requests.find((r) => /\/urls$/.test(r.path));
		expect(urlReq).toBeTruthy();
		unmount();
	});

	it("updates the webhook via PATCH with the edited description", async () => {
		const { wh, target, unmount } = await openDetail();
		dom.route("PATCH", /\/api\/webhooks\/[^/]+$/, () => wh);
		const editDesc = q<HTMLInputElement>(target, "#edit-description");
		await dom.type(editDesc, "new description");
		const saveForm = lastForm(target);
		await dom.fire(saveForm, "submit");
		await dom.settle();
		const patch = dom.requests.find((r) => r.method === "PATCH");
		expect(patch).toBeTruthy();
		expect((patch.body as { description: string }).description).toBe("new description");
		unmount();
	});

	it("rotates the secret and shows the modal", async () => {
		const { target, unmount } = await openDetail();
		dom.route("POST", /\/api\/webhooks\/[^/]+\/rotate$/, () => ({ secret: "rotated-999" }));
		const rotateBtn = findButton(target, (b) => b.textContent?.includes("Rotate Secret"));
		await dom.fire(rotateBtn, "click");
		await dom.settle();
		expect(dom.requests.some((r) => /\/rotate$/.test(r.path))).toBe(true);
		expect(target.textContent).toContain("rotated-999");
		unmount();
	});

	it("does not rotate when the confirm dialog is declined", async () => {
		globalThis.confirm = () => false;
		const { target, unmount } = await openDetail();
		const rotateBtn = findButton(target, (b) => b.textContent?.includes("Rotate Secret"));
		await dom.fire(rotateBtn, "click");
		await dom.settle();
		expect(dom.requests.some((r) => /\/rotate$/.test(r.path))).toBe(false);
		globalThis.confirm = () => true;
		unmount();
	});
	it("deletes the webhook (confirmed) and returns to the list", async () => {
		const { target, unmount } = await openDetail();
		dom.route("DELETE", /\/api\/webhooks\/[^/]+$/, () => new Response(null, { status: 204 }));
		dom.route("GET", "/api/webhooks", () => []);
		const delBtn = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Delete"),
		);
		await dom.fire(delBtn, "click");
		await dom.settle();
		expect(dom.requests.some((r) => r.method === "DELETE")).toBe(true);
		expect(target.textContent).toContain("No webhooks configured yet.");
		unmount();
	});

	it("does not delete when the confirm dialog is declined", async () => {
		globalThis.confirm = () => false;
		const { target, unmount } = await openDetail();
		dom.route("DELETE", /\/api\/webhooks\/[^/]+$/, () => new Response(null, { status: 204 }));
		const delBtn = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Delete"),
		);
		await dom.fire(delBtn, "click");
		await dom.settle();
		expect(dom.requests.some((r) => r.method === "DELETE")).toBe(false);
		unmount();
	});

	it("Back returns to the list from detail", async () => {
		const { target, unmount } = await openDetail();
		const back = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Back"),
		);
		await dom.fire(back, "click");
		expect(target.textContent).toContain("Webhooks · 1");
		unmount();
	});
});

describe("WebhookView — branches and error paths", () => {
	it("renders the model dropdown options including the relay/offline suffix", async () => {
		baseRoutes([makeWebhook()]);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(
			[...target.querySelectorAll("button")].find((b) => b.textContent?.includes("New Webhook")),
			"click",
		);
		const modelSelect = q<HTMLSelectElement>(target, "#create-model");
		const optionText = [...modelSelect.options].map((o) => o.textContent).join(" | ");
		expect(optionText).toContain("Cluster default (opus)");
		expect(optionText).toContain("opus");
		// relay model shows host suffix and offline marker.
		expect(optionText).toContain("glm-5 — msi (offline?)");
		unmount();
	});

	it("shows the 'none' format option only once unauthenticated webhooks are allowed", async () => {
		baseRoutes([makeWebhook()]);
		dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
			allow_unauthenticated: true,
		}));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(
			findButton(target, (b) => b.textContent?.includes("New Webhook")),
			"click",
		);
		const formatSelect = q<HTMLSelectElement>(target, "#format");
		const values = [...formatSelect.options].map((o) => o.value);
		expect(values).toContain("none");
		unmount();
	});

	it("snaps a selected 'none' format back to github when the switch is turned off", async () => {
		baseRoutes([makeWebhook()]);
		let allow = true;
		dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
			allow_unauthenticated: allow,
		}));
		dom.route("PUT", "/api/webhooks/unauthenticated-switch", (req) => {
			allow = (req.body as { allow_unauthenticated: boolean }).allow_unauthenticated;
			return { allow_unauthenticated: allow };
		});
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		// Go to create, pick 'none'.
		await dom.fire(
			findButton(target, (b) => b.textContent?.includes("New Webhook")),
			"click",
		);
		const formatSelect = q<HTMLSelectElement>(target, "#format");
		await dom.type(formatSelect, "none");
		expect(formatSelect.value).toBe("none");
		// Back to list and turn the switch off.
		await dom.fire(
			findButton(target, (b) => b.textContent?.trim() === "Cancel"),
			"click",
		);
		const toggle = q<HTMLInputElement>(target, ".unauth-toggle input");
		toggle.checked = false;
		await dom.fire(toggle, "change");
		await dom.settle();
		// Re-enter create — the format should have snapped back to github.
		await dom.fire(
			findButton(target, (b) => b.textContent?.includes("New Webhook")),
			"click",
		);
		expect(q<HTMLSelectElement>(target, "#format").value).toBe("github");
		unmount();
	});

	it("tolerates a failed models load (best-effort dropdown)", async () => {
		dom.route("GET", "/api/webhooks", () => [makeWebhook()]);
		dom.route("GET", "/api/status/models", () => new Response("err", { status: 500 }));
		dom.route("GET", "/api/webhooks/unauthenticated-switch", () => ({
			allow_unauthenticated: false,
		}));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		// List still renders; dropdown falls back to the free-text default.
		expect(target.textContent).toContain("github-push");
		unmount();
	});

	it("renders a urls error in detail when the URL enumeration fails", async () => {
		const wh = makeWebhook();
		baseRoutes([wh]);
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => new Response("nope", { status: 500 }));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(q<HTMLElement>(target, ".data-row"), "click");
		await dom.settle();
		expect(target.querySelector(".error-text")).not.toBeNull();
		unmount();
	});

	it("renders the no-URLs empty state in detail", async () => {
		const wh = makeWebhook();
		baseRoutes([wh]);
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => ({ name: wh.name, urls: [] }));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(q<HTMLElement>(target, ".data-row"), "click");
		await dom.settle();
		expect(target.textContent).toContain("No URLs available.");
		unmount();
	});

	it("surfaces an update error in detail", async () => {
		const wh = makeWebhook();
		baseRoutes([wh]);
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => ({ name: wh.name, urls: [] }));
		dom.route("PATCH", /\/api\/webhooks\/[^/]+$/, () => new Response("bad", { status: 400 }));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(q<HTMLElement>(target, ".data-row"), "click");
		await dom.settle();
		const saveForm = lastForm(target);
		await dom.fire(saveForm, "submit");
		await dom.settle();
		expect(target.querySelector(".error-box")).not.toBeNull();
		unmount();
	});

	it("surfaces a rotate error in detail", async () => {
		const wh = makeWebhook();
		baseRoutes([wh]);
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => ({ name: wh.name, urls: [] }));
		dom.route(
			"POST",
			/\/api\/webhooks\/[^/]+\/rotate$/,
			() => new Response("bad", { status: 500 }),
		);
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(q<HTMLElement>(target, ".data-row"), "click");
		await dom.settle();
		await dom.fire(
			findButton(target, (b) => b.textContent?.includes("Rotate Secret")),
			"click",
		);
		await dom.settle();
		expect(target.querySelector(".error-box")).not.toBeNull();
		unmount();
	});

	it("resets the edit form to the selected webhook's values", async () => {
		const wh = makeWebhook({ description: "original desc" });
		baseRoutes([wh]);
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => ({ name: wh.name, urls: [] }));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(q<HTMLElement>(target, ".data-row"), "click");
		await dom.settle();
		const editDesc = q<HTMLInputElement>(target, "#edit-description");
		await dom.type(editDesc, "changed");
		expect(editDesc.value).toBe("changed");
		const resetBtn = [...target.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Reset",
		);
		await dom.fire(resetBtn, "click");
		expect(q<HTMLInputElement>(target, "#edit-description").value).toBe("original desc");
		unmount();
	});

	it("surfaces a delete error in detail when the API rejects", async () => {
		const wh = makeWebhook();
		baseRoutes([wh]);
		dom.route("GET", /\/api\/webhooks\/[^/]+\/urls$/, () => ({ name: wh.name, urls: [] }));
		dom.route("DELETE", /\/api\/webhooks\/[^/]+$/, () => new Response("bad", { status: 500 }));
		const { target, unmount } = await dom.mount(WebhookView);
		await dom.settle();
		await dom.fire(q<HTMLElement>(target, ".data-row"), "click");
		await dom.settle();
		await dom.fire(
			findButton(target, (b) => b.textContent?.includes("Delete")),
			"click",
		);
		await dom.settle();
		expect(target.querySelector(".error-banner")).not.toBeNull();
		unmount();
	});
});
