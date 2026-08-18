import { describe, expect, it } from "vitest";

import { createValidationContract, parseValidationContract } from "../src/validation/contract-parser.js";

describe("validation contract parser", () => {
  it("accepts a complete contract and trims its text", () => {
    expect(parseValidationContract({
      objective: "  Keep refunds idempotent  ",
      allowedPathPrefixes: [" src/refund ", "src/billing"],
      claims: [
        { id: "c1", statement: " refund() exists ", check: { kind: "symbol-exists", symbol: " refund ", expectation: "present" } },
        { id: "c2", statement: "no legacy call", check: { kind: "text", text: "legacyRefund(", expectation: "absent" } },
      ],
    })).toEqual({
      objective: "Keep refunds idempotent",
      allowedPathPrefixes: ["src/refund", "src/billing"],
      claims: [
        { id: "c1", statement: "refund() exists", check: { kind: "symbol-exists", symbol: "refund", expectation: "present" } },
        { id: "c2", statement: "no legacy call", check: { kind: "text", text: "legacyRefund(", expectation: "absent" } },
      ],
    });
  });

  it("defaults claims and prefixes so an objective-only contract is valid", () => {
    expect(parseValidationContract({ objective: "Ship it" })).toEqual({
      objective: "Ship it",
      claims: [],
      allowedPathPrefixes: [],
    });
  });

  it("lets an explicit objective override the one carried by the contract file", () => {
    const contract = parseValidationContract({ objective: "stale objective" }, "  objective from the CLI  ");
    expect(contract.objective).toBe("objective from the CLI");
  });

  it("rejects every shape that is not a contract object", () => {
    for (const value of [null, "text", 42, [], undefined]) {
      expect(() => parseValidationContract(value)).toThrow("Validation contract must be an object");
    }
  });

  it("rejects a duplicate claim id instead of silently keeping one", () => {
    expect(() => parseValidationContract({
      objective: "Objective",
      claims: [
        { id: "same", statement: "first", check: { kind: "symbol-exists", symbol: "a", expectation: "present" } },
        { id: "same", statement: "second", check: { kind: "symbol-exists", symbol: "b", expectation: "present" } },
      ],
    })).toThrow("claims contain a duplicate id: same");
  });

  it("names the exact field that failed so an agent can repair the contract", () => {
    const cases: readonly { readonly value: unknown; readonly message: string }[] = [
      { value: { objective: "o", claims: {} }, message: "claims must be an array" },
      { value: { objective: "o", allowedPathPrefixes: "src" }, message: "allowedPathPrefixes must be an array" },
      { value: { objective: 7 }, message: "objective must be a string" },
      { value: { objective: "o", allowedPathPrefixes: [""] }, message: "allowedPathPrefixes[0] must be a non-empty string" },
      { value: { objective: "o", claims: ["nope"] }, message: "claims[0] must be an object" },
      { value: { objective: "o", claims: [{ statement: "s", check: {} }] }, message: "claims[0].id must be a non-empty string" },
      { value: { objective: "o", claims: [{ id: "c", check: {} }] }, message: "claims[0].statement must be a non-empty string" },
      {
        value: { objective: "o", claims: [{ id: "c", statement: "s", check: { kind: "vibes", expectation: "present" } }] },
        message: "claims[0].check.kind is unsupported",
      },
      {
        value: { objective: "o", claims: [{ id: "c", statement: "s", check: { kind: "symbol-exists", symbol: "a", expectation: "maybe" } }] },
        message: "claims[0].check.expectation must be present or absent",
      },
      {
        value: { objective: "o", claims: [{ id: "c", statement: "s", check: { kind: "file-changed", expectation: "present" } }] },
        message: "claims[0].check.path must be a non-empty string",
      },
    ];
    for (const { value, message } of cases) {
      expect(() => parseValidationContract(value)).toThrow(message);
    }
  });

  it("accepts every supported check kind", () => {
    const contract = parseValidationContract({
      objective: "o",
      claims: [
        { id: "a", statement: "s", check: { kind: "symbol-exists", symbol: "x", expectation: "present" } },
        { id: "b", statement: "s", check: { kind: "callers", symbol: "x", expectation: "absent" } },
        { id: "c", statement: "s", check: { kind: "references", symbol: "x", expectation: "present" } },
        { id: "d", statement: "s", check: { kind: "text", text: "x", expectation: "absent" } },
        { id: "e", statement: "s", check: { kind: "file-changed", path: "src/x.ts", expectation: "present" } },
      ],
    });
    expect(contract.claims.map((claim) => claim.check.kind)).toEqual([
      "symbol-exists",
      "callers",
      "references",
      "text",
      "file-changed",
    ]);
  });

  it("builds an objective-only contract from a bare string", () => {
    expect(createValidationContract("  Fix the leak  ")).toEqual({
      objective: "Fix the leak",
      claims: [],
      allowedPathPrefixes: [],
    });
  });
});
