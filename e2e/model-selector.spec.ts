import { expect, test } from "@playwright/test";

// Skip E2E tests if SKIP_E2E env var is set
const skipE2E = process.env.SKIP_E2E === "1";

test.describe.configure({ mode: skipE2E ? "skip" : "default" });

test.describe("Model Selector with Relay Annotations", () => {
	test("should display local and remote models with relay annotations", async ({ page }) => {
		// Mock /api/status/models to return a test dataset with local, remote, and offline models
		await page.route("**/api/status/models", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					models: [
						{
							id: "claude-3-5-sonnet",
							provider: "anthropic",
							host: "local-host",
							via: "local",
							status: "local",
						},
						{
							id: "remote-claude-3",
							provider: "remote",
							host: "test-remote-host",
							via: "relay",
							status: "online",
						},
						{
							id: "offline-model",
							provider: "remote",
							host: "test-offline-host",
							via: "relay",
							status: "offline?",
						},
					],
					default: "claude-3-5-sonnet",
				}),
			});
		});

		// Navigate to the chat page
		await page.goto("/");

		// Wait for the page to load and stabilize
		await page.waitForLoadState("networkidle");

		// Find the model selector element
		// It's typically a <select> with id="model" or similar
		const modelSelector = page
			.locator("select[id='model'], [role='combobox'][data-test='model-selector']")
			.first();

		// Verify the selector exists
		await expect(modelSelector).toBeDefined();
		const selectorCount = await modelSelector.count();
		expect(selectorCount).toBeGreaterThanOrEqual(1);

		// Get all option elements in the model selector
		const options = modelSelector.locator("option");
		const optionCount = await options.count();

		// Verify we have at least 3 models (local + remote + offline)
		expect(optionCount).toBeGreaterThanOrEqual(3);

		// Verify the local model is present
		const localOption = options.filter({ hasText: "claude-3-5-sonnet" }).first();
		await expect(localOption).toBeDefined();
		const localCount = await localOption.count();
		expect(localCount).toBeGreaterThanOrEqual(1);

		// Verify the remote model with relay annotation is present
		const remoteOption = options
			.filter({ hasText: /remote-claude-3.*test-remote-host.*via relay/ })
			.first();
		await expect(remoteOption).toBeDefined();
		const remoteCount = await remoteOption.count();
		expect(remoteCount).toBeGreaterThanOrEqual(1);

		// Verify the offline model with offline annotation is present
		const offlineOption = options
			.filter({ hasText: /offline-model.*test-offline-host.*offline\?/ })
			.first();
		await expect(offlineOption).toBeDefined();
		const offlineCount = await offlineOption.count();
		expect(offlineCount).toBeGreaterThanOrEqual(1);
	});

	test("should render relay annotations in option text", async ({ page }) => {
		// Mock /api/status/models with relay and offline models
		await page.route("**/api/status/models", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					models: [
						{
							id: "local-model",
							provider: "openai",
							host: "local-host",
							via: "local",
							status: "local",
						},
						{
							id: "gpt-4-remote",
							provider: "remote",
							host: "remote-host-1",
							via: "relay",
							status: "online",
						},
					],
					default: "local-model",
				}),
			});
		});

		// Navigate to the chat page
		await page.goto("/");

		// Wait for the page to load
		await page.waitForLoadState("networkidle");

		// Find the model selector
		const modelSelector = page
			.locator("select[id='model'], [role='combobox'][data-test='model-selector']")
			.first();

		// Get all option elements
		const options = modelSelector.locator("option");

		// Collect option texts to verify annotations are rendered
		const optionTexts: string[] = [];
		const count = await options.count();
		for (let i = 0; i < count; i++) {
			const text = await options.nth(i).textContent();
			if (text) {
				optionTexts.push(text);
			}
		}

		// Verify at least one option contains relay annotation
		const hasRelayAnnotation = optionTexts.some((text) => text.includes("via relay"));
		expect(hasRelayAnnotation).toBeTruthy();

		// Verify at least one option contains the remote host name
		const hasRemoteHostAnnotation = optionTexts.some((text) => text.includes("remote-host-1"));
		expect(hasRemoteHostAnnotation).toBeTruthy();
	});

	test("should distinguish same model on different hosts", async ({ page }) => {
		// Mock /api/status/models with same model on multiple hosts
		await page.route("**/api/status/models", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					models: [
						{
							id: "shared-model",
							provider: "local",
							host: "local-host",
							via: "local",
							status: "local",
						},
						{
							id: "shared-model",
							provider: "remote",
							host: "remote-host-a",
							via: "relay",
							status: "online",
						},
						{
							id: "shared-model",
							provider: "remote",
							host: "remote-host-b",
							via: "relay",
							status: "online",
						},
					],
					default: "shared-model",
				}),
			});
		});

		// Navigate to the chat page
		await page.goto("/");

		// Wait for the page to load
		await page.waitForLoadState("networkidle");

		// Find the model selector
		const modelSelector = page
			.locator("select[id='model'], [role='combobox'][data-test='model-selector']")
			.first();

		// Get all option elements containing "shared-model"
		const options = modelSelector.locator("option");
		const sharedModelOptions = options.filter({ hasText: "shared-model" });

		// Verify there are at least 3 entries for shared-model (local + 2 remote hosts)
		const sharedCount = await sharedModelOptions.count();
		expect(sharedCount).toBeGreaterThanOrEqual(3);

		// Collect texts to verify different host annotations
		const sharedTexts: string[] = [];
		for (let i = 0; i < sharedCount; i++) {
			const text = await sharedModelOptions.nth(i).textContent();
			if (text) {
				sharedTexts.push(text);
			}
		}

		// Verify we have entries for different hosts
		const hasLocalHost = sharedTexts.some((text) => text.includes("local-host"));
		const hasRemoteHostA = sharedTexts.some((text) => text.includes("remote-host-a"));
		const hasRemoteHostB = sharedTexts.some((text) => text.includes("remote-host-b"));

		expect(hasLocalHost).toBeTruthy();
		expect(hasRemoteHostA).toBeTruthy();
		expect(hasRemoteHostB).toBeTruthy();
	});
});
