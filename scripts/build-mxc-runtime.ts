/**
 * Stages mxc's FFI library (`libmxc_ffi.dylib`/`.so`) and koffi's prebuilt
 * `koffi.node` out of node_modules and into `packages/less/src/_mxc/`, then
 * generates the `embedded.ts` importer that `bun build --compile` reads to
 * embed them into the compiled `boundless`. Mirrors `scripts/build-sandbox-runtime.ts`
 * (which does the same for `just-bash`'s worker assets).
 *
 * Runs from both `postinstall` and the compile step in `scripts/build.ts`, so
 * the generated importer always exists on disk before typecheck or compile.
 *
 * The staged files and the generated `embedded.ts` are gitignored; the
 * committed pieces are this script, the loader (`tools/mxc-runtime.ts`), and
 * the ambient declaration (`tools/mxc-embedded.d.ts`) that lets typecheck pass
 * on a fresh clone before this script has run.
 *
 * mxc ships its binaries under `bin/<arch>/<name>` (arch = arm64 | x64). The
 * runtime loader materializes them to `<root>/<arch>/<name>` and points
 * `$MXC_FFI_DIR` at the host arch's dir, where the SDK's FFI loader and the
 * patched koffi loader both look. We stage only the host platform's set for the host arch — the compiled binary runs on the
 * machine that built it, so cross-platform embedding would only bloat it.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SDK_PKG = "@microsoft/mxc-sdk";
const OUT_DIR = join(ROOT, "packages/less/src/_mxc");

/**
 * The mxc native library the v1 FFI loader resolves, keyed by host platform.
 * v1's `run()`/`spawn()` path is pure FFI (koffi → `libmxc_ffi.*`), so the old
 * per-backend exec stubs (`mxc-exec-mac`, `lxc-exec`, the Windows `wxc-*`
 * executables) are no longer part of the macOS/Linux execution path and are not
 * staged. Windows dispatches through Bound's own AppContainer lowbox before mxc
 * is ever reached, so no Windows mxc binary is needed here either.
 */
function hostBinaryNames(platform: NodeJS.Platform): string[] {
	switch (platform) {
		case "darwin":
			return ["libmxc_ffi.dylib"];
		case "linux":
			return ["libmxc_ffi.so"];
		// Windows uses Bound's lowbox helper, not mxc — nothing to stage.
		default:
			return [];
	}
}

/** mxc's `getSdkArch()` mapping: arm64 stays arm64, everything else → x64. */
function sdkArch(arch: NodeJS.Architecture): string {
	return arch === "arm64" ? "arm64" : "x64";
}

/**
 * Locate the INSTALLED SDK package dir. Bun's global `.bun/` store can retain
 * multiple versions of a package (e.g. a stale `@0.7.0` alongside the current
 * `@1.1.0`), so a lexical scan of `.bun` entries can resolve the wrong one.
 * Resolve through Bun's module resolver from the package that declares the
 * dependency (`packages/less`), which honors the lockfile and returns the
 * version actually linked for the build.
 */
function findSdkDir(): string {
	try {
		const manifest = Bun.resolveSync(`${SDK_PKG}/package.json`, join(ROOT, "packages", "less"));
		return dirname(manifest);
	} catch {
		// Fall back to a direct root hoist, then a `.bun` scan, for layouts where
		// the resolver can't see the dep (e.g. a partial install).
		const direct = join(ROOT, "node_modules", SDK_PKG);
		if (existsSync(join(direct, "package.json"))) return direct;
		const bunCache = join(ROOT, "node_modules/.bun");
		if (existsSync(bunCache)) {
			const slug = `${SDK_PKG.replace("/", "+")}@`;
			const entries = readdirSync(bunCache)
				.filter((n) => n.startsWith(slug))
				.sort()
				.reverse();
			for (const entry of entries) {
				const candidate = join(bunCache, entry, "node_modules", SDK_PKG);
				if (existsSync(join(candidate, "package.json"))) return candidate;
			}
		}
		throw new Error(`Could not locate ${SDK_PKG} in node_modules. Run \`bun install\` first.`);
	}
}

/**
 * Pick the koffi prebuild subdir for this host. Linux platform packages ship
 * BOTH a glibc build (`linux_<arch>/`) and a musl build (`musl_<arch>/`) side by
 * side; koffi's own loader chooses by reading the running interpreter, but we
 * copy one file at build time, so the choice has to be explicit. Directory
 * order from `readdirSync` is filesystem-dependent (ext4 listed `musl_x64`
 * first on the release runner), so never take "the first one found".
 */
export function pickKoffiSubdir(
	subdirs: readonly string[],
	platform: NodeJS.Platform,
	arch: string,
	musl: boolean,
): string | undefined {
	const preferred = platform === "linux" && musl ? `musl_${arch}` : `${platform}_${arch}`;
	if (subdirs.includes(preferred)) return preferred;
	// Never fall back across libcs: a musl addon on a glibc host (or vice versa)
	// fails at dlopen. Any other single candidate is fine (unusual layouts).
	const others = subdirs.filter((s) => !s.startsWith("musl_") || musl);
	return others.length === 1 ? others[0] : undefined;
}

/** True when the build host's libc is musl (Alpine and friends). */
function hostIsMusl(): boolean {
	if (process.platform !== "linux") return false;
	for (const dir of ["/lib", "/usr/lib"]) {
		try {
			if (readdirSync(dir).some((n) => n.startsWith("ld-musl-"))) return true;
		} catch {
			// unreadable dir: keep looking
		}
	}
	return false;
}

/**
 * Locate koffi's prebuilt native addon (`koffi.node`). koffi ships the binary in
 * a per-platform optional dependency (`@koromix/koffi-<platform>-<arch>`) whose
 * entry selects `./<triplet>/koffi.node` at runtime. koffi is a TRANSITIVE
 * dependency of `@microsoft/mxc-sdk` (not hoisted to `packages/less`), so
 * resolve koffi from the SDK dir first, then the platform package from koffi's
 * own dir. Returns undefined when koffi (or its platform addon) isn't installed
 * for the host — the caller degrades to sandbox-unavailable.
 */
function findKoffiNode(sdkDir: string): string | undefined {
	const arch = sdkArch(process.arch);
	const platformPkg = `@koromix/koffi-${process.platform}-${arch}`;
	try {
		const koffiManifest = Bun.resolveSync("koffi/package.json", sdkDir);
		const koffiDir = dirname(koffiManifest);
		const manifest = Bun.resolveSync(`${platformPkg}/package.json`, koffiDir);
		const pkgDir = dirname(manifest);
		const withAddon = readdirSync(pkgDir).filter((sub) =>
			existsSync(join(pkgDir, sub, "koffi.node")),
		);
		const sub = pickKoffiSubdir(withAddon, process.platform, arch, hostIsMusl());
		if (sub) return join(pkgDir, sub, "koffi.node");
		// Fall back to a direct child if the layout is flat.
		const flat = join(pkgDir, "koffi.node");
		return existsSync(flat) ? flat : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Write `embedded.ts`. When `assets` is empty (no binary for this platform),
 * the importer exports an empty manifest so the loader cleanly no-ops and the
 * SDK falls back to self-resolution / sandbox-unavailable passthrough.
 */
function writeEmbeddedModule(assets: { name: string; arch: string; executable: boolean }[]): void {
	const lines: string[] = [
		"// AUTO-GENERATED by scripts/build-mxc-runtime.ts — do not edit.",
		"// Staged mxc sandbox binaries, embedded into the compiled boundless via",
		'// `with { type: "file" }`. Regenerated on postinstall and build.',
		"",
	];
	assets.forEach((a, i) => {
		lines.push(`import bin${i} from "./${a.arch}/${a.name}.mxcbin" with { type: "file" };`);
	});
	lines.push("");

	// Hash the staged bytes so the loader caches per content version.
	const hash = createHash("sha256");
	for (const a of assets) {
		hash.update(readFileSync(join(OUT_DIR, a.arch, `${a.name}.mxcbin`)));
	}
	const digest = assets.length > 0 ? hash.digest("hex").slice(0, 16) : "none";

	lines.push(`export const MXC_RUNTIME_HASH = ${JSON.stringify(digest)};`);
	lines.push(
		"export const MXC_EMBEDDED_ASSETS: ReadonlyArray<{ name: string; arch: string; executable: boolean; path: string }> = [",
	);
	assets.forEach((a, i) => {
		lines.push(
			`\t{ name: ${JSON.stringify(a.name)}, arch: ${JSON.stringify(a.arch)}, executable: ${a.executable}, path: bin${i} },`,
		);
	});
	lines.push("];");
	lines.push("");
	writeFileSync(join(OUT_DIR, "embedded.ts"), lines.join("\n"));
}

function main(): void {
	const sdkDir = findSdkDir();
	const arch = sdkArch(process.arch);
	const names = hostBinaryNames(process.platform);

	// Reset staged binaries so a stale arch dir can't leak into the build.
	rmSync(OUT_DIR, { recursive: true, force: true });
	mkdirSync(join(OUT_DIR, arch), { recursive: true });

	const staged: { name: string; arch: string; executable: boolean }[] = [];
	for (const name of names) {
		const src = join(sdkDir, "bin", arch, name);
		if (!existsSync(src)) {
			console.warn(`[build-mxc-runtime] ${SDK_PKG} ships no ${arch}/${name}; skipping.`);
			continue;
		}
		copyFileSync(src, join(OUT_DIR, arch, `${name}.mxcbin`));
		// .dll and the like are loaded, not executed; only exec stubs need +x.
		const executable = !name.endsWith(".dll");
		staged.push({ name, arch, executable });
	}

	// Stage koffi's prebuilt native addon alongside the FFI library. v1's run()/
	// spawn() path loads libmxc_ffi.* THROUGH koffi, and koffi resolves its own
	// `.node` via a concatenated path invisible to `bun build --compile` (the
	// same class of problem node-pty has). The compiled boundless embeds this
	// staged `.node` and the koffi loader is patched (patchKoffiLoaderPlugin in
	// scripts/build.ts) to resolve it from MXC_FFI_DIR, where ensureMxcRuntime
	// materializes both files. Skipped on Windows (no mxc there) and whenever the
	// mxc library itself didn't stage (koffi alone is useless).
	if (staged.length > 0) {
		const koffiNode = findKoffiNode(sdkDir);
		if (koffiNode) {
			copyFileSync(koffiNode, join(OUT_DIR, arch, "koffi.node.mxcbin"));
			staged.push({ name: "koffi.node", arch, executable: true });
		} else {
			console.warn(
				"[build-mxc-runtime] koffi native addon not found; the compiled binary will not be able to load mxc's FFI. Sandboxing will be unavailable (passthrough).",
			);
		}
	}

	if (staged.length === 0) {
		console.warn(
			`[build-mxc-runtime] No mxc binaries staged for ${process.platform}/${arch}. Sandboxing will be unavailable in the compiled binary (passthrough).`,
		);
	}
	writeEmbeddedModule(staged);
	console.log(
		`[build-mxc-runtime] Staged ${staged.length} mxc binary(ies) for ${process.platform}/${arch}.`,
	);
}

if (import.meta.main) {
	main();
}
