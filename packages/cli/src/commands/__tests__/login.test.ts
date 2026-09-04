import { describe, expect, it } from "bun:test";
import { defaultTokenStorePath } from "../login";

describe("defaultTokenStorePath", () => {
	it("places the store beside the config dir", () => {
		expect(defaultTokenStorePath("config")).toMatch(/config[\\/]chatgpt-auth\.json$/);
	});

	it("honors a non-default config dir", () => {
		expect(defaultTokenStorePath("/etc/bound")).toMatch(/bound[\\/]chatgpt-auth\.json$/);
	});
});
