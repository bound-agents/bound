import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// ThreadLinkCard: the shared inline-reference-card shell. It renders a left
// icon snippet, a body snippet, and a right action column that shows an
// "Open line" button once threadId is set (clicking it navigates the hash
// router) or a pending note while threadId is null. These tests assert all
// three states and the navigation side effect.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

const icon = () => createRawSnippet(() => ({ render: () => "<i>icon</i>" }));
const body = () => createRawSnippet(() => ({ render: () => "<span>body</span>" }));

async function mountCard(props: Record<string, unknown>) {
	const ThreadLinkCard = (await import("../../components/ThreadLinkCard.svelte")).default;
	const handle = await dom.mount(ThreadLinkCard, { icon: icon(), children: body(), ...props });
	unmounts.push(handle.unmount);
	return handle;
}

describe("ThreadLinkCard", () => {
	it("renders the icon, body, and the line-color border var", async () => {
		const { target } = await mountCard({ lineColor: "#abcdef" });
		const card = target.querySelector(".tl-card") as HTMLElement;
		expect(card.querySelector(".tl-icon")?.textContent).toContain("icon");
		expect(card.textContent).toContain("body");
		expect(card.getAttribute("style")).toContain("--line-color: #abcdef");
	});

	it("shows the pending note and no open button while threadId is null", async () => {
		const { target } = await mountCard({ threadId: null, pendingLabel: "Not yet" });
		expect(target.querySelector(".tl-open")).toBeNull();
		expect(target.querySelector(".tl-pending-note")?.textContent).toBe("Not yet");
	});

	it("shows neither action nor note when threadId is null and no pendingLabel", async () => {
		const { target } = await mountCard({ threadId: null });
		expect(target.querySelector(".tl-open")).toBeNull();
		expect(target.querySelector(".tl-pending-note")).toBeNull();
	});

	it("shows the open button with a custom label once threadId is set", async () => {
		const { target } = await mountCard({ threadId: "abc", openLabel: "Jump in" });
		const open = target.querySelector(".tl-open");
		expect(open).not.toBeNull();
		expect(open?.textContent).toContain("Jump in");
		expect(target.querySelector(".tl-pending-note")).toBeNull();
	});

	it("navigates to the line route when the open button is clicked", async () => {
		const { target } = await mountCard({ threadId: "thread-123" });
		const open = target.querySelector(".tl-open") as HTMLButtonElement;
		await dom.fire(open, "click");
		expect(dom.window.location.hash).toBe("#/line/thread-123");
	});
});
