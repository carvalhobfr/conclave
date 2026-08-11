import { describe, expect, it } from "vitest";

import {
  parseNameStatus,
  parseUnifiedDiff,
} from "../src/validation/git-change-set.js";

describe("GitChangeSetService parsers", () => {
  it("parses NUL-delimited statuses and zero-context hunk ranges", () => {
    const statuses = parseNameStatus(
      "M\0src/session.ts\0R100\0src/old.ts\0src/new.ts\0",
    );
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/session.ts b/src/session.ts",
        "--- a/src/session.ts",
        "+++ b/src/session.ts",
        "@@ -2,1 +2,2 @@",
        "-  return oldValue;",
        "+  const value = restore();",
        "+  return value;",
        "",
      ].join("\n"),
      statuses,
    );

    expect(files).toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        hunks: [],
      },
      {
        path: "src/session.ts",
        status: "modified",
        hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }],
      },
    ]);
  });
});
