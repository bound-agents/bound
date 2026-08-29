import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

const DIRECT_COLOR_PROP = /\b(?:color|borderColor|backgroundColor)\s*=\s*\{?\s*["'][^"']+["']/;
const STYLE_COLOR_VALUE = /\b(?:color|borderColor|backgroundColor)\s*:\s*["'][^"']+["']/;

describe("TUI semantic theme", () => {
	it("does not allow direct literal color values outside theme.ts", async () => {
		const offenders: string[] = [];
		for (const pattern of ["**/*.ts", "**/*.tsx"]) {
			for await (const path of new Glob(pattern).scan({ cwd: import.meta.dir })) {
				if (path === "theme.ts") continue;
				const source = await Bun.file(`${import.meta.dir}/${path}`).text();
				if (DIRECT_COLOR_PROP.test(source) || STYLE_COLOR_VALUE.test(source)) offenders.push(path);
			}
		}
		expect(offenders).toEqual([]);
	});
});
