import { stat } from "node:fs/promises";

import { expect } from "vitest";

/**
 * Asserts that a file is readable and writable only by its owner.
 *
 * Windows has no POSIX mode bits: NTFS uses ACLs, and Node reports 0o666 for every regular
 * file there regardless of its real access control. The guarantee still holds on the platforms
 * that can express it, so the assertion runs there and is skipped where it is meaningless.
 */
export async function expectOwnerOnlyFile(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if (process.platform === "win32") return;
  expect(mode).toBe(0o600);
}
