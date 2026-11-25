import { type Page, expect, test } from "@playwright/test";
import { assertNoHorizontalOverflow } from "./helpers/geometry";
import { clusterDefaults, json, mockAmbient, routingFixture } from "./helpers/mocks";

interface Calls {
	drain: Array<{ method: string; url: string }>;
	defaults: unknown[];
	routingLoads: number;
}

async function mountSettings(page: Page): Promise<Calls> {
	const routing = routingFixture();
	const calls: Calls = { drain: [], defaults: [], routingLoads: 0 };
	let roles: Record<string, string> = clusterDefaults().roles;
	await mockAmbient(page);
	await page.route("**/api/routing/models", (r) => {
		calls.routingLoads++;
		return json(r, { models: routing });
	});
	await page.route("**/api/routing/cluster-defaults", (r) => {
		if (r.request().method() === "PUT") {
			const body = r.request().postDataJSON() as { roles: Record<string, string> };
			calls.defaults.push(body);
			roles = body.roles;
			return json(r, { ok: true });
		}
		return json(r, { ...clusterDefaults(), roles });
	});
	await page.route("**/api/routing/routes/*/drain", (r) => {
		const req = r.request();
		calls.drain.push({ method: req.method(), url: decodeURIComponent(req.url()) });
		const id = decodeURIComponent(
			req
				.url()
				.split("/routes/")[1]
				.replace(/\/drain$/, ""),
		);
		for (const m of routing)
			for (const rt of m.routes) if (rt.route_id === id) rt.drained = req.method() === "POST";
		return json(r, { ok: true });
	});
	await page.goto("/#/settings/models");
	await expect(page.locator(".model-item").first()).toBeVisible();
	return calls;
}

const compare = (a: string, b: string) =>
	a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

test.describe("settings › models", () => {
	test("lists models alphabetically across providers, snapshots disambiguated", async ({
		page,
	}) => {
		await mountSettings(page);
		const names = await page.locator(".model-item .name").allTextContents();
		expect(names.length).toBeGreaterThanOrEqual(15);
		expect(names).toEqual([...names].sort(compare));
		expect(names).toContain("GPT-4o");
		expect(names).toContain("GPT-4o (2024-08-06)");
	});

	test("no horizontal overflow with long route names", async ({ page }) => {
		await mountSettings(page);
		await page.locator(".model-item", { hasText: "Mai Code 2" }).click();
		await expect(page.locator(".route-row").first()).toBeVisible();
		await assertNoHorizontalOverflow(page);
	});

	test("route labels carry a title so truncated text stays readable", async ({ page }) => {
		await mountSettings(page);
		await page.locator(".model-item", { hasText: "Mai Code 2" }).click();
		const labels = page.locator(".route-row .r-route.mono");
		await expect(labels.first()).toBeAttached();
		const n = await labels.count();
		expect(n).toBeGreaterThan(0);
		for (let i = 0; i < n; i++) {
			const el = labels.nth(i);
			const text = (await el.textContent())?.trim() ?? "";
			await expect(el).toHaveAttribute("title", text);
		}
	});

	test("Enabled toggle calls the drain API", async ({ page }) => {
		const calls = await mountSettings(page);
		await page.locator(".model-item", { hasText: "Kimi K3" }).click();
		const toggle = page.getByRole("switch").first();
		await expect(toggle).toBeChecked();
		await toggle.click();
		await expect.poll(() => calls.drain.length).toBe(1);
		expect(calls.drain[0].method).toBe("POST");
		expect(calls.drain[0].url).toContain("kimi-k3");
		await expect(toggle).not.toBeChecked();
		await toggle.click();
		await expect.poll(() => calls.drain.length).toBe(2);
		expect(calls.drain[1].method).toBe("DELETE");
	});

	test("roles editor validates and saves", async ({ page }) => {
		const calls = await mountSettings(page);
		const roles = page.locator("section.roles");
		await roles.getByRole("button", { name: "Add alias" }).click();
		const name = roles.getByLabel("Alias name").last();
		await name.fill("bad@name");
		await roles.locator(".role-row select").last().selectOption("kimi-k3");
		await roles.getByRole("button", { name: "Save" }).click();
		await expect(roles.getByRole("alert")).toContainText("without '@'");
		expect(calls.defaults).toHaveLength(0);
		await name.fill("reviewer");
		await roles.getByRole("button", { name: "Save" }).click();
		await expect(roles.locator(".ok")).toHaveText("Saved");
		expect(calls.defaults).toHaveLength(1);
		expect((calls.defaults[0] as { roles: Record<string, string> }).roles.reviewer).toBe("kimi-k3");
	});

	test("route refresh preserves unsaved role edits", async ({ page }) => {
		const calls = await mountSettings(page);
		const roles = page.locator("section.roles");
		await roles.getByRole("button", { name: "Add alias" }).click();
		await roles.getByLabel("Alias name").last().fill("draft-alias");
		await roles.locator("select").last().selectOption("glm-5-3");
		const before = calls.routingLoads;
		// A drain toggle reloads routing + defaults underneath the open editor.
		await page.getByRole("switch").first().click();
		await expect.poll(() => calls.routingLoads).toBeGreaterThan(before);
		await expect(roles.getByLabel("Alias name").last()).toHaveValue("draft-alias");
		await expect(roles.locator("select").last()).toHaveValue("glm-5-3");
	});
});
