import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function decodedValue(raw: string, lineNumber: number): string {
  const value = raw.trim();
  if (value === "") return "";
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") return value.replace(/\s+#.*$/, "").trim();
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "\"" && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      const trailing = value.slice(index + 1).trim();
      if (trailing !== "" && !trailing.startsWith("#")) {
        throw new Error(`Invalid .env value on line ${String(lineNumber)}`);
      }
      const content = value.slice(1, index);
      if (quote === "'") return content;
      try {
        return JSON.parse(`"${content}"`) as string;
      } catch {
        throw new Error(`Invalid quoted .env value on line ${String(lineNumber)}`);
      }
    }
    escaped = false;
  }
  throw new Error(`Unterminated .env value on line ${String(lineNumber)}`);
}

/** Loads a local .env fallback without replacing variables owned by the process. */
export async function loadLocalEnvironment(path = resolve(".env"), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const [index, sourceLine] of content.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (match === null) throw new Error(`Invalid .env assignment on line ${String(index + 1)}`);
    const key = match[1];
    const raw = match[2];
    if (key !== undefined && raw !== undefined && environment[key] === undefined) {
      environment[key] = decodedValue(raw, index + 1);
    }
  }
}
