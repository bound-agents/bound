import { Glob } from "bun";
import { describe, expect, it } from "bun:test";

const DIRECT_COLOR_PROP =
	/\b(?:color|borderColor|backgroundColor)\s*=\s*\{?\s*["'][^"']+["']/;
const STYLE_COLOR_VALUE =
	/\b(?:color|borderColor|backgroundColor)\s*:\s*["'][^"']+["']/;

const PRODUCTION_GLOBS = ["components/**/*.ts", "components/**/*.tsx", "views/**/*.ts", "views/**/*.tsx"];

describe("TUI semantic theme", () => {
	it("does not allow direct literal color values in production TUI surfaces", async () => {
		const offenders: string[] = [];
		for (const pattern of PRODUCTION_GLOBS) {
			for await (const path of new Glob(pattern).scan({ cwd: import.meta.dir })) {
				const source = await Bun.file(`${import.meta.dir}/${path}`).text();
				if (DIRECT_COLOR_PROP.test(source) || STYLE_COLOR_VALUE.test(source)) offenders.push(path);
			}
		}
		expect(offenders).toEqual([]);
	});
});
