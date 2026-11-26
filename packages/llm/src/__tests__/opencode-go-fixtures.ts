/**
 * Test fixtures for the OpenCode Go catalog/driver tests: `/models` rows shaped
 * like the live `https://opencode.ai/zen/go/v1/models` listing.
 */

/** A chat row with every metadata block the parser reads. */
export const DEEPSEEK_ROW = {
	id: "deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash 1017",
	type: "chat",
	modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
	capabilities: {
		tools: { supported: true },
		reasoning: { supported: true, effort: ["low", "high", "max"] },
	},
	limit: { context: 1_000_000, output: 384_000 },
	cost: {
		text: {
			input: {
				price: 0.15,
				cache: { read: 0.003, write: 0.125 },
				overrides: [
					{
						when: { context: { gt: 100_000 } },
						price: 0.5,
						cache: { read: 0.05, write: 0.625 },
					},
				],
			},
			output: {
				price: 0.6,
				overrides: [{ when: { context: { gt: 100_000 } }, price: 2.5 }],
			},
		},
	},
	api: {
		"chat-completions": { base_url: "https://opencode.ai/inference/go/openai/v1" },
		responses: { base_url: "https://opencode.ai/inference/go/openai/v1" },
		messages: { base_url: "https://opencode.ai/inference/go/anthropic/v1" },
	},
	recommended_api: "chat-completions",
};

/** A full listing: one routable chat row, one Responses row, and three excluded rows. */
export const OPENCODE_GO_LISTING = {
	data: [
		DEEPSEEK_ROW,
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			type: "chat",
			limit: { context: 1_050_000, output: 128_000 },
			api: { responses: { base_url: "https://opencode.ai/inference/go/openai/v1" } },
			recommended_api: "responses",
		},
		{ id: "router", type: "decision", recommended_api: "systemone", api: { systemone: {} } },
		{ id: "embed-1", type: "embedding", recommended_api: "embeddings", api: { embeddings: {} } },
		{
			id: "gemini-4-argon",
			type: "chat",
			recommended_api: "interactions",
			api: { interactions: {}, "generate-content": {} },
		},
	],
};
