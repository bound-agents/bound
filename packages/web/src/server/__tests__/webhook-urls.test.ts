import { describe, expect, it } from "bun:test";
import { type ClusterHostRow, buildWebhookUrls, webhookUrlFromBase } from "../webhook-urls";

describe("webhookUrlFromBase", () => {
	it("returns null for empty input", () => {
		expect(webhookUrlFromBase("", "github")).toBeNull();
	});

	it("returns null for unparseable input", () => {
		expect(webhookUrlFromBase("not a url", "github")).toBeNull();
	});

	it("appends /webhook/:name to an http base", () => {
		expect(webhookUrlFromBase("http://localhost:3000", "github")).toBe(
			"http://localhost:3000/webhook/github",
		);
	});

	it("appends /webhook/:name to an https base", () => {
		expect(webhookUrlFromBase("https://polaris.karashiiro.moe", "github")).toBe(
			"https://polaris.karashiiro.moe/webhook/github",
		);
	});

	it("strips an existing path so /sync/ws does not bleed into the webhook URL", () => {
		expect(webhookUrlFromBase("wss://polaris.karashiiro.moe/sync/ws", "github")).toBe(
			"https://polaris.karashiiro.moe/webhook/github",
		);
	});

	it("maps ws:// to http://", () => {
		expect(webhookUrlFromBase("ws://localhost:3000/sync/ws", "github")).toBe(
			"http://localhost:3000/webhook/github",
		);
	});

	it("maps wss:// to https://", () => {
		expect(webhookUrlFromBase("wss://hub.example.com:8443/sync/ws", "stripe")).toBe(
			"https://hub.example.com:8443/webhook/stripe",
		);
	});

	it("strips query and hash from the base URL", () => {
		expect(webhookUrlFromBase("https://hub.example.com/?token=x#frag", "slack")).toBe(
			"https://hub.example.com/webhook/slack",
		);
	});
});

describe("buildWebhookUrls", () => {
	it("emits a single localhost URL when bound to localhost on a typical port", () => {
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "localhost",
			syncPort: 3000,
		});
		expect(urls).toEqual([
			{
				url: "http://localhost:3000/webhook/github",
				source: "local",
				host_name: undefined,
				site_id: undefined,
			},
		]);
	});

	it("expands 0.0.0.0 to localhost", () => {
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "0.0.0.0",
			syncPort: 3000,
		});
		expect(urls.map((u) => u.url)).toEqual(["http://localhost:3000/webhook/github"]);
	});

	it("emits both bind-host and localhost when bound to a specific non-loopback address", () => {
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "192.168.1.10",
			syncPort: 3000,
		});
		expect(urls.map((u) => u.url)).toEqual([
			"http://192.168.1.10:3000/webhook/github",
			"http://localhost:3000/webhook/github",
		]);
	});

	it("does not emit a duplicate localhost when bound to 127.0.0.1", () => {
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "127.0.0.1",
			syncPort: 3000,
		});
		expect(urls.map((u) => u.url)).toEqual(["http://127.0.0.1:3000/webhook/github"]);
	});

	it("places the hub URL first when this node is a spoke", () => {
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "localhost",
			syncPort: 3000,
			hubUrl: "https://polaris.karashiiro.moe",
		});
		expect(urls).toEqual([
			{ url: "https://polaris.karashiiro.moe/webhook/github", source: "hub" },
			{
				url: "http://localhost:3000/webhook/github",
				source: "local",
				host_name: undefined,
				site_id: undefined,
			},
		]);
	});

	it("converts a wss:// hub URL with a /sync/ws path to a clean https:// webhook URL", () => {
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "localhost",
			syncPort: 3000,
			hubUrl: "wss://polaris.karashiiro.moe/sync/ws",
		});
		expect(urls[0]).toEqual({
			url: "https://polaris.karashiiro.moe/webhook/github",
			source: "hub",
		});
	});

	it("appends cluster URLs for peer hosts with non-empty sync_url", () => {
		const clusterHosts: ClusterHostRow[] = [
			{ site_id: "site-self", host_name: "self", sync_url: "http://self:3000" },
			{ site_id: "site-peer", host_name: "peer", sync_url: "http://peer:3000" },
			{ site_id: "site-empty", host_name: "empty", sync_url: "" },
			{ site_id: "site-null", host_name: "null", sync_url: null },
		];
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "localhost",
			syncPort: 3000,
			localSiteId: "site-self",
			clusterHosts,
		});
		// Local + cluster peer (self skipped, empty/null skipped).
		expect(urls.map((u) => u.url)).toEqual([
			"http://localhost:3000/webhook/github",
			"http://peer:3000/webhook/github",
		]);
		const peer = urls.find((u) => u.source === "cluster");
		expect(peer?.host_name).toBe("peer");
		expect(peer?.site_id).toBe("site-peer");
	});

	it("de-duplicates URLs that appear in multiple sources, keeping the first", () => {
		// A hub config that happens to match a localhost local URL.
		const urls = buildWebhookUrls({
			name: "github",
			syncBindHost: "localhost",
			syncPort: 3000,
			hubUrl: "http://localhost:3000",
		});
		// Same URL — only the first (hub) should be kept.
		expect(urls).toEqual([{ url: "http://localhost:3000/webhook/github", source: "hub" }]);
	});

	it("preserves order: hub, local, cluster", () => {
		const urls = buildWebhookUrls({
			name: "deploy",
			syncBindHost: "0.0.0.0",
			syncPort: 3000,
			hubUrl: "https://polaris.karashiiro.moe",
			clusterHosts: [{ site_id: "p1", host_name: "peer1", sync_url: "http://peer1:3000" }],
		});
		expect(urls.map((u) => u.source)).toEqual(["hub", "local", "cluster"]);
	});

	it("returns just the local URL when nothing else is configured", () => {
		const urls = buildWebhookUrls({
			name: "test",
			syncBindHost: "localhost",
			syncPort: 3000,
		});
		expect(urls).toHaveLength(1);
		expect(urls[0].source).toBe("local");
	});
});
