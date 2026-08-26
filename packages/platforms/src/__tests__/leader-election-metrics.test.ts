import { describe, expect, it } from "bun:test";
import { platformMetricName } from "../leader-election";

describe("platform leadership metric cardinality", () => {
	it("preserves known platform names and clamps arbitrary connector names", () => {
		expect(platformMetricName("discord")).toBe("discord");
		expect(platformMetricName("rss")).toBe("rss");
		expect(platformMetricName("customer-provided-server-name-123")).toBe("other");
	});
});
