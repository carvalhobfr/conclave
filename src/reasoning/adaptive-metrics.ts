import type { AnalysisDepth } from "../domain/adaptive-reasoning.js";
import type { ReasoningResult } from "../domain/reasoning.js";

export interface DepthMetricsSummary {
  readonly depth: AnalysisDepth;
  readonly samples: number;
  readonly meanModelCalls: number;
  readonly medianModelCalls: number;
  readonly meanInputTokens: number;
  readonly medianInputTokens: number;
}

export interface AdaptiveMetricsSummary {
  readonly totalRuns: number;
  readonly byRequestedDepth: readonly DepthMetricsSummary[];
  readonly cancellationRate: number;
  readonly earlyExitRate: number;
  readonly deterministicAnswerRate: number;
  readonly conductorInvocationRate: number;
}

interface Sample {
  readonly requestedDepth: AnalysisDepth;
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly cancelled: boolean;
  readonly earlyExit: boolean;
  readonly deterministicAnswer: boolean;
  readonly conductorInvoked: boolean;
}

const DEPTHS: readonly AnalysisDepth[] = ["auto", "fast", "balanced", "deep"];

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function rate(samples: readonly Sample[], select: (sample: Sample) => boolean): number {
  return samples.length === 0 ? 0 : samples.filter(select).length / samples.length;
}

/** Process-local aggregate only. It performs no external analytics or persistence. */
export class AdaptiveMetricsAccumulator {
  readonly #samples: Sample[] = [];

  public record(result: ReasoningResult): void {
    this.#samples.push({
      requestedDepth: result.analysis.requestedDepth,
      modelCalls: result.metrics.modelCalls,
      inputTokens: result.metrics.approximateInputTokens,
      cancelled: result.terminationReason === "cancelled",
      earlyExit: result.metrics.earlyExit,
      deterministicAnswer: result.metrics.deterministicAnswer,
      conductorInvoked: result.metrics.conductorInvoked,
    });
  }

  public summary(): AdaptiveMetricsSummary {
    return {
      totalRuns: this.#samples.length,
      byRequestedDepth: DEPTHS.map((depth) => {
        const samples = this.#samples.filter((sample) => sample.requestedDepth === depth);
        return {
          depth,
          samples: samples.length,
          meanModelCalls: mean(samples.map((sample) => sample.modelCalls)),
          medianModelCalls: median(samples.map((sample) => sample.modelCalls)),
          meanInputTokens: mean(samples.map((sample) => sample.inputTokens)),
          medianInputTokens: median(samples.map((sample) => sample.inputTokens)),
        };
      }),
      cancellationRate: rate(this.#samples, (sample) => sample.cancelled),
      earlyExitRate: rate(this.#samples, (sample) => sample.earlyExit),
      deterministicAnswerRate: rate(this.#samples, (sample) => sample.deterministicAnswer),
      conductorInvocationRate: rate(this.#samples, (sample) => sample.conductorInvoked),
    };
  }
}
