import type { CodeParser, FileIntelligence } from "../domain/code-intelligence.js";
import type { RepositoryFile, SourceLanguage } from "../domain/repository.js";
import { JavaCodeParser, PythonCodeParser } from "./structured-language-parser.js";
import { TypeScriptCodeParser } from "./typescript-parser.js";

/** Routes each supported source file to its deterministic language parser. */
export class MultiLanguageCodeParser implements CodeParser {
  readonly #parsers: readonly CodeParser[] = [
    new TypeScriptCodeParser(),
    new PythonCodeParser(),
    new JavaCodeParser(),
  ];

  public readonly id = `multi-language-v1:${this.#parsers.map((parser) => parser.id).join(",")}`;

  public supports(language: SourceLanguage): boolean {
    return this.#parsers.some((parser) => parser.supports(language));
  }

  public parse(file: RepositoryFile): FileIntelligence {
    const parser = this.#parsers.find((candidate) => candidate.supports(file.language));
    if (parser === undefined) throw new Error(`No structural parser supports ${file.language}`);
    return parser.parse(file);
  }
}
