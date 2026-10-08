import { BUILD_INFO } from "../../build-info.ts";
import { createHarnessEnvironment, type EnvironmentOverrides } from "../../launcher/environment.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { AxonPaths } from "../../product/paths.ts";

const PI_PROCESS_OVERRIDES = Object.freeze({
  PI_SKIP_VERSION_CHECK: "1",
  PI_AXON_CLI_VERSION: BUILD_INFO.version,
  // PI_* markers survive the launcher's final Axon-control-variable filter.
  PI_AXON_BACKUP_SERVICE_ORIGIN: BUILD_INFO.serviceOrigin,
  PI_MODEL_RECOMMENDER_URL: new URL(
    "/api/v1/model-recommendations",
    BUILD_INFO.serviceOrigin,
  ).toString(),
}) satisfies EnvironmentOverrides;

/**
 * Provider credentials documented by Pi (docs/providers.md) that are removed
 * from every Axon-launched Pi process, so ambient personal keys never
 * select a provider implicitly. LiteLLM variables are intentionally kept: the
 * pinned `pi-provider-litellm` package is the organization's provider path.
 * Cloud SDK configuration (AWS_*, GOOGLE_APPLICATION_CREDENTIALS, Cloudflare
 * account identifiers) and proxy variables are general-purpose and also kept.
 */
export const PI_STRIPPED_PROVIDER_VARIABLES: readonly string[] = Object.freeze([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  // Pi recognizes this provider key; keep stripping it even without an OpenCode harness.
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]);

const PI_PROVIDER_CREDENTIAL_REMOVALS: EnvironmentOverrides = Object.freeze(
  Object.fromEntries(PI_STRIPPED_PROVIDER_VARIABLES.map((name) => [name, undefined])),
);

function createPiDirectoryOverrides(paths: AxonPaths): EnvironmentOverrides {
  return Object.freeze({
    PI_CODING_AGENT_DIR: paths.pi,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    PI_AXON_BACKUP_HOME: paths.home,
  });
}

export function createPiEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  paths: AxonPaths,
  ...additionalOverrides: readonly EnvironmentOverrides[]
): NodeJS.ProcessEnv {
  return createHarnessEnvironment(
    inheritedEnvironment,
    createPiDirectoryOverrides(paths),
    PI_PROCESS_OVERRIDES,
    {
      // The provider extension gives settings.json displayName precedence.
      // Preserve explicit env values; brand only an otherwise unconfigured label.
      LITELLM_DISPLAY_NAME:
        inheritedEnvironment["LITELLM_DISPLAY_NAME"] ??
        `${PRODUCT_IDENTITY.displayName} AI Gateway`,
    },
    PI_PROVIDER_CREDENTIAL_REMOVALS,
    ...additionalOverrides,
  );
}
