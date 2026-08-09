import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import type {
  LoadRepositoryRequest,
  RepositoryFile,
  RepositoryScanStats,
  RepositorySnapshot,
  RepositorySource,
} from "../domain/repository.js";
import { assessRepositoryContent } from "../security/content-safety.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { isSensitiveRepositoryPath } from "../security/sensitive-repository-path.js";
import { detectLanguage, isLikelyBinary } from "./file-classifier.js";
import { createRepositoryIgnore } from "./ignore-rules.js";

export interface LocalFolderRepositoryOptions {
  readonly allowedRoots?: readonly string[];
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
}

interface MutableStats {
  filesLoaded: number;
  bytesLoaded: number;
  ignoredEntries: number;
  skippedBinaryFiles: number;
  skippedOversizedFiles: number;
  skippedUnreadableFiles: number;
  skippedSymlinks: number;
  safetyBlockedFiles: number;
}

function emptyStats(): MutableStats {
  return {
    filesLoaded: 0,
    bytesLoaded: 0,
    ignoredEntries: 0,
    skippedBinaryFiles: 0,
    skippedOversizedFiles: 0,
    skippedUnreadableFiles: 0,
    skippedSymlinks: 0,
    safetyBlockedFiles: 0,
  };
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function asReadonlyStats(stats: MutableStats): RepositoryScanStats {
  return { ...stats };
}

export class RepositoryLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryLimitError";
  }
}

export class LocalFolderRepository implements RepositorySource {
  readonly #allowedRoots: readonly string[] | undefined;
  readonly #maxFileBytes: number;
  readonly #maxFiles: number;

  public constructor(options: LocalFolderRepositoryOptions = {}) {
    this.#allowedRoots = options.allowedRoots;
    this.#maxFileBytes = options.maxFileBytes ?? 1_000_000;
    this.#maxFiles = options.maxFiles ?? 25_000;
  }

  public async load(request: LoadRepositoryRequest): Promise<RepositorySnapshot> {
    const rootPath = await resolveRepositoryRoot(request.path, this.#allowedRoots);
    const ignore = await createRepositoryIgnore(rootPath);
    const files: RepositoryFile[] = [];
    const stats = emptyStats();
    const directories = [rootPath];

    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) {
        break;
      }

      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const absolutePath = join(directory, entry.name);
        const relativePath = toPosixPath(relative(rootPath, absolutePath));
        const ignoreCandidate = entry.isDirectory() ? `${relativePath}/` : relativePath;

        if (isSensitiveRepositoryPath(relativePath) || ignore.ignores(ignoreCandidate)) {
          stats.ignoredEntries += 1;
          continue;
        }

        if (entry.isSymbolicLink()) {
          stats.skippedSymlinks += 1;
          continue;
        }

        if (entry.isDirectory()) {
          directories.push(absolutePath);
          continue;
        }

        if (!entry.isFile()) {
          stats.skippedUnreadableFiles += 1;
          continue;
        }

        if (files.length >= this.#maxFiles) {
          throw new RepositoryLimitError(
            `Repository exceeds the ${String(this.#maxFiles)} file safety limit`,
          );
        }

        await this.#loadFile(rootPath, absolutePath, relativePath, files, stats);
      }
    }

    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const repositoryId = createHash("sha256").update(rootPath).digest("hex").slice(0, 16);

    return {
      repository: {
        id: repositoryId,
        kind: "local-folder",
        name: basename(rootPath),
        rootPath,
      },
      files,
      scannedAt: new Date().toISOString(),
      stats: asReadonlyStats(stats),
    };
  }

  async #loadFile(
    rootPath: string,
    absolutePath: string,
    relativePath: string,
    files: RepositoryFile[],
    stats: MutableStats,
  ): Promise<void> {
    try {
      const fileStats = await lstat(absolutePath);
      if (fileStats.isSymbolicLink()) {
        stats.skippedSymlinks += 1;
        return;
      }
      if (fileStats.size > this.#maxFileBytes) {
        stats.skippedOversizedFiles += 1;
        return;
      }

      const canonicalFilePath = await realpath(absolutePath);
      if (!isPathInside(rootPath, canonicalFilePath)) {
        stats.skippedUnreadableFiles += 1;
        return;
      }

      const bytes = await readFile(canonicalFilePath);
      if (isLikelyBinary(relativePath, bytes)) {
        stats.skippedBinaryFiles += 1;
        return;
      }

      const content = bytes.toString("utf8");
      const safety = assessRepositoryContent(content);
      if (!safety.externalTransmissionAllowed) {
        stats.safetyBlockedFiles += 1;
      }
      files.push({
        relativePath,
        language: detectLanguage(relativePath),
        content,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        modifiedAt: fileStats.mtime.toISOString(),
        safety,
      });
      stats.filesLoaded += 1;
      stats.bytesLoaded += bytes.byteLength;
    } catch {
      stats.skippedUnreadableFiles += 1;
    }
  }
}
