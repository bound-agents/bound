import { type Page, expect, test } from "@playwright/test";
import { json } from "./helpers/mocks";

// The thread header's status chip, "Thinking…" label, and Cancel button are
// driven by GET /api/threads/:id/status, which reflects work running on any
// host (a delegated turn shows as active here). Mock that endpoint so the
// tests are deterministic.

interface Status {
	active: boolean;
	state: string | null;
	model: string;
}

async function createThread(page: Page): Promise<string> {
	const res = await page.request.post("/api/threads", { data: {} });
	expect(res.ok()).toBeTruthy();
	const body = (await res.json()) as { id: string };
	return body.id;
}

async function mockStatus(page: Page, threadId: string, status: () => Status): Promise<void> {
	await page.route(`**/api/threads/${threadId}/status`, (route) =>
		json(route, { ...status(), detail: null, tokens: 0 }),
	);
}

test.describe("Delegation status and cancel", () => {
	test("7a: header shows the agent working while a remote turn runs (AC6.3)", async ({ page }) => {
		const threadId = await createThread(page);
		let current: Status = { active: true, state: "thinking", model: "remote-model" };
		await mockStatus(page, threadId, () => current);

		await page.goto(`/#/line/${threadId}`);
		await expect(page.getByText("On duty").first()).toBeVisible();
		await expect(page.getByText("Thinking…")).toBeVisible();

		// The remote turn finishes; the next status poll returns the thread to idle.
		current = { active: false, state: "idle", model: "remote-model" };
		await expect(page.getByText("Idle", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("Thinking…")).toHaveCount(0);
	});

	test("7b: cancel button posts a cancel for the thread (AC6.4)", async ({ page }) => {
		const threadId = await createThread(page);
		await mockStatus(page, threadId, () => ({
			active: true,
			state: "thinking",
			model: "remote-model",
		}));

		let cancelledId: string | null = null;
		await page.route("**/api/status/cancel/**", (route) => {
			cancelledId = route.request().url().split("/").pop() ?? null;
			return json(route, { cancelled: true });
		});

		await page.goto(`/#/line/${threadId}`);
		const cancel = page.getByRole("button", { name: "Cancel" });
		await expect(cancel).toBeVisible();
		await cancel.click();
		await expect.poll(() => cancelledId).toBe(threadId);
	});

	test("7c: idle local thread shows no working state or error (AC6.5)", async ({ page }) => {
		const threadId = await createThread(page);
		await mockStatus(page, threadId, () => ({ active: false, state: "idle", model: "local" }));

		await page.goto(`/#/line/${threadId}`);
		await expect(page.getByText("Idle", { exact: true }).first()).toBeVisible();
		await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
		await expect(page.getByText("Thinking…")).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
	});
});
