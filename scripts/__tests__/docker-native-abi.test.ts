import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const releaseWorkflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const smokeScript = readFileSync(join(root, "scripts/docker-native-abi-smoke.sh"), "utf8");
const packageJson = readFileSync(join(root, "package.json"), "utf8");
const nativeStaging = readFileSync(join(root, "scripts/tree-sitter-native-staging.ts"), "utf8");
const nativeProbe = readFileSync(join(root, "scripts/tree-sitter-native-probe.ts"), "utf8");
const ciWorkflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

describe("release Docker native ABI contract", () => {
	test("runs Bun embedded native addons on an Ubuntu 24.04 runtime with its matching C++ ABI", () => {
		expect(dockerfile).toMatch(/^FROM ubuntu:24\.04$/m);
		expect(dockerfile).toMatch(
			/apt-get install -y --no-install-recommends ca-certificates libstdc\+\+6/,
		);
		expect(dockerfile).not.toContain("debian:bookworm");
		expect(dockerfile).toContain(
			"COPY binaries/${TARGETARCH}/tree-sitter-native-probe /usr/local/bin/tree-sitter-native-probe",
		);
	});

	test("builds each native architecture on Ubuntu 24.04 and directly probes every structure-reader grammar", () => {
		expect(releaseWorkflow).toContain("runner: ubuntu-24.04");
		expect(releaseWorkflow).toContain("runner: ubuntu-24.04-arm");
		expect(releaseWorkflow).toContain("fail-fast: false");
		expect(releaseWorkflow).toContain("build-essential python3 make g++ curl ca-certificates");
		expect(releaseWorkflow).not.toMatch(/apt-get install[^\n]*\bnode-gyp\b/);
		expect(packageJson).toMatch(/"node-gyp": "11\.4\.0"/);
		expect(packageJson).toMatch(/"abbrev": "3\.0\.1"/);
		expect(nativeStaging).toContain('"node_modules", "node-gyp", "bin", "node-gyp.js"');
		expect(nativeStaging).not.toContain('Bun.spawn(["node-gyp"');
		expect(nativeStaging).toContain('"--node_shared=false"');
		expect(releaseWorkflow).toContain("NODE_VERSION=22.15.0");
		expect(releaseWorkflow).toContain(
			"NODE_HEADERS_SHA256=cda8bbbfb4f7fb19b65efd5faabc97ccea1e94422e7066b9a1e70280c1ca6453",
		);
		expect(releaseWorkflow).toContain("sha256sum --check --status");
		expect(releaseWorkflow).toContain("NODE_GYP_NODEDIR");
		expect(releaseWorkflow).toMatch(
			/bun install --frozen-lockfile[\s\S]*bun run scripts\/tree-sitter-native-staging\.ts[\s\S]*bun run build/,
		);
		expect(releaseWorkflow).toContain("- name: Smoke-test native ABI in runtime image");
		expect(releaseWorkflow).toContain("bash scripts/docker-native-abi-smoke.sh");
		expect(releaseWorkflow).toContain(
			"IMAGE: ghcr.io/${{ github.repository }}:${{ github.ref_name }}-${{ matrix.arch }}",
		);
		expect(smokeScript).toContain(
			'{"default_web_user":"smoke","users":{"smoke":{"display_name":"Smoke"}}}',
		);
		expect(smokeScript).toContain('{"backends":[],"default":""}');
		expect(smokeScript).not.toContain('docker run -d --rm --name "$container"');
		expect(smokeScript).toContain('docker run -d --name "$container"');
		expect(smokeScript).toContain(
			"printf 'Docker ABI smoke failed; preserving container for inspection: %s\\n' \"$container\" >&2",
		);
		expect(smokeScript).toContain("docker inspect --format");
		expect(smokeScript).toContain("uname -m");
		expect(smokeScript).toContain("/etc/os-release");
		expect(smokeScript).toContain('stat -c "%A %a %U:%G %n" /tmp');
		expect(smokeScript).toContain("findmnt -no TARGET,OPTIONS /tmp");
		expect(smokeScript).toContain("ldconfig -p | grep -E");
		expect(smokeScript).toContain("strings /usr/lib/*/libstdc++.so.6");
		expect(smokeScript).toContain("sort -V | tail -n 1");
		expect(smokeScript).toContain('docker logs "$container" >&2 || printf');
		expect(smokeScript).toMatch(
			/if \(\(status != 0\)\); then[\s\S]*return "\$status"[\s\S]*docker rm -f "\$container"/,
		);
		expect(smokeScript).not.toMatch(/docker rm -f "\$container"[^\n]*\|\| true/);
		expect(smokeScript).toContain("-e BIND_HOST=localhost -e WEB_BIND_HOST=localhost");
		expect(smokeScript).not.toMatch(/(?:BIND_HOST|WEB_BIND_HOST)=0\.0\.0\.0/);
		expect(smokeScript).toContain("for _ in {1..5}; do");
		expect(releaseWorkflow).toContain(
			"cp dist/tree-sitter-native-probe binaries/${{ matrix.arch }}/",
		);
		expect(smokeScript).toContain("/usr/local/bin/tree-sitter-native-probe");
		expect(smokeScript).not.toContain("BUN_BE_BUN=1");
		expect(smokeScript).toContain('mkdir -p "$probe_dir/node_modules"');
		expect(smokeScript).toMatch(
			/mkdir -p "\$probe_dir\/node_modules"[\s\S]*-v "\$probe_dir:\/probe:ro"[\s\S]*-v "\$probe_dir\/node_modules:\/app\/node_modules:ro"/,
		);
		expect(smokeScript).not.toContain("packages/shared/node_modules");
		expect(smokeScript).not.toMatch(/-v "\$PWD[^"]*node_modules/);
		expect(nativeProbe).toContain(
			'import Parser from "../packages/shared/node_modules/tree-sitter"',
		);
		expect(nativeProbe).toContain(
			'import Cpp from "../packages/shared/node_modules/tree-sitter-cpp"',
		);
		expect(nativeProbe).toContain(
			'import Kotlin from "../packages/shared/node_modules/tree-sitter-kotlin"',
		);
		expect(nativeProbe).toContain(
			'import Swift from "../packages/shared/node_modules/tree-sitter-swift"',
		);
		expect(nativeProbe).toContain("parser.setLanguage(language)");
		expect(nativeProbe).toContain("loaded ${grammars.length} structure-reader grammar addons");
	});

	test("fails a package when tee fails even if Bun succeeds, while retaining Bun exit sidecars", () => {
		const match = ciWorkflow.match(/run_test_with_log\(\) \{[\s\S]*?^\s*\}/m);
		if (!match) throw new Error("run_test_with_log was not found in CI workflow");

		const dir = mkdtempSync(join(tmpdir(), "bound-ci-pipeline-"));
		const bin = join(dir, "bin");
		const results = join(dir, "results");
		mkdirSync(bin);
		mkdirSync(results);
		const writeCommand = (name: string, body: string) => {
			const path = join(bin, name);
			writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
			chmodSync(path, 0o755);
		};

		try {
			writeCommand("bun", 'printf "bun output\\n"; exit "${BUN_EXIT}"');
			writeCommand("tee", 'cat >/dev/null; exit "${TEE_EXIT}"');
			const run = (bunExit: number, teeExit: number) =>
				Bun.spawnSync({
					cmd: [
						"bash",
						"-c",
						`set -euo pipefail; log="${results}/core.log"; ${match[0]}; run_test_with_log "${results}/core.exit" bun test`,
					],
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						BUN_EXIT: String(bunExit),
						TEE_EXIT: String(teeExit),
					},
				});

			expect(run(0, 9).exitCode).toBe(9);
			expect(readFileSync(join(results, "core.exit"), "utf8").trim()).toBe("0");
			expect(run(7, 0).exitCode).toBe(7);
			expect(readFileSync(join(results, "core.exit"), "utf8").trim()).toBe("7");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("prepares pinned native headers only on Linux and captures every package's complete test log", () => {
		expect(ciWorkflow).toContain("os: [ubuntu-latest, macos-latest, windows-2022]");
		expect(ciWorkflow).toContain("34018618564");
		expect(ciWorkflow).toContain("node-gyp could not recognize VS2026");
		expect(ciWorkflow).toContain("this is not ABI validation");
		expect(ciWorkflow).toMatch(
			/if: \$\{\{ runner\.os == 'Linux' \}\}[\s\S]*NODE_VERSION=22\.15\.0[\s\S]*NODE_HEADERS_SHA256=cda8bbbfb4f7fb19b65efd5faabc97ccea1e94422e7066b9a1e70280c1ca6453[\s\S]*NODE_GYP_NODEDIR/,
		);
		expect(ciWorkflow).toMatch(
			/bun install --frozen-lockfile[\s\S]*if: \$\{\{ runner\.os == 'Linux' \}\}[\s\S]*bun run scripts\/tree-sitter-native-staging\.ts/,
		);
		expect(ciWorkflow).toMatch(
			/run_test_with_log\(\) \{[\s\S]*"\$@" 2>&1 \| tee "\$log"[\s\S]*local -a pipeline_status=\("\$\{PIPESTATUS\[@\]\}"\)[\s\S]*printf '%s\\n' "\$\{pipeline_status\[0\]\}" > "\$exit_sidecar"[\s\S]*return "\$\{pipeline_status\[1\]\}"/,
		);
	});
});
