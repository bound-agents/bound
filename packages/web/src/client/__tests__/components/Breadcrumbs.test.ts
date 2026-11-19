import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// Breadcrumbs: a path nav where every segment but the last is a button that
// calls onNavigate(path), and the last is rendered as inert `.current` text.
// Separators appear between segments. These tests assert the structure and
// that clicking a non-last segment fires onNavigate with its path.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountCrumbs(props: Record<string, unknown>) {
	const Breadcrumbs = (await import("../../components/Breadcrumbs.svelte")).default;
	const handle = await dom.mount(Breadcrumbs, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("Breadcrumbs", () => {
	it("renders the last segment as inert current text, earlier ones as buttons", async () => {
		const { target } = await mountCrumbs({
			segments: [
				{ name: "root", path: "/" },
				{ name: "src", path: "/src" },
				{ name: "file.ts", path: "/src/file.ts" },
			],
			onNavigate: () => {},
		});
		const buttons = target.querySelectorAll("button.segment");
		expect(buttons.length).toBe(2);
		expect(buttons[0].textContent?.trim()).toBe("root");
		expect(buttons[1].textContent?.trim()).toBe("src");
		expect(target.querySelector(".current")?.textContent?.trim()).toBe("file.ts");
		// Two separators between three segments.
		expect(target.querySelectorAll(".separator").length).toBe(2);
	});

	it("fires onNavigate with the segment's path on click", async () => {
		const navigated: string[] = [];
		const { target } = await mountCrumbs({
			segments: [
				{ name: "root", path: "/" },
				{ name: "src", path: "/src" },
				{ name: "file.ts", path: "/src/file.ts" },
			],
			onNavigate: (path: string) => navigated.push(path),
		});
		const firstButton = target.querySelector("button.segment") as HTMLButtonElement;
		await dom.fire(firstButton, "click");
		expect(navigated).toEqual(["/"]);
	});

	it("renders a single segment as current with no buttons or separators", async () => {
		const { target } = await mountCrumbs({
			segments: [{ name: "only", path: "/only" }],
			onNavigate: () => {},
		});
		expect(target.querySelectorAll("button.segment").length).toBe(0);
		expect(target.querySelectorAll(".separator").length).toBe(0);
		expect(target.querySelector(".current")?.textContent?.trim()).toBe("only");
	});
});
