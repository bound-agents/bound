#!/usr/bin/env bun
/**
 * Smoke test for POST /api/inference — verifies mid-conversation system
 * messages work by sending a message array with a system role after the
 * first user message.
 *
 * Usage:
 *   bun run packages/agent/scripts/test-inference.ts [url] [model]
 *
 * Defaults: url=http://localhost:3001, model=sonnet
 */
const url = process.argv[2] ?? "http://localhost:3001";
const model = process.argv[3] ?? "sonnet";

console.log(`POST ${url}/api/inference  model=${model}\n`);

const response = await fetch(`${url}/api/inference`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		model,
		messages: [
			{ role: "user", content: "What is 2+2?" },
			{ role: "system", content: "Always answer in exactly one word." },
			{ role: "user", content: "What is 3+3?" },
		],
		max_tokens: 100,
	}),
});

if (!response.ok) {
	console.error(`HTTP ${response.status}: ${await response.text()}`);
	process.exit(1);
}

const reader = response.body?.getReader();
if (!reader) {
	console.error("No response body");
	process.exit(1);
}

const decoder = new TextDecoder();
let text = "";
let usage = null;
let hadError = false;

while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	const chunk = decoder.decode(value, { stream: true });
	for (const line of chunk.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj.type === "text") {
				text += obj.content;
				process.stdout.write(obj.content);
			} else if (obj.type === "done") {
				usage = obj.usage;
			} else if (obj.type === "error") {
				hadError = true;
				console.error(`\n[error] ${obj.error}`);
			} else if (obj.type === "thinking") {
				// skip — not relevant for this test
			}
		} catch {
			// partial line, will be completed on next read
		}
	}
}

console.log("\n");
console.log("=== result ===");
console.log(`text:      ${text.slice(0, 200)}`);
console.log(`usage:     ${JSON.stringify(usage)}`);
console.log(`had_error: ${hadError}`);
console.log(`\nMid-conversation system message: ${hadError ? "FAILED" : "OK"}`);
process.exit(hadError ? 1 : 0);
