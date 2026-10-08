import { describe, expect, test } from "bun:test";

import { parseClientConfig, type WebSearchConfig } from "../src/cli/client-config.ts";
import { createWebSearchOverrides } from "../src/harnesses/pi/web-search-environment.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";

const relay = { origin: "http://127.0.0.1:12345", capability: "local-capability" };
const preferences: WebSearchConfig = {
  enabled: true,
  model: "gemini-3.8-flash",
  allowedModels: ["gemini-3.8-flash", "other-search-model"],
  timeoutMs: 60000,
  maxQueryCharacters: 20000,
  maxResultCharacters: 30000,
  maxOutputTokens: 8192,
  maxSources: 20,
  temperature: 1,
  thinkingLevel: "low",
  searchContextSize: "medium",
  useUrlContext: false,
  requireGrounding: true,
};

describe("standalone search client config", () => {
  test("validates all public preferences, including absent optional levels", () => {
    expect(parseClientConfig({ schemaVersion: 1, webSearch: preferences }).webSearch).toEqual(
      preferences,
    );
    const { thinkingLevel: _thinking, searchContextSize: _search, ...defaults } = preferences;
    expect(parseClientConfig({ schemaVersion: 1, webSearch: defaults }).webSearch).toEqual(
      defaults,
    );
  });
  for (const patch of [
    { endpoint: "https://evil.test" },
    { apiKey: "secret" },
    { headers: {} },
    { thinkingLevel: "auto" },
    { searchContextSize: "huge" },
    { temperature: Infinity },
    { useUrlContext: "true" },
    { requireGrounding: 1 },
    { timeoutMs: 300001 },
  ]) {
    test(`rejects private, unsafe or invalid config ${JSON.stringify(patch)}`, () => {
      expect(() =>
        parseClientConfig({ schemaVersion: 1, webSearch: { ...preferences, ...patch } }),
      ).toThrow();
    });
  }
});

describe("managed search environment", () => {
  test("pins URL/key to the relay and clears obsolete backend-mode settings", () => {
    const environment = {
      PI_WEB_SEARCH_URL: "https://evil.test/api/v1/web-search",
      PI_WEB_SEARCH_BASE_URL: "https://evil.test",
      PI_WEB_SEARCH_API_KEY: "private-key",
      PI_WEB_SEARCH_MODE: "backend",
      PI_WEB_SEARCH_SEARCH_TOOL: "googleSearchRetrieval",
    };
    const child = createHarnessEnvironment(
      environment,
      createWebSearchOverrides(environment, relay, preferences),
    );
    expect(child["PI_WEB_SEARCH_URL"]).toBe(`${relay.origin}/litellm/v1/chat/completions`);
    expect(child["PI_WEB_SEARCH_API_KEY"]).toBe(relay.capability);
    expect(child["PI_WEB_SEARCH_BASE_URL"]).toBeUndefined();
    expect(child["PI_WEB_SEARCH_MODE"]).toBeUndefined();
    expect(child["PI_WEB_SEARCH_SEARCH_TOOL"]).toBeUndefined();
    expect(environment.PI_WEB_SEARCH_API_KEY).toBe("private-key");
  });
  test("backend generation preferences win and null levels clear inherited values", () => {
    const environment = {
      PI_WEB_SEARCH_TEMPERATURE: "0.1",
      PI_WEB_SEARCH_THINKING_LEVEL: "high",
      PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE: "high",
      PI_WEB_SEARCH_USE_URL_CONTEXT: "true",
      PI_WEB_SEARCH_REQUIRE_GROUNDING: "false",
    };
    const child = createHarnessEnvironment(
      environment,
      createWebSearchOverrides(environment, relay, preferences),
    );
    expect(child).toMatchObject({
      PI_WEB_SEARCH_TEMPERATURE: "1",
      PI_WEB_SEARCH_THINKING_LEVEL: "low",
      PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE: "medium",
      PI_WEB_SEARCH_USE_URL_CONTEXT: "false",
      PI_WEB_SEARCH_REQUIRE_GROUNDING: "true",
    });
    const defaults = createHarnessEnvironment(
      environment,
      createWebSearchOverrides(environment, relay, {
        ...preferences,
        thinkingLevel: null,
        searchContextSize: null,
      }),
    );
    expect(defaults["PI_WEB_SEARCH_THINKING_LEVEL"]).toBeUndefined();
    expect(defaults["PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE"]).toBeUndefined();
  });
  test("allows a configured model preference and clamps local limits", () => {
    const overrides = createWebSearchOverrides(
      {
        PI_WEB_SEARCH_MODEL: "other-search-model",
        PI_WEB_SEARCH_TIMEOUT_MS: "10000",
        PI_WEB_SEARCH_MAX_OUTPUT_TOKENS: "100000",
        PI_WEB_SEARCH_MAX_SOURCES: "2",
        PI_WEB_SEARCH_MAX_QUERY_CHARACTERS: "invalid",
      },
      relay,
      preferences,
    );
    expect(overrides).toMatchObject({
      PI_WEB_SEARCH_MODEL: "other-search-model",
      PI_WEB_SEARCH_TIMEOUT_MS: "10000",
      PI_WEB_SEARCH_MAX_OUTPUT_TOKENS: "8192",
      PI_WEB_SEARCH_MAX_SOURCES: "2",
      PI_WEB_SEARCH_MAX_QUERY_CHARACTERS: "20000",
      PI_WEB_SEARCH_MAX_RESULT_CHARACTERS: "30000",
    });
    expect(
      createWebSearchOverrides({ PI_WEB_SEARCH_MODEL: "unknown" }, relay, preferences)[
        "PI_WEB_SEARCH_MODEL"
      ],
    ).toBe(preferences.model);
  });
  test("disablement and offline mode win; missing config preserves preferences but never routing", () => {
    expect(
      createWebSearchOverrides({}, relay, { ...preferences, enabled: false })[
        "PI_WEB_SEARCH_ENABLED"
      ],
    ).toBe("false");
    expect(
      createWebSearchOverrides({ PI_WEB_SEARCH_ENABLED: "false" }, relay, preferences)[
        "PI_WEB_SEARCH_ENABLED"
      ],
    ).toBe("false");
    expect(createWebSearchOverrides({}, relay, preferences, true)["PI_WEB_SEARCH_ENABLED"]).toBe(
      "false",
    );
    const environment = {
      PI_WEB_SEARCH_MODEL: "env-model",
      PI_WEB_SEARCH_THINKING_LEVEL: "high",
      PI_WEB_SEARCH_URL: "https://evil.test",
    };
    const child = createHarnessEnvironment(
      environment,
      createWebSearchOverrides(environment, relay),
    );
    expect(child["PI_WEB_SEARCH_MODEL"]).toBe("env-model");
    expect(child["PI_WEB_SEARCH_THINKING_LEVEL"]).toBe("high");
    expect(child["PI_WEB_SEARCH_URL"]).toBe(`${relay.origin}/litellm/v1/chat/completions`);
  });
});
