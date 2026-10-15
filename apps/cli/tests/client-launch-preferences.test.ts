import { describe, expect, spyOn, test } from "bun:test";
import { parseClientConfig } from "../src/cli/client-config.ts";
import {
  createCompactionOverrides,
  createLiteLLMClientOverrides,
  createModelRecommenderOverrides,
} from "../src/harnesses/pi/launch-preferences-environment.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";
import fixtures from "./fixtures/client-launch-preferences.json";

const telemetry = {
  enabled: true,
  endpoint: "/api/v1/otel",
  protocol: "http/protobuf",
  traceSampleRatio: 1,
  metricExportIntervalMs: 10000,
} as const;

describe("shared Python/JavaScript launch preference contract", () => {
  for (const [name, fixture] of Object.entries(fixtures.sections)) {
    const wireName = fixture.wireName;
    const fields: Record<string, string> = fixture.fields;
    const project = (input: unknown) =>
      input && typeof input === "object" && !Array.isArray(input)
        ? Object.fromEntries(
            Object.entries(input).map(([key, value]) => [fields[key] ?? key, value]),
          )
        : input;
    test(`${name} accepts partial values and normalizes null/empty to absence`, () => {
      expect(Reflect.get(parseClientConfig({ schemaVersion: 1 }), wireName)).toBeUndefined();
      for (const { input, output } of fixture.valid) {
        const config = parseClientConfig({ schemaVersion: 1, [wireName]: project(input) });
        expect(Reflect.get(config, wireName)).toEqual(output ?? undefined);
      }
    });
    test(`${name} rejects malformed sections as a unit, without erasing valid telemetry`, () => {
      const diagnostic = spyOn(console, "error");
      const invalid: string[] = [];
      const record = (section: string) => invalid.push(section);
      try {
        for (const input of fixture.invalid) {
          const config = parseClientConfig(
            { schemaVersion: 1, [wireName]: project(input), telemetry },
            record,
          );
          expect(config).toEqual({ schemaVersion: 1, telemetry });
        }
        for (const [key, field] of Object.entries(fields)) {
          if (key === "MODEL" || key === "ENABLED") continue;
          for (const value of [Infinity, -Infinity, NaN])
            expect(
              Reflect.get(
                parseClientConfig({ schemaVersion: 1, [wireName]: { [field]: value } }, record),
                wireName,
              ),
            ).toBeUndefined();
        }
        expect(invalid.length).toBeGreaterThan(0);
        expect(new Set(invalid)).toEqual(new Set([wireName]));
        // Parsing never prints: reload runs while Pi owns the terminal.
        expect(diagnostic).not.toHaveBeenCalled();
      } finally {
        diagnostic.mockRestore();
      }
    });
  }

  test("an invalid optional section never erases unrelated accepted sections", () => {
    const diagnostic = spyOn(console, "error");
    try {
      for (const section of [
        "pi",
        "webSearch",
        "terminalPermissions",
        "compaction",
        "modelRecommender",
        "litellmClient",
      ]) {
        expect(
          parseClientConfig({
            schemaVersion: 1,
            telemetry,
            [section]: { invalid: "private-secret" },
          }),
        ).toEqual({ schemaVersion: 1, telemetry });
      }
      expect(
        parseClientConfig({
          schemaVersion: 1,
          telemetry: { enabled: "invalid" },
          compaction: { enabled: false },
        }),
      ).toEqual({ schemaVersion: 1, compaction: { enabled: false } });
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
    }
  });
});

test("all ten allowlisted environment mappings override local values without changing parent or unrelated values", () => {
  const config = parseClientConfig({
    schemaVersion: 1,
    compaction: {
      enabled: false,
      model: "litellm/team/summary",
      thresholdTokens: 80000,
      maxOutputTokens: 8192,
      timeoutMs: 120000,
    },
    modelRecommender: { enabled: true, timeoutMs: 15000, autoSelectMs: 10000 },
    litellmClient: { discoveryTimeoutMs: 0, defaultContextWindow: 128000 },
  });
  const expected = {
    PI_COMPACTION_ENABLED: "false",
    PI_COMPACTION_MODEL: "litellm/team/summary",
    PI_COMPACTION_THRESHOLD_TOKENS: "80000",
    PI_COMPACTION_MAX_OUTPUT_TOKENS: "8192",
    PI_COMPACTION_TIMEOUT_MS: "120000",
    PI_MODEL_RECOMMENDER_DISABLED: "false",
    PI_MODEL_RECOMMENDER_TIMEOUT_MS: "15000",
    PI_MODEL_RECOMMENDER_AUTO_SELECT_MS: "10000",
    LITELLM_DISCOVERY_TIMEOUT_MS: "0",
    LITELLM_DEFAULT_CONTEXT_WINDOW: "128000",
  };
  const inherited = Object.freeze({
    ...Object.fromEntries(Object.keys(expected).map((key) => [key, "local"])),
    KEEP_ME: "unchanged",
  });
  const child = createHarnessEnvironment(
    inherited,
    createCompactionOverrides(config.compaction),
    createModelRecommenderOverrides(config.modelRecommender),
    createLiteLLMClientOverrides(config.litellmClient),
  );
  expect(child).toEqual({ ...expected, KEEP_ME: "unchanged" });
  for (const key of Object.keys(expected)) expect(Reflect.get(inherited, key)).toBe("local");
  expect(createCompactionOverrides({ enabled: true })).toEqual({ PI_COMPACTION_ENABLED: "true" });
  expect(createModelRecommenderOverrides({ enabled: false })).toEqual({
    PI_MODEL_RECOMMENDER_DISABLED: "true",
  });
  expect(createLiteLLMClientOverrides({ discoveryTimeoutMs: 5000 })).toEqual({
    LITELLM_DISCOVERY_TIMEOUT_MS: "5000",
  });
});

test("missing, null and unspecified preferences retain inherited environment values", () => {
  const environment = {
    PI_COMPACTION_MODEL: "litellm/local",
    PI_MODEL_RECOMMENDER_AUTO_SELECT_MS: "2000",
    LITELLM_DEFAULT_CONTEXT_WINDOW: "9999",
  };
  for (const section of [undefined, null, {}, { model: null, timeoutMs: null }]) {
    const config = parseClientConfig({
      schemaVersion: 1,
      compaction: section,
      modelRecommender: null,
      litellmClient: {},
    });
    expect(createCompactionOverrides(config.compaction)).toEqual({});
    expect(createModelRecommenderOverrides(config.modelRecommender)).toEqual({});
    expect(createLiteLLMClientOverrides(config.litellmClient)).toEqual({});
    expect(
      createHarnessEnvironment(environment, createCompactionOverrides(config.compaction)),
    ).toEqual(environment);
  }
});
