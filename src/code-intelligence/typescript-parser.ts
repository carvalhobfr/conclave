import { createHash } from "node:crypto";

import ts from "typescript";

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

const SUPPORTED_LANGUAGES = new Set<SourceLanguage>([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
]);

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics: readonly ts.DiagnosticWithLocation[];
}

interface ImportSpecifierWithPhase extends ts.ImportSpecifier {
  readonly phaseModifier?: ts.SyntaxKind.TypeKeyword;
}

interface SymbolDescriptor {
  readonly symbol: string;
  readonly kind: CodeSymbolKind;
  readonly declaration: ts.Node;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scriptKind(language: SourceLanguage): ts.ScriptKind {
  switch (language) {
    case "typescript":
      return ts.ScriptKind.TS;
    case "tsx":
      return ts.ScriptKind.TSX;
    case "javascript":
      return ts.ScriptKind.JS;
    case "jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endLineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  const endPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1);
  return sourceFile.getLineAndCharacterOfPosition(endPosition).line + 1;
}

function nodeModifiers(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return nodeModifiers(node).some((modifier) => modifier.kind === kind);
}

function isExportedNode(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
    return true;
  }
  if (ts.isVariableDeclaration(node)) {
    const declarationList = node.parent;
    return ts.isVariableDeclarationList(declarationList) && isExportedNode(declarationList.parent);
  }
  return false;
}

function isAsyncNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child)
    ) {
      found = true;
      return;
    }
    if (!found) {
      ts.forEachChild(child, visit);
    }
  };
  ts.forEachChild(node, visit);
  return found;
}

function functionKind(name: string, node: ts.Node, variableAssigned: boolean): CodeSymbolKind {
  if (/^use[A-Z0-9]/.test(name)) {
    return "hook";
  }
  if (/^[A-Z]/.test(name) && containsJsx(node)) {
    return "react-component";
  }
  return variableAssigned ? "variable-function" : "function";
}

function symbolDescriptor(node: ts.Node): SymbolDescriptor | undefined {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return {
      symbol: node.name.text,
      kind: functionKind(node.name.text, node, false),
      declaration: node,
    };
  }
  if (ts.isClassDeclaration(node) && node.name !== undefined) {
    return { symbol: node.name.text, kind: "class", declaration: node };
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = propertyNameText(node.name);
    return name === undefined ? undefined : { symbol: name, kind: "method", declaration: node };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { symbol: node.name.text, kind: "interface", declaration: node };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { symbol: node.name.text, kind: "type-alias", declaration: node };
  }
  if (ts.isEnumDeclaration(node)) {
    return { symbol: node.name.text, kind: "enum", declaration: node };
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return {
      symbol: node.name.text,
      kind: functionKind(node.name.text, node.initializer, true),
      declaration: node,
    };
  }
  return undefined;
}

function extractImportBindings(clause: ts.ImportClause | undefined): ImportBinding[] {
  if (clause === undefined) {
    return [];
  }
  const bindings: ImportBinding[] = [];
  if (clause.name !== undefined) {
    bindings.push({
      imported: "default",
      local: clause.name.text,
      kind: "default",
      typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword,
    });
  }
  if (clause.namedBindings !== undefined) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({
        imported: "*",
        local: clause.namedBindings.name.text,
        kind: "namespace",
        typeOnly: clause.phaseModifier === ts.SyntaxKind.TypeKeyword,
      });
    } else {
      for (const element of clause.namedBindings.elements) {
        bindings.push({
          imported: element.propertyName?.text ?? element.name.text,
          local: element.name.text,
          kind: "named",
          typeOnly:
            clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            (element as ImportSpecifierWithPhase).phaseModifier === ts.SyntaxKind.TypeKeyword,
        });
      }
    }
  }
  return bindings;
}

function requireImport(
  sourceFile: ts.SourceFile,
  statement: ts.VariableStatement,
): ImportReference | undefined {
  if (statement.declarationList.declarations.length !== 1) {
    return undefined;
  }
  const declaration = statement.declarationList.declarations[0];
  if (
    declaration === undefined ||
    declaration.initializer === undefined ||
    !ts.isCallExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression) ||
    declaration.initializer.expression.text !== "require" ||
    declaration.initializer.arguments.length !== 1
  ) {
    return undefined;
  }
  const argument = declaration.initializer.arguments[0];
  if (argument === undefined || !ts.isStringLiteral(argument)) {
    return undefined;
  }
  const bindings: ImportBinding[] = [];
  if (ts.isIdentifier(declaration.name)) {
    bindings.push({ imported: "default", local: declaration.name.text, kind: "require", typeOnly: false });
  } else if (ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (ts.isIdentifier(element.name)) {
        bindings.push({
          imported: element.propertyName?.getText(sourceFile) ?? element.name.text,
          local: element.name.text,
          kind: "require",
          typeOnly: false,
        });
      }
    }
  }
  return {
    source: argument.text,
    line: lineOf(sourceFile, statement),
    bindings,
  };
}

function extractImports(sourceFile: ts.SourceFile): ImportReference[] {
  const imports: ImportReference[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push({
        source: statement.moduleSpecifier.text,
        line: lineOf(sourceFile, statement),
        bindings: extractImportBindings(statement.importClause),
      });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const reference = requireImport(sourceFile, statement);
      if (reference !== undefined) {
        imports.push(reference);
      }
    }
  }
  return imports;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function declarationNames(statement: ts.Statement): string[] {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name),
    );
  }
  return [];
}

function extractExports(sourceFile: ts.SourceFile): ExportReference[] {
  const exports: ExportReference[] = [];
  for (const statement of sourceFile.statements) {
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const kind: ExportReference["kind"] = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        ? "default"
        : "named";
      for (const name of declarationNames(statement)) {
        exports.push({ name: kind === "default" ? "default" : name, localName: name, line: lineOf(sourceFile, statement), kind });
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const source = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (statement.exportClause === undefined) {
        exports.push({
          name: "*",
          ...(source === undefined ? {} : { source }),
          line: lineOf(sourceFile, statement),
          kind: "re-export",
        });
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exports.push({
            name: element.name.text,
            localName: element.propertyName?.text ?? element.name.text,
            ...(source === undefined ? {} : { source }),
            line: lineOf(sourceFile, statement),
            kind: source === undefined ? "named" : "re-export",
          });
        }
      }
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = statement.expression.left;
      if (
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === "exports"
      ) {
        exports.push({
          name: target.name.text,
          localName: target.name.text,
          line: lineOf(sourceFile, statement),
          kind: "commonjs",
        });
      } else if (
        ts.isPropertyAccessExpression(target) &&
        ts.isPropertyAccessExpression(target.expression) &&
        ts.isIdentifier(target.expression.expression) &&
        target.expression.expression.text === "module" &&
        target.expression.name.text === "exports"
      ) {
        exports.push({
          name: target.name.text,
          localName: target.name.text,
          line: lineOf(sourceFile, statement),
          kind: "commonjs",
        });
      }
    }
  }
  return exports;
}

function referencesAndCalls(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { readonly references: readonly string[]; readonly calls: readonly CallReference[] } {
  const references = new Set<string>();
  const calls: CallReference[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) {
      references.add(child.text);
    }
    if (ts.isCallExpression(child)) {
      if (ts.isIdentifier(child.expression)) {
        calls.push({ name: child.expression.text, line: lineOf(sourceFile, child) });
      } else if (ts.isPropertyAccessExpression(child.expression)) {
        calls.push({ name: child.expression.name.text, line: lineOf(sourceFile, child) });
      }
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return {
    references: [...references].sort(),
    calls: calls.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name)),
  };
}

function heritageReferences(sourceFile: ts.SourceFile, node: ts.Node): HeritageReference[] {
  if (!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) {
    return [];
  }
  const references: HeritageReference[] = [];
  for (const clause of node.heritageClauses ?? []) {
    const relation: HeritageReference["relation"] =
      clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
    for (const type of clause.types) {
      if (ts.isIdentifier(type.expression)) {
        references.push({
          name: type.expression.text,
          relation,
          line: lineOf(sourceFile, type),
        });
      }
    }
  }
  return references.sort(
    (left, right) => left.line - right.line || left.relation.localeCompare(right.relation) || left.name.localeCompare(right.name),
  );
}

function parseDiagnostics(sourceFile: ts.SourceFile): ParseDiagnostic[] {
  const diagnostics = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics;
  return diagnostics.map((diagnostic) => {
    const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: location.line + 1,
      column: location.character + 1,
    };
  });
}

export class TypeScriptCodeParser implements CodeParser {
  public readonly id = `typescript-compiler-${ts.versionMajorMinor}`;

  public supports(language: SourceLanguage): boolean {
    return SUPPORTED_LANGUAGES.has(language);
  }

  public parse(file: RepositoryFile): FileIntelligence {
    const sourceFile = ts.createSourceFile(
      file.relativePath,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file.language),
    );
    const imports = extractImports(sourceFile);
    const exports = extractExports(sourceFile);
    const units: StructuralCodeUnit[] = [];

    const visit = (node: ts.Node, parentSymbol?: string): void => {
      const descriptor = symbolDescriptor(node);
      const nextParent = descriptor?.symbol ?? parentSymbol;
      if (descriptor !== undefined) {
        const startLine = lineOf(sourceFile, descriptor.declaration);
        const endLine = endLineOf(sourceFile, descriptor.declaration);
        const sourceText = descriptor.declaration.getText(sourceFile);
        const sourceIdentity = sha256(
          `${this.id}\0${descriptor.kind}\0${descriptor.symbol}\0${sourceText}`,
        );
        const details = referencesAndCalls(sourceFile, descriptor.declaration);
        units.push({
          id: `unit_${sha256(`${file.relativePath}\0${String(startLine)}\0${String(endLine)}\0${sourceIdentity}`).slice(0, 24)}`,
          sourceIdentity,
          path: file.relativePath,
          language: file.language,
          symbol: descriptor.symbol,
          symbolKind: descriptor.kind,
          startLine,
          endLine,
          sourceText,
          ...(parentSymbol === undefined ? {} : { parentSymbol }),
          imports,
          exports,
          references: details.references,
          calls: details.calls,
          heritage: heritageReferences(sourceFile, descriptor.declaration),
          exported: isExportedNode(node),
          async: isAsyncNode(node) || (ts.isVariableDeclaration(node) && node.initializer !== undefined && isAsyncNode(node.initializer)),
        });
      }
      ts.forEachChild(node, (child) => visit(child, nextParent));
    };
    visit(sourceFile);
    units.sort(
      (left, right) =>
        left.startLine - right.startLine ||
        left.endLine - right.endLine ||
        left.symbol.localeCompare(right.symbol),
    );

    return {
      path: file.relativePath,
      language: file.language,
      contentHash: file.sha256,
      sourceText: file.content,
      imports,
      exports,
      units,
      diagnostics: parseDiagnostics(sourceFile),
      parserId: this.id,
    };
  }
}
