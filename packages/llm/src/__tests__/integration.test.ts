import { beforeAll, describe, expect, it } from "bun:test";
import { OllamaDriver } from "../ollama-driver";
import type { StreamChunk } from "../types";

// Skip Ollama tests if explicitly requested or if server is unreachable
const SKIP_OLLAMA = process.env.SKIP_OLLAMA === "1";

async function isOllamaAvailable(): Promise<boolean> {
	if (SKIP_OLLAMA) {
		return false;
	}

	try {
		const response = await fetch("http://localhost:11434/api/tags");
		return response.ok;
	} catch {
		return false;
	}
}

describe("LLM integration tests (Optional Ollama)", () => {
	let ollamaAvailable = false;

	beforeAll(async () => {
		ollamaAvailable = await isOllamaAvailable();
		if (!ollamaAvailable) {
			console.log("Skipping Ollama integration tests: server not available or SKIP_OLLAMA=1");
		}
	});

	it.skipIf(!ollamaAvailable)("should connect to Ollama and send simple message", async () => {

		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		const chunks: StreamChunk[] = [];

		for await (const chunk of driver.chat({
			model: "llama2",
			messages: [{ role: "user", content: "Say hello briefly" }],
		})) {
			chunks.push(chunk);
		}

		// Verify we got some response
		expect(chunks.length).toBeGreaterThan(0);

		// Verify we got at least one text chunk
		const hasText = chunks.some((c) => c.type === "text");
		expect(hasText).toBe(true);

		// Verify we got a done chunk
		const hasDone = chunks.some((c) => c.type === "done");
		expect(hasDone).toBe(true);
	});

	it.skipIf(!ollamaAvailable)("should handle tool_use requests with Ollama", async () => {

		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		const chunks: StreamChunk[] = [];

		for await (const chunk of driver.chat({
			model: "llama2",
			messages: [
				{
					role: "user",
					content: "Add numbers 5 and 3",
				},
			],
			tools: [
				{
					type: "function",
					function: {
						name: "add",
						description: "Add two numbers",
						parameters: {
							type: "object",
							properties: {
								a: { type: "number" },
								b: { type: "number" },
							},
							required: ["a", "b"],
						},
					},
				},
			],
		})) {
			chunks.push(chunk);
		}

		// Verify we got some response
		expect(chunks.length).toBeGreaterThan(0);

		// Verify we got a done chunk
		const hasDone = chunks.some((c) => c.type === "done");
		expect(hasDone).toBe(true);
	});

	it.skipIf(!ollamaAvailable)("should stream responses from Ollama correctly", async () => {

		const driver = new OllamaDriver({
			baseUrl: "http://localhost:11434",
			model: "llama2",
			contextWindow: 4096,
		});

		let textChunkCount = 0;
		let totalChunks = 0;

		for await (const chunk of driver.chat({
			model: "llama2",
			messages: [{ role: "user", content: "Count to three" }],
		})) {
			totalChunks++;
			if (chunk.type === "text") {
				textChunkCount++;
			}
		}

		// Verify we got multiple chunks streamed
		expect(totalChunks).toBeGreaterThan(1);

		// Verify we got text chunks
		expect(textChunkCount).toBeGreaterThan(0);
	});
});
