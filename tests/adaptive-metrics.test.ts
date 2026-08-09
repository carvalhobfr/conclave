import { describe, expect, it } from "vitest";

import { AdaptiveMetricsAccumulator } from "../src/reasoning/adaptive-metrics.js";
import { createReasoningFixtureEngine } from "./helpers/reasoning-fixture.js";

describe("local adaptive metrics", () => {
  it("aggregates requested-depth cost and routing rates without external telemetry", async () => {
    const metrics = new AdaptiveMetricsAccumulator();
    const engine = await createReasoningFixtureEngine();
    metrics.record(await engine.ask("Where is bootstrapSession called?", "conclave", { depth: "auto", intent: "ask" }));
    metrics.record(await engine.ask("Where do we persist the login token?", "conclave", { depth: "fast", intent: "ask" }));

    const summary = metrics.summary();
    expect(summary.totalRuns).toBe(2);
    expect(summary.byRequestedDepth.find((item) => item.depth === "auto")).toMatchObject({ samples: 1, meanModelCalls: 0, medianInputTokens: 0 });
    expect(summary.byRequestedDepth.find((item) => item.depth === "fast")?.meanModelCalls).toBe(1);
    expect(summary.deterministicAnswerRate).toBe(0.5);
    expect(summary.earlyExitRate).toBe(1);
    expect(summary.conductorInvocationRate).toBe(0);
  });
});
