import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "../../..");
const assetsDir = join(webRoot, "dist/client/assets");

function emittedJavaScript(dir: string): string[] {
	return readdirSync(dir, { recursive: true })
		.filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".js"))
		.map((entry) => join(dir, entry));
}

test("production browser bundle excludes Node native-addon loaders", async () => {
	const generatedBuildInfo = join(webRoot, "../shared/src/build-info-generated.ts");
	if (!existsSync(generatedBuildInfo)) {
		const generate = Bun.spawn(["bun", "run", "scripts/generate-build-info.ts"], {
			cwd: join(webRoot, "../.."),
			stdout: "ignore",
			stderr: "inherit",
		});
		expect(await generate.exited).toBe(0);
	}

	const build = Bun.spawn(["bun", "run", "build"], {
		cwd: webRoot,
		stdout: "ignore",
		stderr: "inherit",
	});
	expect(await build.exited).toBe(0);

	const assets = emittedJavaScript(assetsDir).map((path) => ({
		path,
		source: readFileSync(path, "utf8"),
	}));
	for (const forbiddenSource of ["process.config", "tree-sitter.node"]) {
		const offenders = assets
			.filter(({ source }) => source.includes(forbiddenSource))
			.map(({ path }) => path);
		expect(offenders).toEqual([]);
	}
}, 60_000);
