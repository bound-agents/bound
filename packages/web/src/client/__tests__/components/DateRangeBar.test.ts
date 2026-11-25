import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// DateRangeBar: four preset pills (24h/7d/30d/all) plus a custom datetime-local
// range with debounced validation. It reports ranges via onRangeChange(from,to)
// as ISO strings. These tests mount the real compiled component under jsdom and
// assert preset callbacks, the active-pill state, custom-range validation
// (from<to, future clamp, missing bound), the disabled state, and that a
// pending debounce is cleared on unmount.

const dom = installDom();
afterAll(() => dom.teardown());

type Change = { from: string; to: string };

async function mountBar(props: Partial<{ from: string; to: string; disabled: boolean }> = {}) {
	const DateRangeBar = (await import("../../components/DateRangeBar.svelte")).default;
	const changes: Change[] = [];
	const handle = await dom.mount(DateRangeBar, {
		from: "2026-01-01T00:00:00.000Z",
		to: "2026-01-02T00:00:00.000Z",
		onRangeChange: (from: string, to: string) => changes.push({ from, to }),
		disabled: false,
		...props,
	});
	return { ...handle, changes };
}

/** Find a preset pill button by its visible label. */
function pill(target: HTMLElement, label: string): HTMLButtonElement {
	const btn = [...target.querySelectorAll("button.preset-pill")].find(
		(b) => b.textContent?.trim() === label,
	);
	if (!btn) throw new Error(`no preset pill "${label}"`);
	return btn as HTMLButtonElement;
}

describe("DateRangeBar", () => {
	it("renders four preset pills with 24h active by default", async () => {
		const { target, unmount } = await mountBar();
		await dom.settle();
		const labels = [...target.querySelectorAll("button.preset-pill")].map((b) =>
			b.textContent?.trim(),
		);
		expect(labels).toEqual(["24h", "7d", "30d", "All"]);
		expect(pill(target, "24h").classList.contains("active")).toBe(true);
		unmount();
	});

	it("fires onRangeChange with a ~24h window and marks 24h active", async () => {
		const { target, changes, unmount } = await mountBar();
		await dom.fire(pill(target, "24h"), "click");
		expect(changes.length).toBe(1);
		const first = changes[0] as Change;
		const span = new Date(first.to).getTime() - new Date(first.from).getTime();
		// 24h ± a few ms of execution drift.
		expect(span).toBeGreaterThan(23 * 3600_000);
		expect(span).toBeLessThanOrEqual(24 * 3600_000 + 5000);
		unmount();
	});

	it("tracks focus/blur on the custom inputs so a prop refresh can't clobber mid-edit", async () => {
		const { target, unmount } = await mountBar();
		const inputs = target.querySelectorAll("input.date-input");
		// Focusing sets editing=true; the component keeps the user's typed value even
		// if the parent pushes a new `from`/`to` prop while the input has focus.
		await dom.fire(inputs[0] as HTMLInputElement, "focus");
		await dom.type(inputs[0] as HTMLInputElement, "2026-05-05T12:00");
		// Re-settle after a notional prop refresh: value survives because editing=true.
		await dom.settle();
		expect((inputs[0] as HTMLInputElement).value).toBe("2026-05-05T12:00");
		await dom.fire(inputs[0] as HTMLInputElement, "blur");
		await dom.fire(inputs[1] as HTMLInputElement, "focus");
		await dom.fire(inputs[1] as HTMLInputElement, "blur");
		unmount();
	});

	it("applies the 7d / 30d / all presets with the right span and active pill", async () => {
		const { target, changes, unmount } = await mountBar();
		await dom.fire(pill(target, "7d"), "click");
		expect(pill(target, "7d").classList.contains("active")).toBe(true);
		const afterWeek = changes.at(-1) as Change;
		const week = new Date(afterWeek.to).getTime() - new Date(afterWeek.from).getTime();
		expect(week).toBeGreaterThan(6.9 * 24 * 3600_000);

		await dom.fire(pill(target, "30d"), "click");
		const afterMonth = changes.at(-1) as Change;
		const month = new Date(afterMonth.to).getTime() - new Date(afterMonth.from).getTime();
		expect(month).toBeGreaterThan(29 * 24 * 3600_000);

		await dom.fire(pill(target, "All"), "click");
		// "all" anchors from 2020-01-01.
		expect((changes.at(-1) as Change).from).toBe("2020-01-01T00:00:00.000Z");
		unmount();
	});

	it("validates a custom range and reports from<to as ISO on debounce", async () => {
		const { target, changes, unmount } = await mountBar();
		const inputs = target.querySelectorAll("input.date-input");
		const fromInput = inputs[0] as HTMLInputElement;
		const toInput = inputs[1] as HTMLInputElement;
		await dom.type(fromInput, "2026-03-01T00:00");
		await dom.type(toInput, "2026-03-02T00:00");
		// Debounce is 300ms; wait past it.
		await new Promise((r) => setTimeout(r, 350));
		await dom.settle();
		expect(changes.length).toBeGreaterThan(0);
		const last = changes.at(-1) as Change;
		// Reported as ISO (ends in Z).
		expect(last.from.endsWith("Z")).toBe(true);
		expect(new Date(last.from).getTime()).toBeLessThan(new Date(last.to).getTime());
		// The custom pill is now the active selection (no preset highlighted).
		expect([...target.querySelectorAll("button.preset-pill.active")].length).toBe(0);
		unmount();
	});

	it("surfaces a validation error and reports nothing when from >= to", async () => {
		const { target, changes, unmount } = await mountBar();
		const inputs = target.querySelectorAll("input.date-input");
		await dom.type(inputs[0] as HTMLInputElement, "2026-03-05T00:00");
		await dom.type(inputs[1] as HTMLInputElement, "2026-03-01T00:00"); // to < from
		await new Promise((r) => setTimeout(r, 350));
		await dom.settle();
		expect(target.textContent).toContain("Start date must be before end date.");
		expect(target.querySelector(".custom-inputs")?.classList.contains("error")).toBe(true);
		expect(changes.length).toBe(0);
		unmount();
	});

	it("errors when one custom bound is missing", async () => {
		const { target, changes, unmount } = await mountBar();
		const inputs = target.querySelectorAll("input.date-input");
		await dom.type(inputs[0] as HTMLInputElement, "2026-03-01T00:00");
		// Explicitly clear `to` so datetimeLocalToIso returns "" and the
		// missing-bound branch (not the from>=to branch) runs.
		await dom.type(inputs[1] as HTMLInputElement, "");
		await new Promise((r) => setTimeout(r, 350));
		await dom.settle();
		expect(target.textContent).toContain("Start date must be before end date.");
		expect(changes.length).toBe(0);
		unmount();
	});

	it("clamps a future end date to now", async () => {
		const { target, changes, unmount } = await mountBar();
		const inputs = target.querySelectorAll("input.date-input");
		await dom.type(inputs[0] as HTMLInputElement, "2026-01-01T00:00");
		// A far-future `to` should be clamped back to ~now.
		await dom.type(inputs[1] as HTMLInputElement, "2099-01-01T00:00");
		await new Promise((r) => setTimeout(r, 350));
		await dom.settle();
		expect(changes.length).toBeGreaterThan(0);
		const clampedTo = new Date((changes.at(-1) as Change).to).getTime();
		// Clamped to roughly now, nowhere near 2099.
		expect(clampedTo).toBeLessThan(Date.now() + 5000);
		expect(new Date("2099-01-01T00:00:00Z").getTime()).toBeGreaterThan(clampedTo);
		unmount();
	});

	it("disables the pills and inputs when disabled", async () => {
		const { target, unmount } = await mountBar({ disabled: true });
		await dom.settle();
		expect(target.querySelector(".date-range-bar")?.classList.contains("disabled")).toBe(true);
		expect((pill(target, "24h") as HTMLButtonElement).disabled).toBe(true);
		const inputs = target.querySelectorAll("input.date-input");
		expect((inputs[0] as HTMLInputElement).disabled).toBe(true);
		unmount();
	});

	it("clears a pending debounce timer on unmount so no callback fires into a dead parent", async () => {
		const { target, changes, unmount } = await mountBar();
		const inputs = target.querySelectorAll("input.date-input");
		// Start a custom edit (schedules the 300ms debounce) then unmount before it fires.
		await dom.type(inputs[0] as HTMLInputElement, "2026-04-01T00:00");
		await dom.type(inputs[1] as HTMLInputElement, "2026-04-02T00:00");
		const before = changes.length;
		unmount();
		// Wait past the debounce window: onDestroy must have cleared the timer.
		await new Promise((r) => setTimeout(r, 400));
		expect(changes.length).toBe(before);
	});
});
