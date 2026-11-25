import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ConnectorBindingsView loads GET /api/connectors/bindings (and GET
// /api/status/models for the picker) on mount, renders the list through a
// DataTable, drills into a detail view on row click, lets the operator change
// the binding's model (PATCH) or detach it (DELETE, behind a confirm()), and
// surfaces load/action errors. Children exercised: DataTable, TaskCard,
// ThreadLinkCard, Btn, SectionHeader, TicketTab, Page.

const dom = installDom({ url: "http://localhost/#/connections" });
afterAll(() => dom.teardown());

// handleDetach gates on window.confirm; default it to true, restore per test.
let confirmResult = true;
Object.defineProperty(dom.window, "confirm", {
	configurable: true,
	writable: true,
	value: () => confirmResult,
});
(globalThis as Record<string, unknown>).confirm = () => confirmResult;

afterEach(() => {
	confirmResult = true;
});

function sampleBinding(overrides: Record<string, unknown> = {}) {
	return {
		id: "handle-1",
		server_name: "github",
		event_name: "issues.opened",
		event_args: { repo: "bound-agents/bound" },
		event_args_raw: '{"repo":"bound-agents/bound"}',
		delivery_mode: "wakeup",
		cursor: null,
		task_id: "task-1",
		created_at: "2026-11-19T00:00:00.000Z",
		modified_at: "2026-11-19T00:00:00.000Z",
		task_status: "pending",
		task_thread_id: null,
		task_trigger_spec: null,
		model_hint: null,
		thread_title: null,
		...overrides,
	};
}

const MODELS_RESPONSE = {
	default: "gpt-x",
	models: [
		{ id: "gpt-x", provider: "p", host: "local", via: "local", status: "local" },
		{ id: "haiku", provider: "p", host: "peer", via: "relay", status: "online" },
	],
};

async function mountView(bindings: unknown[], opts: { models?: boolean } = {}) {
	dom.route("GET", "/api/connectors/bindings", () => ({ bindings }));
	if (opts.models !== false) dom.route("GET", "/api/status/models", () => MODELS_RESPONSE);
	// TaskCard mounts for bindings with a task_id and fetches GET /api/tasks/:id.
	dom.route("GET", /^\/api\/tasks\//, () => ({
		id: "task-1",
		displayName: "issues.opened delivery",
		status: "pending",
		schedule: "on github:issues.opened",
		thread_id: null,
	}));
	const View = (await import("../../views/ConnectorBindingsView.svelte")).default;
	const mounted = await dom.mount(View, {});
	await dom.settle();
	return mounted;
}

describe("ConnectorBindingsView", () => {
	it("loads bindings and renders them in the list table", async () => {
		const { target } = await mountView([
			sampleBinding(),
			sampleBinding({ id: "handle-2", server_name: "discord", event_name: "message.create" }),
		]);
		expect(dom.requests.some((r) => r.path === "/api/connectors/bindings")).toBe(true);
		expect(target.textContent).toContain("github");
		expect(target.textContent).toContain("discord");
		// Header count reflects the two active bindings.
		expect(target.textContent).toContain("Connector bindings · 2");
	});

	it("shows the empty state when there are no bindings", async () => {
		const { target } = await mountView([]);
		expect(target.textContent).toContain("No connector bindings configured yet.");
	});

	it("drills into the detail view on row click and shows binding fields", async () => {
		const { target } = await mountView([sampleBinding()]);
		const row = target.querySelector(".data-row");
		expect(row).not.toBeNull();
		await dom.fire(row as Element, "click");
		// Detail header shows "server:event".
		expect(target.textContent).toContain("github:issues.opened");
		// Handle id and event args block are rendered.
		expect(target.textContent).toContain("handle-1");
		expect(target.textContent).toContain("bound-agents/bound");
		// Delivery mode field.
		expect(target.textContent).toContain("wakeup");
	});

	it("PATCHes the model when the operator picks one and saves", async () => {
		let patched: unknown = null;
		dom.route("PATCH", "/api/connectors/bindings/handle-1", (req) => {
			patched = req.body;
			return sampleBinding({ model_hint: "haiku" });
		});
		const { target } = await mountView([sampleBinding()]);
		const row = target.querySelector(".data-row");
		await dom.fire(row as Element, "click");

		const select = target.querySelector("#binding-model") as HTMLSelectElement;
		expect(select).not.toBeNull();
		await dom.type(select, "haiku");

		// The Save button enables once editModel differs from the binding's model.
		const saveBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Save",
		);
		expect(saveBtn).toBeTruthy();
		expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
		await dom.fire(saveBtn as Element, "click");

		expect(patched).toEqual({ model_hint: "haiku" });
		// After the PATCH the view reloads bindings.
		expect(
			dom.requests.filter((r) => r.path === "/api/connectors/bindings").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("detaches a binding when confirmed and returns to the list", async () => {
		let deleted = false;
		dom.route("DELETE", "/api/connectors/bindings/handle-1", () => {
			deleted = true;
			return new Response(null, { status: 204 });
		});
		const { target } = await mountView([sampleBinding()]);
		const row = target.querySelector(".data-row");
		await dom.fire(row as Element, "click");

		const detachBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Detach",
		);
		expect(detachBtn).toBeTruthy();
		// Second load returns an empty list, so the detail view falls back to list.
		dom.route("GET", "/api/connectors/bindings", () => ({ bindings: [] }));
		await dom.fire(detachBtn as Element, "click");
		expect(deleted).toBe(true);
		expect(target.textContent).toContain("No connector bindings configured yet.");
	});

	it("does not detach when the confirm is cancelled", async () => {
		let deleted = false;
		dom.route("DELETE", "/api/connectors/bindings/handle-1", () => {
			deleted = true;
			return new Response(null, { status: 204 });
		});
		confirmResult = false;
		const { target } = await mountView([sampleBinding()]);
		const row = target.querySelector(".data-row");
		await dom.fire(row as Element, "click");
		const detachBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Detach",
		);
		await dom.fire(detachBtn as Element, "click");
		expect(deleted).toBe(false);
	});

	it("explains that a binding without a backing task cannot set a model", async () => {
		const { target } = await mountView([sampleBinding({ task_id: null })]);
		const row = target.querySelector(".data-row");
		await dom.fire(row as Element, "click");
		expect(target.textContent).toContain("No associated task; model cannot be set.");
		// No model <select> is rendered without a task.
		expect(target.querySelector("#binding-model")).toBeNull();
	});

	it("shows an error banner when the bindings request fails", async () => {
		dom.route("GET", "/api/connectors/bindings", () => new Response("boom", { status: 500 }));
		dom.route("GET", "/api/status/models", () => MODELS_RESPONSE);
		const View = (await import("../../views/ConnectorBindingsView.svelte")).default;
		const { target } = await dom.mount(View, {});
		await dom.settle();
		expect(target.querySelector(".error-banner")).not.toBeNull();
		// The banner can be dismissed.
		const dismiss = target.querySelector(".dismiss-btn");
		await dom.fire(dismiss as Element, "click");
		expect(target.querySelector(".error-banner")).toBeNull();
	});
});
