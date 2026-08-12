import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { PullRequestSummary } from "../domain/pr-summary.js";

export interface ReviewHistoryRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly repository: string;
  readonly objective: string;
  readonly headSha: string;
  readonly summary: PullRequestSummary;
}

const HISTORY_LIMIT = 50;

function historyPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), ".conclave", "review-history.json");
}

async function readHistory(repositoryRoot: string): Promise<ReviewHistoryRecord[]> {
  try {
    const value: unknown = JSON.parse(await readFile(historyPath(repositoryRoot), "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ReviewHistoryRecord =>
      typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
    );
  } catch {
    return [];
  }
}

export async function saveReviewHistory(
  repositoryRoot: string,
  record: ReviewHistoryRecord,
): Promise<void> {
  const destination = historyPath(repositoryRoot);
  const directory = resolve(destination, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = [record, ...(await readHistory(repositoryRoot))]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, HISTORY_LIMIT);
  const temporary = destination + ".tmp-" + String(process.pid);
  await writeFile(temporary, JSON.stringify(records, undefined, 2) + "\n", { mode: 0o600 });
  await rename(temporary, destination);
}

export async function listReviewHistory(repositoryRoot: string): Promise<readonly ReviewHistoryRecord[]> {
  return readHistory(repositoryRoot);
}
