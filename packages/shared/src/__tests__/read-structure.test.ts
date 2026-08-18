import { describe, expect, it } from "bun:test";
import { computeLineHash, extractSourceStructure, formatSourceStructure } from "../index";

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

	it("parses JSX syntax only when the target file extension supports it", () => {
		const source = ["export const view = <main>Hello</main>;", "export const after = 1;"].join(
			"\n",
		);

		expect(extractSourceStructure(source, "component.tsx").map((symbol) => symbol.name)).toEqual([
			"view",
			"after",
		]);
		expect(extractSourceStructure(source, "component.ts").map((symbol) => symbol.name)).toEqual([
			"view",
			"after",
		]);
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
