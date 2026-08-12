import { extname } from "node:path";

import type { SourceLanguage } from "../domain/repository.js";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SourceLanguage>> = {
  ".cjs": "javascript",
  ".css": "css",
  ".cts": "typescript",
  ".htm": "html",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "jsx",
  ".md": "markdown",
  ".mdx": "markdown",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".py": "python",
  ".pyw": "python",
  ".sh": "shell",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".class",
  ".dmg",
  ".doc",
  ".docx",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".rar",
  ".so",
  ".tar",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip",
]);

export function detectLanguage(path: string): SourceLanguage {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? "unknown";
}

export function isLikelyBinary(path: string, content: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) {
    return true;
  }

  const inspected = content.subarray(0, 8_000);
  if (inspected.includes(0)) {
    return true;
  }

  if (inspected.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;
  for (const byte of inspected) {
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    if ((byte < 32 && !isAllowedControl) || byte === 127) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / inspected.length > 0.1;
}
