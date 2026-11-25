import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config. Run via `bun run test:e2e` (which passes `-c`).
 * The web bundle must be built first (`bun run --cwd packages/web build`);
 * the test server serves the embedded assets from that build.
 */
// A dedicated port: a developer's running bound daemon owns 3000.
const PORT = Number(process.env.E2E_PORT ?? 3123);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: "./",
	testMatch: "*.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	outputDir: "./test-results",
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
		},
		{
			name: "mobile",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 390, height: 844 },
				hasTouch: true,
				isMobile: true,
			},
		},
	],
	webServer: {
		// Playwright runs webServer from the config's directory (e2e/).
		command: "bun ../packages/web/scripts/start-test-server.ts",
		env: { E2E_PORT: String(PORT) },
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 120 * 1000,
	},
});
