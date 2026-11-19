import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// AuxInvokeCard: inline card for an aux-agent invocation. It composes the
// ThreadLinkCard shell plus a StatusChip, needs no fetch (everything is
// derived from props), and shows an "Underway…" pending note only while the
// status is "running". These tests assert the name, the mapped chip label,
// the open-link vs pending-note states, and navigation.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountCard(props: Record<string, unknown>) {
	const AuxInvokeCard = (await import("../../components/AuxInvokeCard.svelte")).default;
	const handle = await dom.mount(AuxInvokeCard, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("AuxInvokeCard", () => {
	it("renders the aux name and running status with the pending note", async () => {
		const { target } = await mountCard({
			agentName: "reviewer",
			threadId: null,
			status: "running",
		});
		expect(target.querySelector(".ac-name")?.textContent).toBe("aux: reviewer");
		// StatusChip maps running → "Running".
		expect(target.querySelector(".status-chip .label")?.textContent).toBe("Running");
		// Running + no thread yet → pending note, no open button.
		expect(target.querySelector(".tl-pending-note")?.textContent).toBe("Underway…");
		expect(target.querySelector(".tl-open")).toBeNull();
	});

	it("shows the open link once the aux child thread resolves", async () => {
		const { target } = await mountCard({
			agentName: "implementer",
			threadId: "aux-thread-7",
			status: "completed",
		});
		expect(target.querySelector(".status-chip .label")?.textContent).toBe("Completed");
		const open = target.querySelector(".tl-open");
		expect(open).not.toBeNull();
		expect(target.querySelector(".tl-pending-note")).toBeNull();
		await dom.fire(open as Element, "click");
		expect(dom.window.location.hash).toBe("#/line/aux-thread-7");
	});

	it("shows no pending note for a failed aux with no thread", async () => {
		const { target } = await mountCard({
			agentName: "builder",
			threadId: null,
			status: "failed",
		});
		expect(target.querySelector(".status-chip .label")?.textContent).toBe("Failed");
		expect(target.querySelector(".tl-pending-note")).toBeNull();
		expect(target.querySelector(".tl-open")).toBeNull();
	});
});
