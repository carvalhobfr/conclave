import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class RepositoryPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryPathError";
  }
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const child = relative(parentPath, candidatePath);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export async function resolveRepositoryRoot(
  requestedPath: string,
  allowedRoots?: readonly string[],
): Promise<string> {
  const resolvedPath = resolve(requestedPath);
  let canonicalPath: string;

  try {
    const pathStats = await stat(resolvedPath);
    if (!pathStats.isDirectory()) {
      throw new RepositoryPathError(`Repository path is not a directory: ${resolvedPath}`);
    }
    canonicalPath = await realpath(resolvedPath);
  } catch (error) {
    if (error instanceof RepositoryPathError) {
      throw error;
    }
    throw new RepositoryPathError(`Repository path is not accessible: ${resolvedPath}`);
  }

  if (allowedRoots !== undefined && allowedRoots.length > 0) {
    const canonicalAllowedRoots = await Promise.all(
      allowedRoots.map(async (allowedRoot) => realpath(resolve(allowedRoot))),
    );
    if (!canonicalAllowedRoots.some((allowedRoot) => isPathInside(allowedRoot, canonicalPath))) {
      throw new RepositoryPathError("Repository path is outside the configured allowed roots");
    }
  }

  return canonicalPath;
}
