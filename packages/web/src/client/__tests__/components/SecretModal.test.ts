import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

async function mount(props: Record<string, unknown>) {
	dom = installDom();
	const SecretModal = (await import("../../components/SecretModal.svelte")).default;
	const mounted = await dom.mount(SecretModal, props);
	await dom.settle();
	return mounted;
}

describe("SecretModal", () => {
	it("renders the webhook name, the secret value, and the save-now warning", async () => {
		const { target } = await mount({
			secret: "whsec_abc123",
			webhookName: "github-push",
			onClose: () => {},
		});
		expect(target.querySelector(".modal-title")?.textContent).toContain("github-push");
		expect(target.querySelector(".secret-value")?.textContent).toBe("whsec_abc123");
		expect(target.querySelector(".warning")?.textContent).toContain("will not be shown again");
	});

	it("copies the secret to the clipboard and flips the button label", async () => {
		const { target } = await mount({
			secret: "whsec_copyme",
			webhookName: "wh",
			onClose: () => {},
		});
		const copyBtn = target.querySelector(".copy-btn") as HTMLButtonElement;
		expect(copyBtn.textContent?.trim()).toBe("Copy");
		await dom?.fire(copyBtn, "click");
		const clipboard = dom?.window.navigator.clipboard as unknown as { writes: string[] };
		expect(clipboard.writes).toContain("whsec_copyme");
		expect(copyBtn.textContent?.trim()).toBe("Copied!");
	});

	it("calls onClose when the × header button is clicked", async () => {
		let closed = 0;
		const { target } = await mount({
			secret: "s",
			webhookName: "wh",
			onClose: () => {
				closed++;
			},
		});
		const closeBtn = target.querySelector(".close-btn") as HTMLButtonElement;
		await dom?.fire(closeBtn, "click");
		expect(closed).toBe(1);
	});

	it("ignores backdrop clicks so the one-time secret is not lost", async () => {
		let closed = 0;
		const { target } = await mount({
			secret: "s",
			webhookName: "wh",
			onClose: () => {
				closed++;
			},
		});
		const backdrop = target.querySelector(".modal-backdrop") as HTMLElement;
		await dom?.fire(backdrop, "click");
		expect(closed).toBe(0);
		expect(target.querySelector(".close-btn")?.getAttribute("aria-label")).toBe("Close");
	});

	it("closes on Escape keydown and restores focus to the previously focused element", async () => {
		let closed = 0;
		const { target } = await mount({
			secret: "s",
			webhookName: "wh",
			onClose: () => {
				closed++;
			},
		});
		const modalBackdrop = target.querySelector(".modal-backdrop") as HTMLElement;
		await dom?.fire(modalBackdrop, "keydown", { key: "Escape" });
		expect(closed).toBe(1);
	});

	it("ignores non-Escape keydowns", async () => {
		let closed = 0;
		const { target } = await mount({
			secret: "s",
			webhookName: "wh",
			onClose: () => {
				closed++;
			},
		});
		const modalBackdrop = target.querySelector(".modal-backdrop") as HTMLElement;
		await dom?.fire(modalBackdrop, "keydown", { key: "a" });
		expect(closed).toBe(0);
	});

	it("focuses the copy button on mount", async () => {
		const { target } = await mount({
			secret: "s",
			webhookName: "wh",
			onClose: () => {},
		});
		const copy = target.querySelector(".copy-btn") as HTMLElement;
		expect(dom?.document.activeElement).toBe(copy);
	});
});
