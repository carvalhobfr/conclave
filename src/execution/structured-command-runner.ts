import { spawn } from "node:child_process";

import type { CheckResult } from "../domain/task-execution.js";
import type { ApprovedCommand } from "./command-policy.js";

function appendBounded(
  current: string,
  chunk: Buffer,
  remainingBytes: number,
): { readonly text: string; readonly consumed: number; readonly truncated: boolean } {
  if (remainingBytes <= 0) return { text: current, consumed: 0, truncated: chunk.length > 0 };
  const selected = chunk.subarray(0, remainingBytes);
  return {
    text: current + selected.toString("utf8"),
    consumed: selected.length,
    truncated: selected.length < chunk.length,
  };
}

export class StructuredCommandRunner {
  public run(approved: ApprovedCommand, signal?: AbortSignal): Promise<CheckResult> {
    approved.assertPolicyApproval();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const child = spawn(approved.executable, [...approved.args], {
        cwd: approved.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...approved.environment },
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let cancelled = false;
      const stop = (): void => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        } else {
          child.kill("SIGKILL");
        }
      };
      const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const appended = appendBounded(
          target === "stdout" ? stdout : stderr,
          chunk,
          approved.outputLimitBytes - outputBytes,
        );
        if (target === "stdout") stdout = appended.text;
        else stderr = appended.text;
        outputBytes += appended.consumed;
        outputTruncated ||= appended.truncated;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        capture("stdout", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture("stderr", chunk);
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, approved.timeoutMs);
      const abort = (): void => {
        cancelled = true;
        stop();
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (cancelled) {
          reject(signal?.reason instanceof Error ? signal.reason : new Error("Command cancelled"));
          return;
        }
        resolve({
          requestId: approved.requestId,
          command: approved.command,
          status: timedOut ? "timed-out" : code === 0 ? "passed" : "failed",
          ...(code === null ? {} : { exitCode: code }),
          stdout,
          stderr,
          outputTruncated,
          durationMs: Math.max(0, performance.now() - started),
          policyReason: approved.policyReason,
        });
      });
    });
  }
}
