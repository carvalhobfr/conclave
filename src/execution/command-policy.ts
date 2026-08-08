import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type {
  AllowedCommand,
  CapabilityDecision,
  ExecutionPermissions,
  TaskExecutionLimits,
} from "../domain/task-execution.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";

const APPROVAL_TOKEN = Symbol("conclave-command-approval");
const NODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export interface CommandPolicyOptions {
  readonly repositoryRoot: string;
  readonly permissions: ExecutionPermissions;
  readonly limits: TaskExecutionLimits;
  readonly allowedPackageScripts?: readonly string[];
}

export class ApprovedCommand {
  readonly #approvalToken: symbol;
  public readonly requestId: string;
  public readonly command: AllowedCommand;
  public readonly executable: string;
  public readonly args: readonly string[];
  public readonly cwd: string;
  public readonly timeoutMs: number;
  public readonly outputLimitBytes: number;
  public readonly environment: Readonly<Record<string, string>>;
  public readonly policyReason: string;

  public constructor(
    approvalToken: symbol,
    values: Omit<ApprovedCommand, "assertPolicyApproval" | "#approvalToken">,
  ) {
    if (approvalToken !== APPROVAL_TOKEN) throw new Error("Command was not approved by Conclave policy");
    this.#approvalToken = approvalToken;
    this.requestId = values.requestId;
    this.command = values.command;
    this.executable = values.executable;
    this.args = values.args;
    this.cwd = values.cwd;
    this.timeoutMs = values.timeoutMs;
    this.outputLimitBytes = values.outputLimitBytes;
    this.environment = values.environment;
    this.policyReason = values.policyReason;
  }

  public assertPolicyApproval(): void {
    if (this.#approvalToken !== APPROVAL_TOKEN) throw new Error("Invalid command policy approval");
  }
}

export interface CommandAuthorization {
  readonly decision: CapabilityDecision;
  readonly approved?: ApprovedCommand;
}

function childEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    CI: "true",
    NO_COLOR: "1",
  };
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function decision(
  requestId: string,
  outcome: CapabilityDecision["outcome"],
  reason: string,
): CapabilityDecision {
  return {
    requestId,
    capability: "run-command",
    outcome,
    reason,
    decidedAt: new Date().toISOString(),
  };
}

function commandKind(command: AllowedCommand): string {
  return (command as { readonly kind?: unknown }).kind as string;
}

export class CommandPolicy {
  readonly #root: string;
  readonly #permissions: ExecutionPermissions;
  readonly #limits: TaskExecutionLimits;
  readonly #allowedPackageScripts: ReadonlySet<string>;

  private constructor(options: CommandPolicyOptions, root: string) {
    this.#root = root;
    this.#permissions = options.permissions;
    this.#limits = options.limits;
    this.#allowedPackageScripts = new Set(options.allowedPackageScripts ?? []);
  }

  public static async create(options: CommandPolicyOptions): Promise<CommandPolicy> {
    return new CommandPolicy(options, await resolveRepositoryRoot(options.repositoryRoot));
  }

  public async authorize(requestId: string, command: AllowedCommand): Promise<CommandAuthorization> {
    if (!this.#permissions.allowCommands) {
      return { decision: decision(requestId, "rejected", "Command execution permission is disabled") };
    }
    switch (commandKind(command)) {
      case "node-syntax": {
        const typed = command as Extract<AllowedCommand, { kind: "node-syntax" }>;
        const path = await this.#validatedJavaScriptPath(typed.path).catch(() => undefined);
        if (path === undefined) {
          return { decision: decision(requestId, "rejected", "Node syntax target is outside policy") };
        }
        return this.#approved(requestId, command, process.execPath, ["--check", path], "Static Node syntax check");
      }
      case "node-test": {
        const typed = command as Extract<AllowedCommand, { kind: "node-test" }>;
        if (!this.#permissions.allowRepositoryScripts) {
          return { decision: decision(requestId, "rejected", "Repository code execution permission is disabled") };
        }
        if (!this.#permissions.allowNetwork) {
          return {
            decision: decision(
              requestId,
              "rejected",
              "Repository code is not executed without explicit network permission because portable network isolation is unavailable",
            ),
          };
        }
        const path = await this.#validatedJavaScriptPath(typed.path).catch(() => undefined);
        if (path === undefined) {
          return { decision: decision(requestId, "rejected", "Node test target is outside policy") };
        }
        return this.#approved(requestId, command, process.execPath, ["--test", path], "Explicit repository test permission");
      }
      case "package-script": {
        const typed = command as Extract<AllowedCommand, { kind: "package-script" }>;
        if (!this.#permissions.allowRepositoryScripts) {
          return { decision: decision(requestId, "rejected", "Repository script permission is disabled") };
        }
        if (!this.#permissions.allowNetwork) {
          return {
            decision: decision(
              requestId,
              "rejected",
              "Repository scripts are denied without network permission because portable network isolation is unavailable",
            ),
          };
        }
        if (!this.#allowedPackageScripts.has(typed.name)) {
          return { decision: decision(requestId, "rejected", "Package script is not in the host allowlist") };
        }
        if (!(await this.#manifestContainsScript(typed.name))) {
          return { decision: decision(requestId, "rejected", "Package script does not exist in package.json") };
        }
        return this.#approved(
          requestId,
          command,
          "npm",
          ["run", "--ignore-scripts", "--silent", typed.name],
          "Explicit allowlisted package script permission with lifecycle hooks disabled",
        );
      }
      default:
        return { decision: decision(requestId, "rejected", "Unknown command capability") };
    }
  }

  #approved(
    requestId: string,
    command: AllowedCommand,
    executable: string,
    args: readonly string[],
    reason: string,
  ): CommandAuthorization {
    const allowed = decision(requestId, "allowed", reason);
    return {
      decision: allowed,
      approved: new ApprovedCommand(APPROVAL_TOKEN, {
        requestId,
        command,
        executable,
        args,
        cwd: this.#root,
        timeoutMs: this.#limits.maxCommandDurationMs,
        outputLimitBytes: this.#limits.maxCommandOutputBytes,
        environment: childEnvironment(),
        policyReason: reason,
      }),
    };
  }

  async #validatedJavaScriptPath(path: string): Promise<string> {
    if (path.trim() === "" || path.includes("\0")) throw new Error("Invalid path");
    const candidate = resolve(this.#root, path);
    if (!isPathInside(this.#root, candidate) || !NODE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
      throw new Error("Path is outside command policy");
    }
    const stats = await lstat(candidate);
    if (!stats.isFile()) throw new Error("Command target is not a regular file");
    const canonical = await realpath(candidate);
    if (!isPathInside(this.#root, canonical)) throw new Error("Command target escapes repository");
    return canonical;
  }

  async #manifestContainsScript(name: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolve(this.#root, "package.json"), "utf8"));
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const scripts = (parsed as Record<string, unknown>)["scripts"];
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      !Array.isArray(scripts) &&
      typeof (scripts as Record<string, unknown>)[name] === "string"
    );
  }
}
