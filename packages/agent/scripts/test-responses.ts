#!/usr/bin/env bun
/**
 * Smoke test for POST /v1/responses — the OpenAI Responses-API-compatible
 * inference endpoint. Sends a small conversation with an `instructions`
 * (system) field and streams the SSE events back, reconstructing the text
 * from `response.output_text.delta` events and reading usage off
 * `response.completed`.
 *
 * Usage:
 *   bun run packages/agent/scripts/test-responses.ts [url] [model]
 *
 * Defaults: url=http://localhost:3001, model=sonnet
 */
const url = process.argv[2] ?? "http://localhost:3001";
const model = process.argv[3] ?? "sonnet";

console.log(`POST ${url}/v1/responses  model=${model}\n`);

const response = await fetch(`${url}/v1/responses`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		// Accepted and ignored — present so this mirrors a real OpenAI SDK client.
		Authorization: "Bearer sk-ignored",
	},
	body: JSON.stringify({
		model,
		instructions: "Always answer in exactly one word.",
		input: [
			{ role: "user", content: "What is 2+2?" },
			{ role: "user", content: "What is 3+3?" },
		],
		max_output_tokens: 100,
		stream: true,
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
let usage: unknown = null;
let hadError = false;
let buffer = "";

// Parse SSE frames: blank-line-delimited records, each with an optional
// `event:` line and a `data:` line carrying JSON.
function handleFrame(frame: string): void {
	let dataLine = "";
	for (const line of frame.split("\n")) {
		if (line.startsWith("data:")) dataLine += line.slice(5).trim();
	}
	if (!dataLine) return;
	let obj: {
		type?: string;
		delta?: string;
		response?: { usage?: unknown; error?: { message?: string } };
	};
	try {
		obj = JSON.parse(dataLine);
	} catch {
		return;
	}
	switch (obj.type) {
		case "response.output_text.delta":
			if (typeof obj.delta === "string") {
				text += obj.delta;
				process.stdout.write(obj.delta);
			}
			break;
		case "response.completed":
			usage = obj.response?.usage ?? null;
			break;
		case "response.failed":
			hadError = true;
			console.error(`\n[error] ${obj.response?.error?.message ?? "unknown"}`);
			break;
		default:
			break;
	}
}

while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	buffer += decoder.decode(value, { stream: true });
	let sep = buffer.indexOf("\n\n");
	while (sep !== -1) {
		handleFrame(buffer.slice(0, sep));
		buffer = buffer.slice(sep + 2);
		sep = buffer.indexOf("\n\n");
	}
}
if (buffer.trim()) handleFrame(buffer);

console.log("\n");
console.log("=== result ===");
console.log(`text:      ${text.slice(0, 200)}`);
console.log(`usage:     ${JSON.stringify(usage)}`);
console.log(`had_error: ${hadError}`);
console.log(`\nResponses SSE round-trip: ${hadError ? "FAILED" : "OK"}`);
process.exit(hadError ? 1 : 0);
