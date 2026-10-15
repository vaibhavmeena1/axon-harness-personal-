import type {
  CompactionConfig,
  LiteLLMClientConfig,
  ModelRecommenderConfig,
} from "../../cli/client-config.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";

/** Launch-only, allowlisted preferences; missing values preserve the inherited environment. */
function preferenceOverrides<T extends object>(
  policy: T | undefined,
  variables: { readonly [K in keyof T]-?: string },
): EnvironmentOverrides {
  const overrides: Record<string, string> = {};
  for (const [field, variable] of Object.entries(variables) as [keyof T, string][]) {
    const value = policy?.[field];
    if (value != null) overrides[variable] = String(value);
  }
  return overrides;
}

export function createCompactionOverrides(policy?: CompactionConfig): EnvironmentOverrides {
  return preferenceOverrides(policy, {
    enabled: "PI_COMPACTION_ENABLED",
    model: "PI_COMPACTION_MODEL",
    thresholdTokens: "PI_COMPACTION_THRESHOLD_TOKENS",
    maxOutputTokens: "PI_COMPACTION_MAX_OUTPUT_TOKENS",
    timeoutMs: "PI_COMPACTION_TIMEOUT_MS",
  });
}

export function createModelRecommenderOverrides(
  policy?: ModelRecommenderConfig,
): EnvironmentOverrides {
  // The extension reads an inverted switch: ENABLED maps to PI_MODEL_RECOMMENDER_DISABLED.
  return preferenceOverrides(
    policy && { ...policy, enabled: policy.enabled == null ? undefined : !policy.enabled },
    {
      enabled: "PI_MODEL_RECOMMENDER_DISABLED",
      timeoutMs: "PI_MODEL_RECOMMENDER_TIMEOUT_MS",
      autoSelectMs: "PI_MODEL_RECOMMENDER_AUTO_SELECT_MS",
    },
  );
}

export function createLiteLLMClientOverrides(policy?: LiteLLMClientConfig): EnvironmentOverrides {
  return preferenceOverrides(policy, {
    discoveryTimeoutMs: "LITELLM_DISCOVERY_TIMEOUT_MS",
    defaultContextWindow: "LITELLM_DEFAULT_CONTEXT_WINDOW",
  });
}
