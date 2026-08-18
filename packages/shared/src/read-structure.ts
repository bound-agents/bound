import ts from "typescript";
import { computeLineHash } from "./hashline";

export interface StructureSymbol {
	name: string;
	anchor: string;
}

export const MAX_STRUCTURE_OUTPUT_BYTES = 50_000;

/**
 * The declaration grammar emitted by read_structure.
 *
 * At module top level, JavaScript and TypeScript source files support named
 * function, class, variable, interface, type alias, enum, namespace, and
 * module declarations. Export declarations with a named export clause are
 * emitted by their exported name. `export default` declarations are emitted
 * only when they have a name. Decorators, modifiers, object literals, and
 * multiline declarations are handled by the TypeScript parser.
 *
 * Imports, anonymous default declarations, export-star declarations, and
 * declarations nested inside another declaration are intentionally omitted.
 */
export const SUPPORTED_SOURCE_STRUCTURE_GRAMMAR =
	"top-level function, class, variable, interface, type alias, enum, namespace, module, and named export declarations";

function getDeclarationName(node: ts.Node): string | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isModuleDeclaration(node)
	) {
		if (node.name) return node.name.getText();
		return undefined;
	}
	if (ts.isVariableStatement(node)) {
		const declaration = node.declarationList.declarations[0];
		return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
	}
	if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
		return undefined;
	}
	return undefined;
}

function declarationNames(node: ts.Node): string[] {
	if (ts.isVariableStatement(node)) {
		return node.declarationList.declarations.flatMap((declaration) =>
			ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
		);
	}
	if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
		return node.exportClause.elements.map((element) => element.name.text);
	}
	const name = getDeclarationName(node);
	return name ? [name] : [];
}

/** Select the TypeScript parser mode for the target source-file extension. */
function scriptKindForPath(path: string): ts.ScriptKind {
	const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
	if (extension === ".tsx") return ts.ScriptKind.TSX;
	if (extension === ".jsx") return ts.ScriptKind.JSX;
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
		return ts.ScriptKind.JS;
	}
	return ts.ScriptKind.TS;
}

/** Extract supported top-level JavaScript/TypeScript declaration names without source bodies. */
export function extractSourceStructure(source: string, path = "structure.ts"): StructureSymbol[] {
	const normalized = source.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const sourceFile = ts.createSourceFile(
		path,
		normalized,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForPath(path),
	);
	const symbols: StructureSymbol[] = [];

	for (const statement of sourceFile.statements) {
		const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line;
		for (const name of declarationNames(statement)) {
			symbols.push({ name, anchor: `${line + 1}:${computeLineHash(lines[line] ?? "")}` });
		}
	}
	return symbols;
}

export function formatSourceStructure(
	source: string,
	path = "structure.ts",
	maxBytes = MAX_STRUCTURE_OUTPUT_BYTES,
): string {
	const lines: string[] = [];
	for (const symbol of extractSourceStructure(source, path)) {
		const line = `${symbol.anchor}|${symbol.name}`;
		if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > maxBytes) {
			const marker = "[truncated; structure output limit reached]";
			while (
				lines.length > 0 &&
				Buffer.byteLength([...lines, marker].join("\n"), "utf8") > maxBytes
			) {
				lines.pop();
			}
			return [...lines, marker].join("\n");
		}
		lines.push(line);
	}
	return lines.join("\n");
}
