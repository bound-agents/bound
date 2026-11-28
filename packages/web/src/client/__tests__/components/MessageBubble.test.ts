import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// MessageBubble: renders one chat message by role. User/assistant content may
// be a JSON ContentBlock[] (text / image / thinking) or plain text; markdown
// text is rendered to HTML asynchronously. tool_result / alert / system roles
// have dedicated layouts. These tests drive the real compiled component (and
// its ReasoningBlock child) under jsdom and assert the rendered output.

const dom = installDom();
afterAll(() => dom.teardown());

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

// The async markdown pipeline (Shiki/marked/DOMPurify) is unreliable to settle
// under jsdom + a loaded concurrent run, so these tests assert on the message
// TEXT (present whether the raw-text fallback or the rendered .md-content shows)
// rather than on specific rendered HTML elements.

async function mountBubble(props: Record<string, unknown>) {
	const MessageBubble = (await import("../../components/MessageBubble.svelte")).default;
	const handle = await dom.mount(MessageBubble, props);
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

describe("MessageBubble", () => {
	it("labels a user message 'You' and renders its markdown", async () => {
		const { target } = await mountBubble({ role: "user", content: "hello **world**" });
		expect(target.querySelector(".role")?.textContent?.trim()).toBe("You");
		// The text is present whether or not the async markdown render has landed.
		expect(target.textContent).toContain("hello");
		expect(target.textContent).toContain("world");
	});

	it("labels an assistant message 'Agent' and shows the model id", async () => {
		const { target } = await mountBubble({
			role: "assistant",
			content: "a reply",
			modelId: "opus-4.8",
		});
		expect(target.querySelector(".role")?.textContent?.trim()).toBe("Agent");
		expect(target.querySelector(".model")?.textContent).toContain("opus-4.8");
	});

	it("omits the model chip when no modelId is given", async () => {
		const { target } = await mountBubble({ role: "assistant", content: "x" });
		expect(target.querySelector(".model")).toBeNull();
	});

	it("renders a successful tool_result as a Result block", async () => {
		const { target } = await mountBubble({
			role: "tool_result",
			content: "command output here",
			exitCode: 0,
		});
		expect(target.querySelector(".role-result")?.textContent?.trim()).toBe("Result");
		expect(target.querySelector(".tool-output")?.textContent).toContain("command output here");
		expect(target.querySelector(".tool-error")).toBeNull();
	});

	it("renders a failed tool_result as an Error block with error styling", async () => {
		const { target } = await mountBubble({
			role: "tool_result",
			content: "boom",
			exitCode: 1,
		});
		expect(target.querySelector(".role")?.textContent?.trim()).toBe("Error");
		expect(target.querySelector(".tool-error")).not.toBeNull();
		expect(target.querySelector(".tool-output-error")).not.toBeNull();
	});

	it("renders an alert role with the System/Error header", async () => {
		const { target } = await mountBubble({ role: "alert", content: "disk full" });
		expect(target.querySelector(".alert")).not.toBeNull();
		expect(target.querySelector(".alert-body")?.textContent).toContain("disk full");
	});

	it("renders a system role as plain italic text with no role header", async () => {
		const { target } = await mountBubble({ role: "system", content: "context note" });
		expect(target.querySelector(".system-text")?.textContent).toContain("context note");
		expect(target.querySelector(".role-row")).toBeNull();
	});

	it("parses a JSON ContentBlock array with a text block", async () => {
		const content = JSON.stringify([{ type: "text", text: "block text" }]);
		const { target } = await mountBubble({ role: "assistant", content });
		expect(target.textContent).toContain("block text");
	});

	it("renders a thinking block through the ReasoningBlock child", async () => {
		const content = JSON.stringify([
			{ type: "thinking", thinking: "deliberation here" },
			{ type: "text", text: "final answer" },
		]);
		const { target } = await mountBubble({ role: "assistant", content });
		// ReasoningBlock renders a disclosure toggle with a word count.
		const toggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		expect(toggle).not.toBeNull();
		expect(target.querySelector(".reasoning-label")?.textContent?.trim()).toBe("Reasoning");
		// Expanding it reveals the reasoning prose.
		await dom.fire(toggle, "click");
		expect(target.querySelector(".reasoning-body")?.textContent).toContain("deliberation here");
	});

	it("marks a redacted thinking block as redacted without leaking text", async () => {
		const content = JSON.stringify([
			{ type: "thinking", thinking: "", redacted_data: "xxx" },
			{ type: "text", text: "answer" },
		]);
		const { target } = await mountBubble({ role: "assistant", content });
		expect(target.querySelector(".reasoning-meta")?.textContent).toContain("redacted");
	});

	it("renders a base64 image block as an inline data-URI image with caption", async () => {
		const content = JSON.stringify([
			{
				type: "image",
				description: "a diagram",
				source: { type: "base64", media_type: "image/png", data: "AAAA" },
			},
		]);
		const { target } = await mountBubble({ role: "user", content });
		const img = target.querySelector(".content-image img") as HTMLImageElement;
		expect(img).not.toBeNull();
		expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
		expect(img.getAttribute("alt")).toBe("a diagram");
		expect(target.querySelector(".image-caption")?.textContent).toContain("a diagram");
	});

	it("renders a file_ref image block as a download URL and no caption for the default alt", async () => {
		const content = JSON.stringify([
			{ type: "image", source: { type: "file_ref", file_id: "f 1" } },
		]);
		const { target } = await mountBubble({ role: "assistant", content });
		const img = target.querySelector(".content-image img") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe("/api/files/download?id=f%201");
		// alt defaults to "image" → no caption shown.
		expect(target.querySelector(".image-caption")).toBeNull();
	});

	it("renders only the role header when the JSON array parses to no renderable blocks", async () => {
		const content = JSON.stringify([{ type: "unknown" }]);
		const { target } = await mountBubble({ role: "assistant", content });
		// Unknown block types filter out → zero display blocks, so no content div.
		expect(target.querySelector(".content")).toBeNull();
		expect(target.querySelector(".content-image")).toBeNull();
		expect(target.querySelector(".role")?.textContent?.trim()).toBe("Agent");
	});

	it("treats a non-array JSON payload that starts with [ as plain text", async () => {
		const content = "[not json after all";
		const { target } = await mountBubble({ role: "user", content });
		expect(target.textContent).toContain("[not json after all");
	});

	it("applies the thread line color to the message", async () => {
		const { target } = await mountBubble({
			role: "assistant",
			content: "x",
			threadColor: 3,
		});
		const message = target.querySelector(".message") as HTMLElement;
		// getLineColor(3) → Tozai blue "#1E7FA8" via the --line-color custom prop.
		expect(message.getAttribute("style")).toContain("#1E7FA8");
	});
});

describe("MessageBubble sender identity (#258)", () => {
	const label = async (props: Record<string, unknown>) => {
		const { target } = await mountBubble({ role: "user", content: "hi", ...props });
		return target.querySelector(".role")?.textContent?.trim();
	};

	it("shows the user_name stamped on the message metadata", async () => {
		expect(
			await label({ metadata: JSON.stringify({ user_name: "Kara" }), userDisplayName: "Other" }),
		).toBe("Kara");
	});

	it("falls back to the thread owner's display name", async () => {
		expect(await label({ metadata: null, userDisplayName: "Kara" })).toBe("Kara");
	});

	it("labels a main-agent message in an aux thread as the agent", async () => {
		expect(
			await label({ metadata: JSON.stringify({ sender_role: "main" }), userDisplayName: "Kara" }),
		).toBe("agent");
	});
	it("#340: renders a truncated block-array assistant message as a placeholder", async () => {
		const content = `[{"type":"thinking","thinking":"","reasoning_encrypted_content":"${"f9/3/+f57/".repeat(200)}`;
		const { target } = await mountBubble({ role: "assistant", content });
		expect(target.textContent).toContain("[unreadable message content]");
		expect(target.textContent).not.toContain("reasoning_encrypted_content");
	});
});
