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

const SESSION_DIMENSIONS = ["pi.mode", "pi.repo.slug"];
/** Per-session summary distributions, recorded once at session end. */
export const SESSION_HISTOGRAMS: Readonly<
  Record<string, { unit: string; boundaries: number[]; dimensions: string[] }>
> = {
  "pi.session.cost": {
    unit: "USD",
    boundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100],
    dimensions: SESSION_DIMENSIONS,
  },
  "pi.session.tokens": {
    unit: "{token}",
    boundaries: [1e3, 1e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7],
    dimensions: SESSION_DIMENSIONS,
  },
  "pi.session.interactions": {
    unit: "{interaction}",
    boundaries: [0, 1, 2, 5, 10, 20, 50, 100, 200],
    dimensions: SESSION_DIMENSIONS,
  },
};
