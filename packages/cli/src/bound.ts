#!/usr/bin/env bun
// Bootstrap shim for the `bound` binary. The real entry point lives in
// bound-main.ts.
//
// Why a shim:
//   reflect-metadata is a CommonJS package whose only purpose is to mutate
//   globalThis.Reflect at module-evaluation time. Its TypeScript declaration
//   is literally `export {}` (zero ESM exports), and its JS file does not
//   set `module.exports` to anything either. When the entry point uses a
//   bare side-effect import — `import "reflect-metadata"` — and the bundle
//   is produced by `bun build --compile`, the bundler statically concludes
//   the import is dead (no exports referenced) and elides the CJS
//   evaluation entirely. tsyringe then throws "tsyringe requires a reflect
//   polyfill" at top-level init.
//
//   A namespace import + `void` reference does not help either: the
//   namespace is statically empty (because `export {}`), so the bundler
//   sees `void {}` and tree-shakes both halves.
//
//   Dynamic import is a runtime operation the bundler cannot eliminate.
//   But ESM hoists every static import in a module above any top-level
//   code in that same module, including top-level `await import(...)`.
//   That means we cannot mix a dynamic import of reflect-metadata with
//   static imports of code that transitively pulls in tsyringe — the
//   static imports would still run first.
//
//   The shim therefore has *zero* static imports. It dynamically imports
//   reflect-metadata, then dynamically imports bound-main.ts. The dynamic
//   imports are evaluated in source order at runtime, so the polyfill is
//   guaranteed to be in place before any tsyringe-touching module loads.
//
// Verification:
//   After the polyfill import, we assert globalThis.Reflect.getMetadata is
//   a function. If the bundler ever finds a way to elide the dynamic
//   import too, this assertion produces a clear, actionable error instead
//   of the same opaque tsyringe message.

// Make this file a module (top-level await requires module context).
export {};

await import("reflect-metadata");

if (
	typeof (globalThis as { Reflect?: { getMetadata?: unknown } }).Reflect?.getMetadata !== "function"
) {
	throw new Error(
		"reflect-metadata polyfill did not load. The bundler may have elided the dynamic import in packages/cli/src/bound.ts.",
	);
}

await import("./bound-main.js");
