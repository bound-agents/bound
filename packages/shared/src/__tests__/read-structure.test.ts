import { describe, expect, it } from "bun:test";
import {
	MAX_SOURCE_STRUCTURE_INPUT_BYTES,
	computeLineHash,
	extractSourceStructure,
	formatSourceStructure,
} from "../index";

describe("extractSourceStructure", () => {
	it("recognizes the supported top-level declaration matrix and excludes nested bodies", () => {
		const source = [
			"@sealed",
			"export declare abstract class Service {}",
			"export const answer = 42;",
			"declare let pending: boolean;",
			"var legacy = 1;",
			"export default async function fetcher() {",
			"  const nested = 1;",
			"}",
			"namespace Domain {",
			"  export const hidden = true;",
			"}",
			'declare module "external" {}',
			"export interface Shape {}",
			"export type Alias = string;",
			"export enum Kind { One }",
		].join("\r\n");

		expect(extractSourceStructure(source).map((symbol) => symbol.name)).toEqual([
			"Service",
			"answer",
			"pending",
			"legacy",
			"fetcher",
			"Domain",
			'"external"',
			"Shape",
			"Alias",
			"Kind",
		]);
		expect(formatSourceStructure(source)).toContain(`1:${computeLineHash("@sealed")}|Service`);
	});

	it("recognizes declarations despite syntax that defeats brace counting", () => {
		const source = [
			"// { export const fakeComment = 1; }",
			'const text = "{ export const fakeString = 1; }";',
			'const template = `} ${"{"} ${`nested ${"}"}`}`;',
			"const matcher = /{(?:not a declaration)}/;",
			"export const objectValue = { nested: { braces: true } };",
			"@sealed()",
			"export class Decorated {}",
			"export default function () {}",
			"export default class {}",
			"export default function namedDefault() {}",
			"export default class NamedDefault {}",
			"export { objectValue as renamed };",
		].join("\n");

		expect(extractSourceStructure(source).map((symbol) => symbol.name)).toEqual([
			"text",
			"template",
			"matcher",
			"objectValue",
			"Decorated",
			"namedDefault",
			"NamedDefault",
			"renamed",
		]);
	});

	it("parses TS and declaration-file syntax", () => {
		expect(
			extractSourceStructure(
				"export interface Shape {}\nexport type Id = string;",
				"types.d.ts",
			).map((symbol) => symbol.name),
		).toEqual(["Shape", "Id"]);
	});

	it("parses TSX and JSX syntax only for JSX-capable extensions", () => {
		const source = "export const view = <main>Hello</main>;\nexport const after = 1;";
		expect(extractSourceStructure(source, "component.tsx").map((symbol) => symbol.name)).toEqual([
			"view",
			"after",
		]);
		expect(extractSourceStructure(source, "component.jsx").map((symbol) => symbol.name)).toEqual([
			"view",
			"after",
		]);
		expect(() => extractSourceStructure(source, "component.ts")).toThrow(
			"could not parse source structure",
		);
	});

	it("extracts parser-backed Python, Go, and Rust top-level declarations", () => {
		expect(
			extractSourceStructure(
				[
					"@decorator",
					"class Service:",
					"    def nested(self): pass",
					"",
					"def greeting(name):",
					"    return name",
					"ANSWER = 42",
				].join("\n"),
				"service.py",
			).map((symbol) => symbol.name),
		).toEqual(["Service", "greeting", "ANSWER"]);
		expect(
			extractSourceStructure(
				[
					"package example",
					"",
					"type Service struct{}",
					"const Answer = 42",
					"var Pending bool",
					"func Greeting(name string) string { return name }",
				].join("\n"),
				"service.go",
			).map((symbol) => symbol.name),
		).toEqual(["Service", "Answer", "Pending", "Greeting"]);
		expect(
			extractSourceStructure(
				[
					"pub struct Service;",
					"pub const ANSWER: u32 = 42;",
					"pub fn greeting(name: &str) -> &str { name }",
					"mod hidden { pub fn nested() {} }",
				].join("\n"),
				"service.rs",
			).map((symbol) => symbol.name),
		).toEqual(["Service", "ANSWER", "greeting", "hidden"]);
	});

	it("extracts Go grouped var declarations", () => {
		expect(
			extractSourceStructure(
				["package example", "", "var (", "\tVisible int", "\tCount = 2", ")", ""].join("\n"),
				"grouped.go",
			).map((symbol) => symbol.name),
		).toEqual(["Visible", "Count"]);
	});

	it("extracts Rust implementation targets", () => {
		expect(
			extractSourceStructure(
				["struct Service;", "impl Service { fn nested() {} }", "impl Trait for Service {}"].join(
					"\n",
				),
				"service.rs",
			).map((symbol) => symbol.name),
		).toEqual(["Service", "Service", "Trait for Service"]);
	});

	it("parses JavaScript module variants", () => {
		for (const path of ["module.js", "module.mjs", "module.cjs"]) {
			expect(
				extractSourceStructure(
					"export const visible = 1;\nexport { visible as renamed };",
					path,
				).map((symbol) => symbol.name),
			).toEqual(["visible", "renamed"]);
		}
	});

	it("rejects malformed supported source", () => {
		expect(() => extractSourceStructure("export const = ;", "broken.ts")).toThrow(
			"could not parse source structure",
		);
	});

	it("anchors each symbol at its AST declaration rather than leading trivia", () => {
		const source = [
			"// module banner",
			"",
			"/** describes alpha */",
			"export const alpha = 1, beta = 2;",
		].join("\n");

		expect(extractSourceStructure(source, "sample.ts")).toEqual([
			{ name: "alpha", anchor: `4:${computeLineHash("export const alpha = 1, beta = 2;")}` },
			{ name: "beta", anchor: `4:${computeLineHash("export const alpha = 1, beta = 2;")}` },
		]);
	});

	it("bounds formatted output and marks truncation", () => {
		const source = Array.from(
			{ length: 400 },
			(_, index) => `export const item${index} = ${index};`,
		).join("\n");
		const result = formatSourceStructure(source, "structure.ts", 250);
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(250);
		expect(result).toContain("[truncated;");
	});
});

describe("source structure registry", () => {
	it("returns exactly empty output for unregistered and extensionless paths", () => {
		for (const path of ["README", "sample.txt"]) {
			expect(extractSourceStructure("export const accidental = 1;", path)).toEqual([]);
			expect(formatSourceStructure("export const accidental = 1;", path)).toBe("");
		}
	});

	it("normalizes line endings before hashing physical source lines", () => {
		const lf = "export const café = '☕';\n";
		const crlf = lf.replace(/\n/g, "\r\n");
		expect(formatSourceStructure(crlf, "sample.ts")).toBe(formatSourceStructure(lf, "sample.ts"));
	});

	it("rejects input above the shared pre-parse byte limit", () => {
		const source = "a".repeat(MAX_SOURCE_STRUCTURE_INPUT_BYTES + 1);
		expect(() => formatSourceStructure(source, "sample.ts")).toThrow(
			"source file exceeds read_structure input limit",
		);
	});
});
