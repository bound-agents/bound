import type { render } from "ink-testing-library";

// Helper to wait for state updates and re-renders to process
export async function waitForRender(ms = 100): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper to write text and wait for React to process
export async function writeAndWait(
	stdin: ReturnType<typeof render>["stdin"],
	text: string,
	delayMs = 100,
): Promise<void> {
	for (const char of text) {
		stdin.write(char);
	}
	await waitForRender(delayMs);
}

// Helper to write keyboard codes (arrow keys, etc) and wait
export async function writeKeyAndWait(
	stdin: ReturnType<typeof render>["stdin"],
	keyCode: string,
	delayMs = 100,
): Promise<void> {
	stdin.write(keyCode);
	await waitForRender(delayMs);
}
