import type {
  AllowedCommand,
  CapabilityRequest,
  ImplementerResult,
  ImplementationClaim,
  ImplementationPlan,
  ProposedFilePatch,
  ReviewFinding,
  ReviewResult,
  TaskConstraint,
  TaskRequirement,
  TaskVerificationStrategy,
} from "../domain/task-execution.js";
import { parseRetrievalRequest, StructuredOutputError } from "../reasoning/structured-outputs.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StructuredOutputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new StructuredOutputError(`${label} contains unsupported field: ${unexpected}`);
}

function text(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new StructuredOutputError(`${label} must be a non-empty string up to ${String(max)} characters`);
  }
  return value.trim();
}

function rawText(value: unknown, label: string, max: number, allowEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value === "") ||
    value.length > max
  ) {
    throw new StructuredOutputError(`${label} must be a string up to ${String(max)} characters`);
  }
  return value;
}

function array(value: unknown, label: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new StructuredOutputError(`${label} must be an array with at most ${String(max)} entries`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new StructuredOutputError(`${label} has an unsupported value`);
  }
  return value as T;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 120);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new StructuredOutputError(`${label} is invalid`);
  return result;
}

function path(value: unknown, label: string): string {
  const result = text(value, label, 500);
  if (result.startsWith("/") || result.startsWith("../") || result.includes("\\") || result.includes("\0")) {
    throw new StructuredOutputError(`${label} is not repository-relative`);
  }
  return result;
}

function ids(value: unknown, label: string, allowed?: ReadonlySet<string>): readonly string[] {
  const result = [...new Set(array(value, label, 30).map((item) => identifier(item, label)))];
  if (allowed !== undefined) {
    const unknown = result.find((id) => !allowed.has(id));
    if (unknown !== undefined) throw new StructuredOutputError(`${label} references unknown id: ${unknown}`);
  }
  return result;
}

function paths(value: unknown, label: string, allowed?: ReadonlySet<string>): readonly string[] {
  const result = [...new Set(array(value, label, 30).map((item) => path(item, label)))];
  if (allowed !== undefined) {
    const unknown = result.find((item) => !allowed.has(item));
    if (unknown !== undefined) throw new StructuredOutputError(`${label} references unknown path: ${unknown}`);
  }
  return result;
}

const EXPECTATIONS = new Set(["present", "absent"] as const);

function verification(
  value: unknown,
  allowedPaths?: ReadonlySet<string>,
): TaskVerificationStrategy {
  const parsed = record(value, "Verification strategy");
  const kind = text(parsed["kind"], "Verification kind", 100);
  switch (kind) {
    case "source-contains": {
      keys(parsed, ["kind", "path", "text", "expectation"], "Source verification");
      const target = path(parsed["path"], "Verification path");
      if (allowedPaths !== undefined && !allowedPaths.has(target)) {
        throw new StructuredOutputError(`Verification references unknown path: ${target}`);
      }
      return {
        kind,
        path: target,
        text: text(parsed["text"], "Verification text", 2_000),
        expectation: enumValue(parsed["expectation"], EXPECTATIONS, "Verification expectation"),
      };
    }
    case "symbol-exists": {
      keys(parsed, ["kind", "symbol", "path", "expectation"], "Symbol verification");
      const target = parsed["path"] === undefined ? undefined : path(parsed["path"], "Verification path");
      if (target !== undefined && allowedPaths !== undefined && !allowedPaths.has(target)) {
        throw new StructuredOutputError(`Verification references unknown path: ${target}`);
      }
      return {
        kind,
        symbol: text(parsed["symbol"], "Verification symbol", 300),
        ...(target === undefined ? {} : { path: target }),
        expectation: enumValue(parsed["expectation"], EXPECTATIONS, "Verification expectation"),
      };
    }
    case "graph-path": {
      keys(parsed, ["kind", "from", "to", "maxDepth", "expectation"], "Graph path verification");
      const maxDepth = parsed["maxDepth"];
      if (
        maxDepth !== undefined &&
        (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 10)
      ) {
        throw new StructuredOutputError("Verification maxDepth must be between 1 and 10");
      }
      return {
        kind,
        from: text(parsed["from"], "Path source", 300),
        to: text(parsed["to"], "Path target", 300),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        expectation: enumValue(parsed["expectation"], EXPECTATIONS, "Verification expectation"),
      };
    }
    case "callers": {
      keys(parsed, ["kind", "symbol", "minimum"], "Caller verification");
      const minimum = parsed["minimum"];
      if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 0 || minimum > 100) {
        throw new StructuredOutputError("Caller minimum must be an integer between 0 and 100");
      }
      return { kind, symbol: text(parsed["symbol"], "Caller symbol", 300), minimum };
    }
    case "changed-file": {
      keys(parsed, ["kind", "path", "expectation"], "Changed-file verification");
      return {
        kind,
        path: path(parsed["path"], "Changed file path"),
        expectation: enumValue(
          parsed["expectation"],
          new Set(["changed", "unchanged"] as const),
          "Changed-file expectation",
        ),
      };
    }
    case "check-passed":
      keys(parsed, ["kind", "requestId"], "Check verification");
      return { kind, requestId: identifier(parsed["requestId"], "Check requestId") };
    default:
      throw new StructuredOutputError(`Unknown verification strategy: ${kind}`);
  }
}

export function parseImplementationPlan(
  raw: string,
  allowedClaimIds: ReadonlySet<string>,
  allowedEvidenceIds: ReadonlySet<string>,
  allowedPaths: ReadonlySet<string>,
): ImplementationPlan {
  const parsed = record(JSON.parse(raw) as unknown, "Implementation plan");
  keys(parsed, ["id", "summary", "requirements", "constraints", "steps", "evidenceIds"], "Implementation plan");
  const requirements = array(parsed["requirements"], "Plan requirements", 20).map((item): TaskRequirement => {
    const requirement = record(item, "Requirement");
    keys(requirement, ["id", "statement", "required", "verification"], "Requirement");
    if (typeof requirement["required"] !== "boolean") {
      throw new StructuredOutputError("Requirement required must be boolean");
    }
    return {
      id: identifier(requirement["id"], "Requirement id"),
      statement: text(requirement["statement"], "Requirement statement"),
      required: requirement["required"],
      verification: verification(requirement["verification"], allowedPaths),
    };
  });
  const requirementIds = new Set(requirements.map((item) => item.id));
  if (requirementIds.size !== requirements.length || requirements.length === 0) {
    throw new StructuredOutputError("Plan requires unique requirements");
  }
  const constraints = array(parsed["constraints"], "Plan constraints", 20).map((item): TaskConstraint => {
    const constraint = record(item, "Constraint");
    keys(constraint, ["id", "statement", "kind"], "Constraint");
    return {
      id: identifier(constraint["id"], "Constraint id"),
      statement: text(constraint["statement"], "Constraint statement"),
      kind: enumValue(
        constraint["kind"],
        new Set(["scope", "compatibility", "security", "behavior"] as const),
        "Constraint kind",
      ),
    };
  });
  const steps = array(parsed["steps"], "Plan steps", 20).map((item) => {
    const step = record(item, "Implementation step");
    keys(
      step,
      ["id", "description", "targetFiles", "rationaleClaimIds", "requirementIds", "expectedOutcome"],
      "Implementation step",
    );
    return {
      id: identifier(step["id"], "Step id"),
      description: text(step["description"], "Step description"),
      targetFiles: paths(step["targetFiles"], "Step targetFiles", allowedPaths),
      rationaleClaimIds: ids(step["rationaleClaimIds"], "Step rationaleClaimIds", allowedClaimIds),
      requirementIds: ids(step["requirementIds"], "Step requirementIds", requirementIds),
      expectedOutcome: text(step["expectedOutcome"], "Step expectedOutcome"),
    };
  });
  if (steps.length === 0 || steps.some((step) => step.rationaleClaimIds.length === 0)) {
    throw new StructuredOutputError("Every implementation step requires supported diagnosis rationale");
  }
  return {
    id: identifier(parsed["id"], "Plan id"),
    summary: text(parsed["summary"], "Plan summary"),
    requirements,
    constraints,
    steps,
    evidenceIds: ids(parsed["evidenceIds"], "Plan evidenceIds", allowedEvidenceIds),
  };
}

function parseCommand(value: unknown): AllowedCommand {
  const parsed = record(value, "Allowed command");
  switch (parsed["kind"]) {
    case "node-syntax":
    case "node-test":
      keys(parsed, ["kind", "path"], "Node command");
      return { kind: parsed["kind"], path: path(parsed["path"], "Command path") };
    case "package-script":
      keys(parsed, ["kind", "name"], "Package script command");
      return { kind: "package-script", name: identifier(parsed["name"], "Package script name") };
    default:
      throw new StructuredOutputError("Command capability kind is not allowed");
  }
}

function parsePatch(value: unknown, stepIds: ReadonlySet<string>): ProposedFilePatch {
  const parsed = record(value, "Proposed patch");
  keys(parsed, ["id", "implementationStepId", "path", "expectedHash", "replacements"], "Proposed patch");
  const implementationStepId = identifier(parsed["implementationStepId"], "Patch step id");
  if (!stepIds.has(implementationStepId)) throw new StructuredOutputError(`Patch references unknown step: ${implementationStepId}`);
  const expectedHash = text(parsed["expectedHash"], "Patch expectedHash", 64);
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new StructuredOutputError("Patch expectedHash must be SHA-256");
  const replacements = array(parsed["replacements"], "Patch replacements", 30).map((item) => {
    const replacement = record(item, "Patch replacement");
    keys(replacement, ["oldText", "newText", "expectedOccurrences"], "Patch replacement");
    const count = replacement["expectedOccurrences"];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100) {
      throw new StructuredOutputError("Replacement expectedOccurrences must be between 1 and 100");
    }
    return {
      oldText: rawText(replacement["oldText"], "Replacement oldText", 20_000, false),
      newText: rawText(replacement["newText"], "Replacement newText", 20_000, true),
      expectedOccurrences: count,
    };
  });
  if (replacements.length === 0) throw new StructuredOutputError("Patch requires replacements");
  return {
    id: identifier(parsed["id"], "Patch id"),
    implementationStepId,
    path: path(parsed["path"], "Patch path"),
    expectedHash,
    replacements,
  };
}

function parseCapability(
  value: unknown,
  patchIds: ReadonlySet<string>,
): CapabilityRequest {
  const parsed = record(value, "Capability request");
  const id = identifier(parsed["id"], "Capability id");
  const reason = text(parsed["reason"], "Capability reason", 1_000);
  switch (parsed["kind"]) {
    case "apply-patches":
      keys(parsed, ["id", "kind", "patchIds", "reason"], "Patch capability");
      return { id, kind: "apply-patches", patchIds: ids(parsed["patchIds"], "Capability patchIds", patchIds), reason };
    case "run-command":
      keys(parsed, ["id", "kind", "command", "reason"], "Command capability");
      return { id, kind: "run-command", command: parseCommand(parsed["command"]), reason };
    case "read-file":
      keys(parsed, ["id", "kind", "path", "reason"], "Read capability");
      return { id, kind: "read-file", path: path(parsed["path"], "Read path"), reason };
    case "retrieve":
      keys(parsed, ["id", "kind", "request", "reason"], "Retrieval capability");
      return { id, kind: "retrieve", request: parseRetrievalRequest(parsed["request"]), reason };
    default:
      throw new StructuredOutputError("Unknown execution capability");
  }
}

export function parseImplementerResult(
  raw: string,
  plan: ImplementationPlan,
  allowedEvidenceIds: ReadonlySet<string>,
  allowedPaths: ReadonlySet<string>,
): ImplementerResult {
  const parsed = record(JSON.parse(raw) as unknown, "Implementer result");
  keys(parsed, ["summary", "patches", "claims", "capabilityRequests"], "Implementer result");
  const stepIds = new Set(plan.steps.map((step) => step.id));
  const requirementIds = new Set(plan.requirements.map((requirement) => requirement.id));
  const patches = array(parsed["patches"], "Patches", 30).map((item) => parsePatch(item, stepIds));
  const patchIds = new Set(patches.map((patch) => patch.id));
  if (patchIds.size !== patches.length) throw new StructuredOutputError("Patch IDs must be unique");
  const claims = array(parsed["claims"], "Implementation claims", 30).map((item): ImplementationClaim => {
    const claim = record(item, "Implementation claim");
    keys(claim, ["id", "statement", "requirementIds", "evidenceIds", "verification"], "Implementation claim");
    return {
      id: identifier(claim["id"], "Implementation claim id"),
      statement: text(claim["statement"], "Implementation claim statement"),
      requirementIds: ids(claim["requirementIds"], "Claim requirementIds", requirementIds),
      evidenceIds: ids(claim["evidenceIds"], "Claim evidenceIds", allowedEvidenceIds),
      verification: verification(claim["verification"], allowedPaths),
    };
  });
  return {
    summary: text(parsed["summary"], "Implementer summary"),
    patches,
    claims,
    capabilityRequests: array(parsed["capabilityRequests"], "Capability requests", 30).map((item) =>
      parseCapability(item, patchIds),
    ),
  };
}

export function parseReviewResult(
  raw: string,
  requirementIds: ReadonlySet<string>,
  allowedPaths: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
): ReviewResult {
  const parsed = record(JSON.parse(raw) as unknown, "Review result");
  keys(parsed, ["status", "summary", "findings"], "Review result");
  const findings = array(parsed["findings"], "Review findings", 30).map((item): ReviewFinding => {
    const finding = record(item, "Review finding");
    keys(finding, ["id", "type", "severity", "statement", "requirementIds", "paths", "evidenceIds"], "Review finding");
    return {
      id: identifier(finding["id"], "Finding id"),
      type: enumValue(
        finding["type"],
        new Set([
          "requirement-gap",
          "unrelated-change",
          "regression-risk",
          "architecture",
          "security",
          "failed-check",
          "unsupported-claim",
        ] as const),
        "Finding type",
      ),
      severity: enumValue(
        finding["severity"],
        new Set(["info", "warning", "blocking"] as const),
        "Finding severity",
      ),
      statement: text(finding["statement"], "Finding statement"),
      requirementIds: ids(finding["requirementIds"], "Finding requirementIds", requirementIds),
      paths: paths(finding["paths"], "Finding paths", allowedPaths),
      evidenceIds: ids(finding["evidenceIds"], "Finding evidenceIds", evidenceIds),
    };
  });
  return {
    status: enumValue(
      parsed["status"],
      new Set(["approved", "revision-required", "uncertain"] as const),
      "Review status",
    ),
    summary: text(parsed["summary"], "Review summary"),
    findings,
  };
}
