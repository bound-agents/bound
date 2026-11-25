import type { Page, Route } from "@playwright/test";

export const json = (route: Route, body: unknown, status = 200) =>
	route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const PROVIDERS = ["bedrock", "openai-compatible", "copilot", "anthropic"];
const NAMES = [
	"Claude Opus 5.5",
	"Claude Sonnet 5.5",
	"Claude Haiku 5.5",
	"GPT-4o",
	"GPT-4o (2024-08-06)",
	"GPT-6 Luna",
	"GPT-6 Sol",
	"Gemini 4 Argon",
	"Gemini 4 Neon",
	"GLM 5.3",
	"GLM 5.3 Flash",
	"Kimi K3",
	"MiniMax M3",
	"Qwen 4 Max",
	"DeepSeek V4 Pro",
	"Mai Code 2 Extended Context Preview Edition",
];

export interface RouteFixture {
	route_id: string;
	site_id: string;
	host_name: string;
	provider: string;
	display_name: string;
	provider_model_id: string;
	drained: boolean;
	health: "healthy" | "backoff" | "half_open" | "unknown";
	next_trial_at: null;
}

export interface RoutingFixture {
	logical_model: string;
	display_name: string;
	route_order: null;
	fallback_policy: { mode: "auto" };
	routes: RouteFixture[];
	stale_routes: [];
}

export function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** 16 logical models across providers, each with two long-named routes. */
export function routingFixture(): RoutingFixture[] {
	// Deliberately NOT alphabetical so the UI's sort is what the tests observe.
	return [...NAMES].reverse().map((display, i) => {
		const logical = slug(display);
		const provider = PROVIDERS[i % PROVIDERS.length];
		const routes: RouteFixture[] = [
			{
				route_id: `site-alpha:${provider}:${logical}-backend-with-a-very-long-provider-model-identifier-v1:0`,
				site_id: "site-alpha",
				host_name: "workstation-with-a-long-hostname.local",
				provider,
				display_name: display,
				provider_model_id: `${logical}-backend-with-a-very-long-provider-model-identifier-v1:0`,
				drained: false,
				health: "healthy",
				next_trial_at: null,
			},
			{
				route_id: `site-beta:${provider}:${logical}-remote`,
				site_id: "site-beta",
				host_name: "cloud-hub-us-east-1",
				provider,
				display_name: display,
				provider_model_id: `${logical}-remote`,
				drained: i % 5 === 0,
				health: i % 3 === 0 ? "backoff" : "healthy",
				next_trial_at: null,
			},
		];
		return {
			logical_model: logical,
			display_name: display,
			route_order: null,
			fallback_policy: { mode: "auto" },
			routes,
			stale_routes: [],
		};
	});
}

export function statusModels(routing: RoutingFixture[], defaultId: string) {
	return {
		models: routing.map((m) => ({
			id: m.logical_model,
			logical_model: m.logical_model,
			display_name: m.display_name,
			provider: m.routes[0].provider,
			host: "local",
			via: "local",
			status: "local",
		})),
		default: defaultId,
	};
}

export const clusterDefaults = () => ({
	default_fallback_models: [],
	roles: { default: "claude-opus-5-5", heavy: "gpt-6-sol", fast: "glm-5-3-flash" },
	aliases: [],
});

/** Stubs out the ambient endpoints every view polls so tests stay deterministic. */
export async function mockAmbient(page: Page): Promise<void> {
	await page.route("**/api/advisories/count**", (r) => json(r, { count: 0 }));
	await page.route("**/api/advisories", (r) => json(r, []));
	await page.route("**/api/threads", (r) =>
		r.request().method() === "GET" ? json(r, []) : r.fallback(),
	);
}
