import ts from "typescript";
import { computeLineHash } from "./hashline";

export interface StructureSymbol {
	name: string;
	anchor: string;
}

interface ExtractedSymbol {
	name: string;
	offset: number;
}

type StructureExtractor = (source: string, path: string) => ExtractedSymbol[];

export const MAX_STRUCTURE_OUTPUT_BYTES = 50_000;
/** Bound parser work before a source file can consume unbounded CPU or memory. */
export const MAX_SOURCE_STRUCTURE_INPUT_BYTES = 1_000_000;
export const SOURCE_STRUCTURE_INPUT_LIMIT_ERROR = "source file exceeds read_structure input limit";
export const SOURCE_STRUCTURE_PARSE_ERROR = "could not parse source structure";

/**
 * The declaration grammar emitted by read_structure for registered TS/JS files.
 *
 * At module top level, supported files emit named function, class, variable,
 * interface, type alias, enum, namespace/module, and named export declarations.
 * Imports, anonymous defaults, export stars, and nested declarations are omitted.
 */
export const SUPPORTED_SOURCE_STRUCTURE_GRAMMAR =
	"top-level function, class, variable, interface, type alias, enum, namespace, module, and named export declarations";

const TYPESCRIPT_EXTENSIONS = [
	".d.mts",
	".d.cts",
	".d.ts",
	".tsx",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".js",
] as const;

function extensionForPath(path: string): string | undefined {
	const lowerPath = path.toLowerCase();
	return TYPESCRIPT_EXTENSIONS.find((extension) => lowerPath.endsWith(extension));
}

function getDeclarationName(node: ts.Node): string | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isEnumDeclaration(node) ||
		ts.isModuleDeclaration(node)
	) {
		return node.name?.getText();
	}
	if (ts.isVariableStatement(node)) {
		const declaration = node.declarationList.declarations[0];
		return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
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

function scriptKindForExtension(extension: string): ts.ScriptKind {
	if (extension === ".tsx") return ts.ScriptKind.TSX;
	if (extension === ".jsx") return ts.ScriptKind.JSX;
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
		return ts.ScriptKind.JS;
	}
	return ts.ScriptKind.TS;
}

/** Extract supported top-level TypeScript/JavaScript declaration names as source offsets. */
function extractTypeScriptStructure(source: string, path: string): ExtractedSymbol[] {
	const extension = extensionForPath(path);
	if (!extension) return [];
	const sourceFile = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForExtension(extension),
	);
	const parseDiagnostics = (
		sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
	).parseDiagnostics;
	if (parseDiagnostics.length > 0) throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
	const symbols: ExtractedSymbol[] = [];
	for (const statement of sourceFile.statements) {
		const offset = statement.getStart(sourceFile);
		for (const name of declarationNames(statement)) symbols.push({ name, offset });
	}
	return symbols;
}

const EXTRACTORS: ReadonlyMap<string, StructureExtractor> = new Map(
	TYPESCRIPT_EXTENSIONS.map((extension) => [extension, extractTypeScriptStructure]),
);

function lineStarts(source: string): number[] {
	const starts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n") starts.push(index + 1);
	}
	return starts;
}

function lineForOffset(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length;
	while (low + 1 < high) {
		const middle = Math.floor((low + high) / 2);
		if ((starts[middle] ?? 0) <= offset) low = middle;
		else high = middle;
	}
	return low;
}

function assertInputSize(source: string): void {
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_STRUCTURE_INPUT_BYTES) {
		throw new Error(SOURCE_STRUCTURE_INPUT_LIMIT_ERROR);
	}
}

/**
 * Extract a flat, hashline-compatible outline. Unregistered extensions return
 * no symbols; parsing never falls through to another language extractor.
 */
export function extractSourceStructure(source: string, path = "structure.ts"): StructureSymbol[] {
	assertInputSize(source);
	const normalized = source.replace(/\r\n/g, "\n");
	const extension = extensionForPath(path);
	if (!extension) return [];
	const extractor = EXTRACTORS.get(extension);
	if (!extractor) return [];

	let extracted: ExtractedSymbol[];
	try {
		extracted = extractor(normalized, path);
	} catch {
		throw new Error(SOURCE_STRUCTURE_PARSE_ERROR);
	}

	const lines = normalized.split("\n");
	const starts = lineStarts(normalized);
	return extracted.map(({ name, offset }) => {
		const line = lineForOffset(starts, offset);
		return { name, anchor: `${line + 1}:${computeLineHash(lines[line] ?? "")}` };
	});
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
