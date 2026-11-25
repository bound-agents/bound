import { type Page, expect, test } from "@playwright/test";
import { assertInViewport, assertNoLayoutShift, assertNotClipped } from "./helpers/geometry";
import {
	type RoutingFixture,
	clusterDefaults,
	json,
	mockAmbient,
	routingFixture,
	statusModels,
} from "./helpers/mocks";

const THREAD_ID = "thread-e2e-model-selector";

async function mountThread(
	page: Page,
	opts: { modelHint?: string | null; messageModel?: string | null } = {},
): Promise<RoutingFixture[]> {
	const routing = routingFixture();
	await mockAmbient(page);
	// Host default is deliberately unrelated to the thread's own model.
	await page.route("**/api/status/models", (r) => json(r, statusModels(routing, "kimi-k3")));
	await page.route("**/api/routing/models", (r) => json(r, { models: routing }));
	await page.route("**/api/routing/cluster-defaults", (r) =>
		json(r, { ...clusterDefaults(), roles: {} }),
	);
	await page.route(`**/api/threads/${THREAD_ID}`, (r) =>
		json(r, {
			id: THREAD_ID,
			user_id: "test-user",
			interface: "web",
			host_origin: "local",
			color: 3,
			title: "Model selector geometry",
			summary: null,
			model_hint: opts.modelHint ?? null,
			created_at: "2026-11-24T00:00:00.000Z",
			last_message_at: "2026-11-24T00:01:00.000Z",
			modified_at: "2026-11-24T00:01:00.000Z",
			deleted: 0,
		}),
	);
	const messages = opts.messageModel
		? [
				{
					id: "m1",
					thread_id: THREAD_ID,
					role: "user",
					content: "hello",
					model_id: null,
					tool_name: null,
					created_at: "2026-11-24T00:00:00.000Z",
					modified_at: null,
					host_origin: "local",
					deleted: 0,
				},
				{
					id: "m2",
					thread_id: THREAD_ID,
					role: "assistant",
					content: "hi",
					model_id: opts.messageModel,
					tool_name: null,
					created_at: "2026-11-24T00:00:30.000Z",
					modified_at: null,
					host_origin: "local",
					deleted: 0,
				},
			]
		: [];
	await page.route(`**/api/threads/${THREAD_ID}/messages**`, (r) => json(r, messages));
	await page.route(`**/api/threads/${THREAD_ID}/status`, (r) =>
		json(r, { active: false, state: null, detail: null, tokens: 0, model: null }),
	);
	await page.route(`**/api/threads/${THREAD_ID}/provenance`, (r) => json(r, { turns: [] }));
	await page.goto(`/#/line/${THREAD_ID}`);
	await expect(page.locator("#model")).toHaveAttribute("data-value", /.+/);
	return routing;
}

const trigger = (page: Page) => page.locator("#model");
const popover = (page: Page) => page.locator(".model-selector .popover");

test.describe("model selector", () => {
	test("lists logical models alphabetically", async ({ page }) => {
		await mountThread(page, { modelHint: "gpt-6-luna" });
		await trigger(page).click();
		const labels = await page.locator(".option-label").allTextContents();
		expect(labels.length).toBeGreaterThanOrEqual(15);
		const sorted = [...labels].sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
		);
		expect(labels).toEqual(sorted);
	});

	test("opening and keyboard navigation never shift the input bar", async ({ page }) => {
		await mountThread(page, { modelHint: "gpt-6-luna" });
		const wrap = page.locator(".input-wrap");
		await assertNoLayoutShift(wrap, async () => {
			await trigger(page).click();
			await expect(popover(page)).toBeVisible();
		});
		await assertInViewport(popover(page));
		await assertNotClipped(popover(page));
		for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "End", "Home", "g"]) {
			await assertNoLayoutShift(wrap, () => trigger(page).press(key));
		}
		// Type-ahead lands on the first label starting with "g".
		await expect(page.locator(".option.active .option-label")).toHaveText(/^g/i);
		await page.keyboard.press("End");
		await expect(page.locator(".option.active")).toBeInViewport();
		await assertNoLayoutShift(wrap, () => trigger(page).press("Escape"));
		await expect(popover(page)).toBeHidden();
		await expect(trigger(page)).toBeFocused();
	});

	test("popover flips up and stays on screen in a short viewport", async ({ page }) => {
		const vp = page.viewportSize();
		await page.setViewportSize({ width: vp?.width ?? 1280, height: 520 });
		await mountThread(page, { modelHint: "gpt-6-luna" });
		await trigger(page).click();
		await assertInViewport(popover(page));
		await assertNotClipped(popover(page));
	});

	test("status-dot routes popover stays on screen on hover and focus", async ({ page }) => {
		await mountThread(page, { modelHint: "mai-code-2-extended-context-preview-edition" });
		const wrap = page.locator(".input-wrap");
		const dot = page.locator(".status-dot-btn");
		const tip = page.locator("#model-routes-tip");
		await assertNoLayoutShift(wrap, () => dot.hover());
		await assertInViewport(tip);
		await assertNotClipped(tip);
		await page.mouse.move(0, 0);
		await expect(tip).toBeHidden();
		await assertNoLayoutShift(wrap, () => dot.focus());
		await assertInViewport(tip);
		await assertNotClipped(tip);
		await dot.press("Escape");
		await expect(tip).toBeHidden();
	});

	test("Tab reaches route pins and pinning marks the trigger", async ({ page }) => {
		await mountThread(page, { modelHint: "gpt-6-luna" });
		await trigger(page).click();
		await page.keyboard.press("Tab");
		const auto = page.locator(".pin-choice", { hasText: "Auto" });
		await expect(auto).toBeFocused();
		await page.keyboard.press("Tab");
		const first = page.locator(".pin-choice").nth(1);
		await expect(first).toBeFocused();
		await assertNotClipped(first);
		await page.keyboard.press("Enter");
		await expect(first).toHaveAttribute("aria-pressed", "true");
		await expect(trigger(page)).toHaveClass(/pinned/);
		await expect(page.locator(".pin-badge")).toBeVisible();
	});

	test("Escape from a focused route pin closes the popover", async ({ page }) => {
		await mountThread(page, { modelHint: "gpt-6-luna" });
		await trigger(page).click();
		const pin = page.locator(".pin-choice").nth(1);
		await pin.focus();
		await expect(pin).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(popover(page)).toHaveCount(0);
		await expect(trigger(page)).toBeFocused();
	});

	test("top bar never overflows the desktop viewport", async ({ page, isMobile }) => {
		test.skip(!!isMobile, "desktop widths only");
		await mountThread(page, { modelHint: "gpt-6-luna" });
		for (const [width, height] of [
			[1280, 800],
			[1024, 768],
		] as const) {
			await page.setViewportSize({ width, height });
			const { scroll, inner } = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				inner: window.innerWidth,
			}));
			expect(scroll, `scrollWidth at ${width}px`).toBeLessThanOrEqual(inner);
		}
	});

	test("switching models updates the header chip immediately", async ({ page }) => {
		await mountThread(page, { modelHint: "gpt-6-luna" });
		const chip = page.locator(".chip").first();
		await expect(chip).toContainText("GPT-6 Luna");
		await trigger(page).click();
		await page.locator(".option", { hasText: "Kimi K3" }).click();
		await expect(trigger(page)).toHaveAttribute("data-value", "kimi-k3");
		await expect(chip).toContainText("Kimi K3");
	});

	test("thread without model_hint prefills from its latest message's backend id", async ({
		page,
	}) => {
		// `gpt-6-sol-remote` is the remote route's backend id for logical gpt-6-sol.
		await mountThread(page, { modelHint: null, messageModel: "gpt-6-sol-remote" });
		await expect(trigger(page)).toHaveAttribute("data-value", "gpt-6-sol");
		await expect(trigger(page)).not.toHaveAttribute("data-value", "kimi-k3");
		await expect(page.locator(".trigger-label")).toHaveText("GPT-6 Sol");
	});
});
