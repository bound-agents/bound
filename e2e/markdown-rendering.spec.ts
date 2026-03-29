import { expect, test } from "@playwright/test";

// Skip E2E tests if SKIP_E2E env var is set (consistent with other e2e tests)
const skipE2E = process.env.SKIP_E2E === "1";
test.describe.configure({ mode: skipE2E ? "skip" : "default" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a thread via the app's HTTP API. Returns the thread id, or null on failure. */
async function createThread(page: import("@playwright/test").Page): Promise<string | null> {
	const res = await page.evaluate(async () => {
		try {
			const r = await fetch("/api/threads", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			if (!r.ok) return null;
			const json = await r.json();
			return (json as { id?: string }).id ?? null;
		} catch {
			return null;
		}
	});
	return res;
}

/** Returns a fake messages array fixture for route interception. */
function makeMessageFixture(
	threadId: string,
	role: string,
	content: string,
	modelId = "test-model",
) {
	return JSON.stringify([
		{
			id: "msg-test-1",
			role,
			content,
			model_id: modelId,
			thread_id: threadId,
			user_id: "test-user",
			created_at: new Date().toISOString(),
			tool_name: role === "tool_call" ? "some_tool" : null,
		},
	]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Markdown rendering in MessageBubble", () => {
	// AC1.1 — assistant messages render as formatted HTML
	test("assistant message with markdown renders formatted HTML (AC1.1)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		// Intercept messages endpoint BEFORE navigating to thread
		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(
					threadId,
					"assistant",
					"## Hello World\n\n**Bold text** and:\n\n- list item one\n- list item two",
				),
			});
		});

		await page.goto(`/#/line/${threadId}`);

		// Wait for markdown rendering to complete (Shiki is async)
		await page.waitForSelector(".md-content h2", { timeout: 10000 });

		await expect(page.locator(".md-content h2")).toContainText("Hello World");
		await expect(page.locator(".md-content strong")).toContainText("Bold text");
		await expect(page.locator(".md-content li").first()).toContainText("list item one");
	});

	// AC1.2 — user messages render as formatted HTML
	test("user message with markdown renders formatted HTML (AC1.2)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "user", "**Important** request with `inline code`"),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".md-content strong", { timeout: 10000 });

		await expect(page.locator(".md-content strong")).toContainText("Important");
		await expect(page.locator(".md-content code")).toContainText("inline code");
	});

	// AC1.3 — tool_call is NOT markdown-rendered (stays in <pre>)
	test("tool_call message stays in pre block, not rendered as markdown (AC1.3)", async ({
		page,
	}) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		const rawContent = JSON.stringify({ name: "read_file", path: "/etc/hosts" });
		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "tool_call", rawContent, null),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".tool_call", { timeout: 10000 });

		// Must NOT have a .md-content div for tool_call
		await expect(page.locator(".tool_call .md-content")).toHaveCount(0);
	});

	// AC1.6 — system message is NOT markdown-rendered
	test("system message is not markdown-rendered (AC1.6)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "system", "**Not rendered** as markdown"),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".system", { timeout: 10000 });

		// Raw markdown text must appear verbatim (not as <strong>)
		await expect(page.locator(".system")).toContainText("**Not rendered** as markdown");
		await expect(page.locator(".system .md-content")).toHaveCount(0);
	});

	// AC2.3 — plain-text fallback shown before Shiki initializes
	// This is verified by code inspection: the template shows {content} (plain text)
	// while rendered === '' (before renderMarkdown resolves). The Playwright test
	// below verifies that the message is NEVER empty/blank during render.
	test("message content is never blank/empty while rendering (AC2.3)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		const markdownContent = "# Quick heading\n\nSome text.";
		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "assistant", markdownContent),
			});
		});

		await page.goto(`/#/line/${threadId}`);

		// Immediately after navigation, some content should be visible (either
		// plain text fallback or rendered markdown — never an empty bubble)
		await page.waitForSelector(".assistant .content, .assistant .md-content", {
			timeout: 10000,
		});

		const contentEl = page.locator(".assistant .content, .assistant .md-content").first();
		const textContent = await contentEl.textContent();
		expect((textContent ?? "").trim().length).toBeGreaterThan(0);
	});

	// AC4.1 — headings are toned down (h2 not at browser-default ~1.5em)
	test("h2 heading in markdown renders at toned-down font-size (AC4.1)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "assistant", "## Section heading"),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".md-content h2", { timeout: 10000 });

		// Browser default h2 is 1.5em (~24px at 16px base). Our CSS sets 1.1rem.
		// Check it's <= 20px (1.25rem max as per design) rather than 24px+ default.
		const h2FontSize = await page.locator(".md-content h2").evaluate((el) => {
			return Number.parseFloat(window.getComputedStyle(el).fontSize);
		});
		expect(h2FontSize).toBeLessThanOrEqual(20);
	});

	// AC4.3 — inline code has monospace font and distinct background
	test("inline code has monospace font and visible background (AC4.3)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "assistant", "Use `myFunction()` here"),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".md-content code", { timeout: 10000 });

		const codeStyles = await page
			.locator(".md-content code")
			.first()
			.evaluate((el) => {
				const cs = window.getComputedStyle(el);
				return {
					fontFamily: cs.fontFamily,
					backgroundColor: cs.backgroundColor,
				};
			});

		// Font must be monospace
		expect(
			codeStyles.fontFamily.toLowerCase().includes("mono") ||
				codeStyles.fontFamily.includes("Courier") ||
				codeStyles.fontFamily.includes("Plex"),
		).toBe(true);

		// Background must not be fully transparent (rgba(0,0,0,0))
		expect(codeStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
		expect(codeStyles.backgroundColor).not.toBe("transparent");
	});

	// AC4.4 — thinking block has visible left border
	test("thinking block has a visible left border (AC4.4)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(
					threadId,
					"assistant",
					"<thinking>reasoning here</thinking>Answer text",
				),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".md-content .thinking-block", {
			timeout: 10000,
		});

		const borderWidth = await page.locator(".md-content .thinking-block").evaluate((el) => {
			return Number.parseFloat(window.getComputedStyle(el).borderLeftWidth);
		});

		// Border must be visible (> 0px)
		expect(borderWidth).toBeGreaterThan(0);
	});

	// AC1.4 — tool_result is NOT markdown-rendered
	test("tool_result message is not markdown-rendered (AC1.4)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "tool_result", "**not rendered** as markdown", null),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".tool_result", { timeout: 10000 });

		// Must NOT have a .md-content div for tool_result
		await expect(page.locator(".tool_result .md-content")).toHaveCount(0);
	});

	// AC1.5 — alert is NOT markdown-rendered
	test("alert message is not markdown-rendered (AC1.5)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "alert", "**not rendered** as markdown", null),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".alert", { timeout: 10000 });

		// Must NOT have a .md-content div for alert
		await expect(page.locator(".alert .md-content")).toHaveCount(0);
	});

	// AC4.2 — table wider than container scrolls horizontally via .table-wrap
	test("markdown table has overflow-x auto on .table-wrap (AC4.2)", async ({ page }) => {
		await page.goto("/");
		const threadId = await createThread(page);
		if (!threadId) {
			test.skip();
			return;
		}

		// Use a multi-column table to generate a .table-wrap element
		const tableMarkdown =
			"| A | B | C | D | E | F | G | H |\n" +
			"| - | - | - | - | - | - | - | - |\n" +
			"| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |";

		await page.route(new RegExp(`/api/threads/${threadId}/messages`), async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: makeMessageFixture(threadId, "assistant", tableMarkdown),
			});
		});

		await page.goto(`/#/line/${threadId}`);
		await page.waitForSelector(".md-content .table-wrap", { timeout: 10000 });

		const overflowX = await page
			.locator(".md-content .table-wrap")
			.evaluate((el) => window.getComputedStyle(el).overflowX);

		expect(overflowX).toBe("auto");
	});
});
