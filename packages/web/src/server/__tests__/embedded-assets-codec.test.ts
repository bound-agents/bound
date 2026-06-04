import { describe, expect, it } from "bun:test";
import {
	EMBEDDED_ASSETS_ENCODING,
	decodeAssetContent,
	encodeAssetContent,
} from "../embedded-assets-codec";

describe("embedded-assets codec", () => {
	it("round-trips arbitrary UTF-8 content losslessly", () => {
		const samples = [
			"<!doctype html>\n<html><body>héllo wörld 🚆</body></html>",
			'const e=Object.freeze(JSON.parse(`{"displayName":"Mermaid"}`));export{e as default};',
			"", // empty asset
			"a".repeat(100_000), // large asset
		];
		for (const raw of samples) {
			const encoded = encodeAssetContent(raw);
			expect(decodeAssetContent(encoded)).toBe(raw);
		}
	});

	it("produces a base64 payload with no readable source tokens (grep-opacity)", () => {
		// The whole point of #160-adjacent devx fix: a grep for an identifier that
		// appears in the asset must NOT match inside the encoded blob, so it can't
		// dump the asset into context.
		const raw = "export function loadEmbeddedAssets() { return connectorBackfillThing; }";
		const encoded = encodeAssetContent(raw);
		expect(encoded).not.toContain("loadEmbeddedAssets");
		expect(encoded).not.toContain("connectorBackfillThing");
		expect(encoded).not.toContain("function");
		// base64 alphabet only
		expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
	});

	it("compresses compressible text below its original size", () => {
		const raw = JSON.stringify({ k: "v".repeat(5000) });
		expect(encodeAssetContent(raw).length).toBeLessThan(raw.length);
	});

	it("exposes a stable encoding marker", () => {
		expect(EMBEDDED_ASSETS_ENCODING).toBe("gzip-base64");
	});
});
