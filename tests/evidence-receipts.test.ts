import { describe, expect, it } from "vitest";

import type { ValidationLineage } from "../src/domain/validation.js";
import {
  evaluateEvidenceReceipts,
  parseEvidenceReceiptEnvelope,
} from "../src/validation/evidence-receipts.js";

const lineage: ValidationLineage = {
  seriesId: "series_test",
  reviewId: "review_test",
  baselineTrust: "none",
  objectiveDigest: "objective_" + "1".repeat(64),
  contractDigest: "contract_" + "2".repeat(64),
  diffDigest: "diff_" + "3".repeat(64),
  artifactDigest: "artifact_" + "4".repeat(64),
  reportDigest: "report_" + "5".repeat(64),
  contractStatus: "initial",
  rebaselineRequired: false,
  contractDelta: {
    objectiveChanged: false,
    addedClaimIds: [],
    removedClaimIds: [],
    changedClaimIds: [],
    allowedPathPrefixesAdded: [],
    allowedPathPrefixesRemoved: [],
  },
  contractSnapshot: { allowedPathPrefixes: [], claims: [] },
};

describe("evidence receipts", () => {
  it("parses a bounded receipt envelope and never elevates claimed trust", () => {
    const receipts = parseEvidenceReceiptEnvelope({
      version: 1,
      receipts: [{
        id: "ci-tests",
        type: "test",
        command: "npm test",
        exitCode: 0,
        startedAt: "2026-08-13T10:00:00.000Z",
        finishedAt: "2026-08-13T10:01:00.000Z",
        artifactDigest: lineage.artifactDigest,
        outputDigest: "6".repeat(64),
        runner: "ci",
        trustLevel: "ci-attested",
      }],
    });
    const summary = evaluateEvidenceReceipts(receipts, lineage, "head", true);

    expect(summary.items[0]).toEqual(expect.objectContaining({
      id: "ci-tests",
      status: "current",
      claimedTrustLevel: "ci-attested",
      effectiveTrustLevel: "self-reported",
    }));
    expect(summary.items[0]?.reasons).toContain(
      "claimed trust level is not cryptographically verified and is treated as self-reported",
    );
  });

  it("turns malformed envelopes and fields into invalid evidence instead of throwing", () => {
    const invalidEnvelope = parseEvidenceReceiptEnvelope({ receipts: [] }, "bad-envelope");
    const invalidField = parseEvidenceReceiptEnvelope({
      version: 1,
      receipts: [{ id: "bad-date", type: "test", startedAt: "not-a-date" }],
    });

    expect(evaluateEvidenceReceipts(invalidEnvelope, lineage, "head").items[0]?.status).toBe("invalid");
    expect(evaluateEvidenceReceipts(invalidField, lineage, "head").items[0]).toEqual(expect.objectContaining({
      id: "bad-date",
      status: "invalid",
    }));
  });

  it("requires an output digest even when the artifact binding is current", () => {
    const summary = evaluateEvidenceReceipts([{
      id: "exit-code-only",
      type: "test",
      artifactDigest: lineage.artifactDigest,
      exitCode: 0,
    }], lineage, "head", true);

    expect(summary.items[0]).toEqual(expect.objectContaining({
      status: "unbound",
      reasons: ["receipt is missing required evidence metadata: command, startedAt, finishedAt, outputDigest, runner"],
    }));
  });

  it("rejects duplicate receipt identities", () => {
    const duplicate = {
      id: "same-check",
      type: "test" as const,
      artifactDigest: lineage.artifactDigest,
      outputDigest: "7".repeat(64),
      command: "npm test",
      exitCode: 0,
      startedAt: "2026-08-13T10:00:00.000Z",
      finishedAt: "2026-08-13T10:01:00.000Z",
      runner: "ci",
    };
    const summary = evaluateEvidenceReceipts([duplicate, duplicate], lineage, "head", true);

    expect(summary.items).toHaveLength(2);
    expect(summary.items.every((item) => item.status === "invalid")).toBe(true);
  });
});
