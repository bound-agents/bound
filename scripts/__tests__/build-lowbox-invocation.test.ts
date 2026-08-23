import { describe, expect, it } from "bun:test";
import { buildLowboxHelperCommand } from "../build";

describe("build lowbox invocation", () => {
	it("invokes Bun directly instead of routing through the ambient shell", () => {
		expect(buildLowboxHelperCommand("C:\\Bun\\bun.exe")).toEqual({
			command: "C:\\Bun\\bun.exe",
			args: ["run", "scripts/build-lowbox-helper.ts"],
		});
	});
});
