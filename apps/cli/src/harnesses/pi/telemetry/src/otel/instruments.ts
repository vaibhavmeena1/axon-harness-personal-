/** GenAI semantic conventions development v1.44.0. Fixed, bounded instruments. */
export const CLIENT_DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];
export const AGENT_DURATION_BUCKETS = [
  0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
];
export const CALL_COUNT_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128];
const CLIENT_DIMENSIONS = [
  "pi.mode",
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "error.type",
];
const TOOL_DIMENSIONS = ["pi.mode", "gen_ai.operation.name", "gen_ai.tool.name", "error.type"];
const AGENT_DIMENSIONS = ["pi.mode", "gen_ai.operation.name", "gen_ai.agent.name", "error.type"];
export const GEN_AI_HISTOGRAMS: Readonly<
  Record<string, { unit: string; boundaries: number[]; dimensions: string[] }>
> = {
  "gen_ai.client.operation.duration": {
    unit: "s",
    boundaries: CLIENT_DURATION_BUCKETS,
    dimensions: CLIENT_DIMENSIONS,
  },
  "gen_ai.execute_tool.duration": {
    unit: "s",
    boundaries: CLIENT_DURATION_BUCKETS,
    dimensions: TOOL_DIMENSIONS,
  },
  "gen_ai.invoke_agent.duration": {
    unit: "s",
    boundaries: AGENT_DURATION_BUCKETS,
    dimensions: AGENT_DIMENSIONS,
  },
  "gen_ai.invoke_agent.inference_calls": {
    unit: "{inference_call}",
    boundaries: CALL_COUNT_BUCKETS,
    dimensions: AGENT_DIMENSIONS,
  },
  "gen_ai.invoke_agent.tool_calls": {
    unit: "{tool_call}",
    boundaries: CALL_COUNT_BUCKETS,
    dimensions: AGENT_DIMENSIONS,
  },
};
