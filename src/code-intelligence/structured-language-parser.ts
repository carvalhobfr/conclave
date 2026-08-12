import { createHash } from "node:crypto";

import type {
  CallReference,
  CodeParser,
  CodeSymbolKind,
  ExportReference,
  FileIntelligence,
  HeritageReference,
  ImportBinding,
  ImportReference,
  ParseDiagnostic,
  StructuralCodeUnit,
} from "../domain/code-intelligence.js";
import type { RepositoryFile, SourceLanguage } from "../domain/repository.js";

interface Declaration {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: number;
  readonly exported: boolean;
  readonly async: boolean;
  readonly heritage: readonly HeritageReference[];
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "class", "def", "new", "with", "synchronized",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function indentOf(line: string): number {
  return line.match(/^\s*/)?.[0].replaceAll("\t", "    ").length ?? 0;
}

function lineSource(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

function referencesAndCalls(source: string, startLine: number): { readonly references: readonly string[]; readonly calls: readonly CallReference[] } {
  const references = new Set<string>();
  for (const match of source.matchAll(IDENTIFIER)) references.add(match[0]);
  const calls: CallReference[] = [];
  for (const match of source.matchAll(CALL)) {
    const name = match[1];
    if (name === undefined || CALL_KEYWORDS.has(name)) continue;
    const before = source.slice(0, match.index);
    calls.push({ name, line: startLine + (before.match(/\n/g)?.length ?? 0) });
  }
  return {
    references: [...references].sort(),
    calls: calls.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name)),
  };
}

function braceEnd(lines: readonly string[], startLine: number): number {
  let depth = 0;
  let opened = false;
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const character of line) {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (opened && depth <= 0) return index + 1;
  }
  return startLine;
}

function pythonEnd(lines: readonly string[], startLine: number, indent: number): number {
  let last = startLine;
  for (let index = startLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      last = index + 1;
      continue;
    }
    if (indentOf(line) <= indent) break;
    last = index + 1;
  }
  return last;
}

function parentFor(declaration: Declaration, declarations: readonly Declaration[]): string | undefined {
  return declarations
    .filter((candidate) =>
      candidate.name !== declaration.name &&
      candidate.startLine < declaration.startLine &&
      candidate.endLine >= declaration.endLine &&
      candidate.indent < declaration.indent,
    )
    .sort(
      (left, right) =>
        (left.endLine - left.startLine) - (right.endLine - right.startLine) ||
        right.indent - left.indent,
    )[0]?.name;
}

function parseUnits(
  file: RepositoryFile,
  parserId: string,
  declarations: readonly Declaration[],
): readonly StructuralCodeUnit[] {
  const lines = file.content.split("\n");
  return declarations
    .map((declaration) => {
      const sourceText = lineSource(lines, declaration.startLine, declaration.endLine);
      const parentSymbol = parentFor(declaration, declarations);
      const parentDeclaration = declarations.find((candidate) => candidate.name === parentSymbol);
      const symbolKind: CodeSymbolKind =
        declaration.kind === "function" && parentDeclaration?.kind === "class" ? "method" : declaration.kind;
      const sourceIdentity = sha256(`${parserId}\0${symbolKind}\0${declaration.name}\0${sourceText}`);
      const details = referencesAndCalls(sourceText, declaration.startLine);
      return {
        id: `unit_${sha256(`${file.relativePath}\0${String(declaration.startLine)}\0${String(declaration.endLine)}\0${sourceIdentity}`).slice(0, 24)}`,
        sourceIdentity,
        path: file.relativePath,
        language: file.language,
        symbol: declaration.name,
        symbolKind,
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        sourceText,
        ...(parentSymbol === undefined ? {} : { parentSymbol }),
        imports: [],
        exports: [],
        references: details.references,
        calls: details.calls,
        heritage: declaration.heritage,
        exported: declaration.exported,
        async: declaration.async,
      } satisfies StructuralCodeUnit;
    })
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine || left.symbol.localeCompare(right.symbol));
}

function withFileReferences(
  units: readonly StructuralCodeUnit[],
  imports: readonly ImportReference[],
  exports: readonly ExportReference[],
): readonly StructuralCodeUnit[] {
  return units.map((unit) => ({ ...unit, imports, exports }));
}

function pythonImports(lines: readonly string[]): ImportReference[] {
  const imports: ImportReference[] = [];
  lines.forEach((line, index) => {
    const importMatch = /^\s*import\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (importMatch?.[1] !== undefined) {
      for (const item of importMatch[1].split(",")) {
        const [module, alias] = item.trim().split(/\s+as\s+/);
        if (module === undefined || module === "") continue;
        const local = alias ?? module.split(".").at(-1) ?? module;
        imports.push({
          source: module,
          line: index + 1,
          bindings: [{ imported: local, local, kind: "named", typeOnly: false }],
        });
      }
      return;
    }
    const fromMatch = /^\s*from\s+([.\w]+)\s+import\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (fromMatch?.[1] === undefined || fromMatch[2] === undefined) return;
    const bindings: ImportBinding[] = fromMatch[2].split(",").flatMap((item) => {
      const [imported, alias] = item.trim().split(/\s+as\s+/);
      if (imported === undefined || imported === "") return [];
      return [{ imported, local: alias ?? imported, kind: "named", typeOnly: false }];
    });
    imports.push({ source: fromMatch[1], line: index + 1, bindings });
  });
  return imports;
}

function pythonDeclarations(lines: readonly string[]): Declaration[] {
  const declarations: Declaration[] = [];
  lines.forEach((line, index) => {
    const functionMatch = /^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    const classMatch = /^(\s*)class\s+([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*:/.exec(line);
    if (functionMatch?.[3] !== undefined) {
      const indent = indentOf(line);
      declarations.push({
        name: functionMatch[3],
        kind: "function",
        startLine: index + 1,
        endLine: pythonEnd(lines, index + 1, indent),
        indent,
        exported: indent === 0 && !functionMatch[3].startsWith("_"),
        async: functionMatch[2] !== undefined,
        heritage: [],
      });
      return;
    }
    if (classMatch?.[2] === undefined) return;
    const indent = indentOf(line);
    const bases = classMatch[3]?.split(",").map((base) => base.trim()).filter(Boolean) ?? [];
    declarations.push({
      name: classMatch[2],
      kind: "class",
      startLine: index + 1,
      endLine: pythonEnd(lines, index + 1, indent),
      indent,
      exported: indent === 0 && !classMatch[2].startsWith("_"),
      async: false,
      heritage: bases.map((name) => ({ name, relation: "extends", line: index + 1 })),
    });
  });
  return declarations;
}

function javaImports(lines: readonly string[]): ImportReference[] {
  const imports: ImportReference[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?\s*;/.exec(line);
    if (match?.[1] === undefined) return;
    const wildcard = match[2] !== undefined;
    const imported = wildcard ? "*" : match[1].split(".").at(-1) ?? match[1];
    imports.push({
      source: wildcard ? match[1] : match[1],
      line: index + 1,
      bindings: [{ imported, local: imported, kind: wildcard ? "namespace" : "named", typeOnly: false }],
    });
  });
  return imports;
}

function javaDeclarations(lines: readonly string[]): Declaration[] {
  const declarations: Declaration[] = [];
  const classNames: string[] = [];
  lines.forEach((line, index) => {
    const typeMatch = /^(\s*)((?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*)(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)([^{]*)/.exec(line);
    if (typeMatch?.[4] !== undefined) {
      const modifiers = typeMatch[2] ?? "";
      const kind: CodeSymbolKind = typeMatch[3] === "interface" ? "interface" : typeMatch[3] === "enum" ? "enum" : "class";
      const heritage: HeritageReference[] = [];
      const tail = typeMatch[5] ?? "";
      const extendsMatch = /\bextends\s+([\w$.]+)/.exec(tail);
      if (extendsMatch?.[1] !== undefined) heritage.push({ name: extendsMatch[1].split(".").at(-1) ?? extendsMatch[1], relation: "extends", line: index + 1 });
      const implementsMatch = /\bimplements\s+([^{]+)/.exec(tail);
      for (const name of implementsMatch?.[1]?.split(",").map((value) => value.trim()).filter(Boolean) ?? []) {
        heritage.push({ name: name.split("<")[0]?.trim() ?? name, relation: "implements", line: index + 1 });
      }
      classNames.push(typeMatch[4]);
      declarations.push({
        name: typeMatch[4],
        kind,
        startLine: index + 1,
        endLine: braceEnd(lines, index + 1),
        indent: indentOf(line),
        exported: modifiers.includes("public"),
        async: false,
        heritage,
      });
      return;
    }
    const methodMatch = /^(\s*)((?:(?:public|protected|private|abstract|final|static|synchronized|native|strictfp)\s+)*)(?:<[^>]+>\s+)?[\w$<>,.? ]+\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws [^{]+)?\s*\{/.exec(line);
    const constructorMatch = /^(\s*)((?:(?:public|protected|private|protected)\s+)*)([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/.exec(line);
    const name = methodMatch?.[3] ?? (constructorMatch !== null && classNames.includes(constructorMatch[3] ?? "") ? constructorMatch[3] : undefined);
    if (name === undefined) return;
    const modifiers = methodMatch?.[2] ?? constructorMatch?.[2] ?? "";
    declarations.push({
      name,
      kind: "method",
      startLine: index + 1,
      endLine: braceEnd(lines, index + 1),
      indent: indentOf(line),
      exported: modifiers.includes("public"),
      async: false,
      heritage: [],
    });
  });
  return declarations;
}

function exportsFor(declarations: readonly Declaration[]): ExportReference[] {
  return declarations
    .filter((declaration) => declaration.exported)
    .map((declaration) => ({
      name: declaration.name,
      localName: declaration.name,
      line: declaration.startLine,
      kind: "named" as const,
    }))
    .sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}

function parseDiagnostics(): readonly ParseDiagnostic[] {
  // These parsers intentionally avoid claiming compiler-level correctness. The
  // structural index is still useful when a source file is partially edited.
  return [];
}

abstract class RegexLanguageParser implements CodeParser {
  public abstract readonly id: string;
  public abstract readonly language: SourceLanguage;

  public supports(language: SourceLanguage): boolean {
    return language === this.language;
  }

  protected abstract imports(lines: readonly string[]): ImportReference[];
  protected abstract declarations(lines: readonly string[]): Declaration[];

  public parse(file: RepositoryFile): FileIntelligence {
    const lines = file.content.split("\n");
    const imports = this.imports(lines);
    const declarations = this.declarations(lines);
    const exports = exportsFor(declarations);
    const units = withFileReferences(parseUnits(file, this.id, declarations), imports, exports);
    return {
      path: file.relativePath,
      language: file.language,
      contentHash: file.sha256,
      sourceText: file.content,
      imports,
      exports,
      units,
      diagnostics: parseDiagnostics(),
      parserId: this.id,
    };
  }
}

export class PythonCodeParser extends RegexLanguageParser {
  public readonly id = "python-structural-v1";
  public readonly language = "python" as const;

  protected imports(lines: readonly string[]): ImportReference[] {
    return pythonImports(lines);
  }

  protected declarations(lines: readonly string[]): Declaration[] {
    return pythonDeclarations(lines);
  }
}

export class JavaCodeParser extends RegexLanguageParser {
  public readonly id = "java-structural-v1";
  public readonly language = "java" as const;

  protected imports(lines: readonly string[]): ImportReference[] {
    return javaImports(lines);
  }

  protected declarations(lines: readonly string[]): Declaration[] {
    return javaDeclarations(lines);
  }
}
