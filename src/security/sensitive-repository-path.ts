const PRIVATE_KEY_PREFIXES = ["id_rsa", "id_ed25519"] as const;

/**
 * Identifies repository files that may contain credentials and must never be
 * imported, indexed, copied into an execution workspace, or sent to a model.
 *
 * `.env.example` remains eligible for ingestion as documentation. Its content
 * still passes through the independent secret-content scanner.
 */
export function isSensitiveRepositoryPath(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";

  if (name === ".env.example") return false;

  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    PRIVATE_KEY_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (/^credentials.*\.json$/u).test(name) ||
    (/^secrets.*\.json$/u).test(name)
  );
}
