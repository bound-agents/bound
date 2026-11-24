import { describe, expect, it } from "bun:test";
import { buildModelLabels, parseRouteId } from "../model-labels";

const routing = [
	{
		logical_model: "claude-opus-5-5",
		display_name: "Claude Opus 5.5",
		routes: [
			{
				route_id: "site-hub:bedrock-main:bedrock-main-anthropic.claude-opus-5-5",
				provider: "bedrock-main",
				provider_model_id: "anthropic.claude-opus-5-5",
			},
		],
	},
	{
		logical_model: "claude-haiku-4-5",
		display_name: "Claude Haiku 4.5",
		routes: [
			{
				route_id: "site-hub:bedrock-main:bedrock-main-anthropic.claude-haiku-4-5-20251001-v1:0",
				provider: "bedrock-main",
				provider_model_id: "anthropic.claude-haiku-4-5-20251001-v1:0",
			},
		],
	},
	{
		logical_model: "glm-5.3-flash",
		display_name: "GLM 5.3 Flash",
		routes: [
			{
				route_id: "site-msi:zai:zai-glm-5.3-flash",
				provider: "zai",
				provider_model_id: "glm-5.3-flash",
			},
		],
	},
];

describe("parseRouteId", () => {
	it("keeps colons inside the backend id", () => {
		expect(parseRouteId("s:bedrock-main:x-v1:0")).toEqual({
			siteId: "s",
			provider: "bedrock-main",
			backendId: "x-v1:0",
		});
	});
	it("returns null for a bare backend id", () => {
		expect(parseRouteId("zai-glm-5.3-flash")).toBeNull();
	});
});

describe("buildModelLabels", () => {
	const labels = buildModelLabels(routing);

	it("labels a RouteId as provider:provider-model-id", () => {
		expect(labels.routeLabel("site-msi:zai:zai-glm-5.3-flash")).toBe("zai:glm-5.3-flash");
	});

	it("labels a bare backend id the same way", () => {
		expect(labels.routeLabel("zai-glm-5.3-flash")).toBe("zai:glm-5.3-flash");
	});

	it("handles Bedrock ids that contain ':'", () => {
		const id = "site-hub:bedrock-main:bedrock-main-anthropic.claude-haiku-4-5-20251001-v1:0";
		expect(labels.routeLabel(id)).toBe("bedrock-main:anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(labels.routeLabel("bedrock-main-anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
			"bedrock-main:anthropic.claude-haiku-4-5-20251001-v1:0",
		);
	});

	it("strips the provider prefix for an unknown RouteId", () => {
		expect(labels.routeLabel("s:copilot:copilot-gpt-6-luna")).toBe("copilot:gpt-6-luna");
	});

	it("never leaks a site id for an unknown RouteId without a prefix", () => {
		expect(labels.routeLabel("s:codex:sol")).toBe("codex:sol");
	});

	it("maps logical and backend ids to display names", () => {
		expect(labels.modelLabel("glm-5.3-flash")).toBe("GLM 5.3 Flash");
		expect(labels.modelLabel("zai-glm-5.3-flash")).toBe("GLM 5.3 Flash");
		expect(labels.modelLabel("site-hub:bedrock-main:bedrock-main-anthropic.claude-opus-5-5")).toBe(
			"Claude Opus 5.5",
		);
		expect(labels.modelLabel("unknown-x")).toBe("unknown-x");
		expect(labels.modelLabel(null)).toBe("\u2014");
	});

	it("falls back to the raw id for an unknown bare backend id", () => {
		expect(labels.routeLabel("mystery")).toBe("mystery");
	});
});
