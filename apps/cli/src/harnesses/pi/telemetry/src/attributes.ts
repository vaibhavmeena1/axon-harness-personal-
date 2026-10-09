export const EXTENSION_NAME = "pi-org-telemetry";
export const INSTRUMENTATION_NAME = "pi-org-telemetry";

export const ATTR_USER_ID = "user.id";
export const ATTR_USER_EMAIL = "user.email";
export const ATTR_IDENTITY_SOURCE = "pi.identity.source";
export const ATTR_SESSION_ID = "session.id";
export const ATTR_PARENT_SESSION_ID = "pi.session.parent_id";
export const ATTR_CONVERSATION_ID = "gen_ai.conversation.id";
export const ATTR_PROJECT = "pi.project.name";
export const ATTR_REPO_SLUG = "pi.repo.slug";
export const ATTR_MODE = "pi.mode";
export const ATTR_PI_VERSION = "pi.version";
export const ATTR_OS_TYPE = "os.type";
export const ATTR_HOST_ARCH = "host.arch";
export const ATTR_RUNTIME_NAME = "process.runtime.name";
export const ATTR_RUNTIME_VERSION = "process.runtime.version";
export const ATTR_TERMINAL_TYPE = "terminal.type";

export const ATTR_OPERATION = "gen_ai.operation.name";
export const ATTR_PROVIDER = "gen_ai.provider.name";
export const ATTR_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_PROVIDER_REQUEST_ID = "pi.provider.request_id";
export const ATTR_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_CACHE_READ_TOKENS = "gen_ai.usage.cache_read.input_tokens";
export const ATTR_CACHE_WRITE_TOKENS = "gen_ai.usage.cache_write.input_tokens";
export const ATTR_REASONING_TOKENS = "gen_ai.usage.reasoning.output_tokens";
export const ATTR_COST = "pi.cost.usd";
export const ATTR_COST_INPUT = "pi.cost.input_usd";
export const ATTR_COST_OUTPUT = "pi.cost.output_usd";
export const ATTR_COST_CACHE_READ = "pi.cost.cache_read_usd";
export const ATTR_COST_CACHE_WRITE = "pi.cost.cache_write_usd";
export const ATTR_USAGE_SOURCE = "pi.usage.source";
export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_TOOL_SOURCE = "pi.tool.source";
export const ATTR_TOOL_SCOPE = "pi.tool.scope";
export const ATTR_TOOL_OUTPUT_SIZE = "pi.tool.output_size";
export const ATTR_TOOL_OUTPUT_IMAGES = "pi.tool.output_images";
export const ATTR_TOOL_TRUNCATED_CALL = "pi.tool.truncated_call";
export const ATTR_CONTEXT_TOKENS = "pi.context.tokens";
export const ATTR_CONTEXT_WINDOW = "pi.context.window";
export const ATTR_CONTEXT_PERCENT = "pi.context.percent";
export const ATTR_THINKING_LEVEL = "pi.thinking.level";
export const ATTR_PROVIDER_THINKING_LEVEL = "pi.thinking.provider_level";
export const ATTR_SESSION_COST = "pi.session.cost.usd";
export const ATTR_SESSION_INPUT_TOKENS = "pi.session.tokens.input";
export const ATTR_SESSION_OUTPUT_TOKENS = "pi.session.tokens.output";
export const ATTR_SESSION_CACHE_READ_TOKENS = "pi.session.tokens.cache_read";
export const ATTR_SESSION_CACHE_WRITE_TOKENS = "pi.session.tokens.cache_write";
export const ATTR_SESSION_REASONING_TOKENS = "pi.session.tokens.reasoning";
export const ATTR_SESSION_INTERACTIONS = "pi.session.interactions";
export const ATTR_SESSION_LLM_REQUESTS = "pi.session.llm_requests";
export const ATTR_SESSION_TOOL_CALLS = "pi.session.tool_calls";
export const ATTR_SESSION_DURATION = "pi.session.duration_s";
export const ATTR_LLM_TRUNCATED = "pi.llm.truncated";

export const SPAN_INTERACTION = "invoke_agent pi";
export const SPAN_AGENT_RUN = "pi.agent.run";
export const SPAN_TURN = "pi.turn";
export const SPAN_LLM = "chat";
export const SPAN_TOOL = "execute_tool";
export const SPAN_USER_WAIT = "pi.user.wait";
export const SPAN_COMPACTION = "pi.session.compaction";
export const SPAN_SESSION = "pi.session";

/** Units for counter instruments, keyed by metric name (UCUM). */
export const COUNTER_UNITS: Readonly<Record<string, string>> = {
  "pi.session.started": "{session}",
  "pi.session.ended": "{session}",
  "pi.user.input.count": "{input}",
  "pi.user.intervention.count": "{intervention}",
  "pi.interaction.count": "{interaction}",
  "pi.agent.run.count": "{run}",
  "pi.agent.run.repeated": "{run}",
  "pi.turn.count": "{turn}",
  "pi.llm.requests": "{request}",
  "pi.llm.errors": "{error}",
  "pi.llm.truncated": "{response}",
  "pi.tokens.input": "{token}",
  "pi.tokens.output": "{token}",
  "pi.tokens.cache_read": "{token}",
  "pi.tokens.cache_write": "{token}",
  "pi.tokens.reasoning": "{token}",
  "pi.cost": "USD",
  "pi.tool.calls": "{call}",
  "pi.tool.errors": "{error}",
  "pi.compaction.count": "{compaction}",
  "pi.telemetry.export_errors": "{error}",
  "pi.telemetry.dropped": "{record}",
};
