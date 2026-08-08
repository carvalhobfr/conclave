import type { ContentFinding, ContentSafetyAssessment } from "../domain/security.js";

interface DetectionPattern {
  readonly expression: RegExp;
  readonly kind: ContentFinding["kind"];
  readonly severity: ContentFinding["severity"];
  readonly description: string;
}

const DETECTION_PATTERNS: readonly DetectionPattern[] = [
  {
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    kind: "private-key",
    severity: "block",
    description: "Private key material detected",
  },
  {
    expression: /\bAKIA[0-9A-Z]{16}\b/,
    kind: "credential",
    severity: "block",
    description: "AWS access key identifier detected",
  },
  {
    expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    kind: "credential",
    severity: "block",
    description: "GitHub token-like value detected",
  },
  {
    expression: /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/,
    kind: "credential",
    severity: "block",
    description: "API key-like value detected",
  },
  {
    expression:
      /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*(?:["'][A-Za-z0-9_./+=-]{12,}["']|[A-Za-z0-9_+/=-]{20,})/i,
    kind: "credential",
    severity: "block",
    description: "Credential assignment detected",
  },
  {
    expression: /(?:ignore|disregard) (?:all |any )?(?:previous|prior|system) instructions/i,
    kind: "prompt-injection",
    severity: "warning",
    description: "Instruction-like repository content detected",
  },
  {
    expression: /(?:reveal|print|return) (?:the )?(?:system prompt|developer message|hidden instructions)/i,
    kind: "prompt-injection",
    severity: "warning",
    description: "Prompt-exfiltration instruction detected",
  },
];

function findLine(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

export function assessRepositoryContent(content: string): ContentSafetyAssessment {
  const findings: ContentFinding[] = [];

  for (const pattern of DETECTION_PATTERNS) {
    const match = pattern.expression.exec(content);
    if (match?.index !== undefined) {
      findings.push({
        kind: pattern.kind,
        severity: pattern.severity,
        line: findLine(content, match.index),
        description: pattern.description,
      });
    }
  }

  return {
    externalTransmissionAllowed: findings.every((finding) => finding.severity !== "block"),
    findings,
  };
}
