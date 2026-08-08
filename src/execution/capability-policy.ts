import type {
  CapabilityDecision,
  CapabilityRequest,
  ExecutionPermissions,
} from "../domain/task-execution.js";
import type { CommandPolicy, CommandAuthorization } from "./command-policy.js";

export interface CapabilityPolicyContext {
  readonly knownPatchIds: ReadonlySet<string>;
  readonly allowedReadPaths: ReadonlySet<string>;
  readonly retrievalRequestsRemaining: number;
}

export interface CapabilityAuthorization {
  readonly decision: CapabilityDecision;
  readonly commandAuthorization?: CommandAuthorization;
}

function result(
  request: CapabilityRequest,
  outcome: CapabilityDecision["outcome"],
  reason: string,
): CapabilityAuthorization {
  return {
    decision: {
      requestId: request.id,
      capability: request.kind,
      outcome,
      reason,
      decidedAt: new Date().toISOString(),
    },
  };
}

export class ExecutionCapabilityPolicy {
  readonly #permissions: ExecutionPermissions;
  readonly #commandPolicy: CommandPolicy;

  public constructor(permissions: ExecutionPermissions, commandPolicy: CommandPolicy) {
    this.#permissions = permissions;
    this.#commandPolicy = commandPolicy;
  }

  public async authorize(
    request: CapabilityRequest,
    context: CapabilityPolicyContext,
  ): Promise<CapabilityAuthorization> {
    switch (request.kind) {
      case "apply-patches":
        if (!this.#permissions.allowFileEdits) {
          return result(request, "rejected", "File edit permission is disabled");
        }
        if (
          request.patchIds.length === 0 ||
          request.patchIds.some((patchId) => !context.knownPatchIds.has(patchId))
        ) {
          return result(request, "rejected", "Patch capability references unknown patches");
        }
        return result(request, "allowed", "All patch IDs are known and file edits are permitted");
      case "run-command": {
        const commandAuthorization = await this.#commandPolicy.authorize(request.id, request.command);
        return {
          decision: commandAuthorization.decision,
          ...(commandAuthorization.approved === undefined ? {} : { commandAuthorization }),
        };
      }
      case "read-file":
        return context.allowedReadPaths.has(request.path)
          ? result(request, "allowed", "Read path is within the verified implementation scope")
          : result(request, "rejected", "Read path is outside the verified implementation scope");
      case "retrieve":
        return context.retrievalRequestsRemaining > 0
          ? result(request, "allowed", "Bounded retrieval capability is available")
          : result(request, "rejected", "Follow-up retrieval budget is exhausted");
    }
  }
}
