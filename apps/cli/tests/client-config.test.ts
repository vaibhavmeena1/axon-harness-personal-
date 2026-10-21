import { describe, expect, test } from "bun:test";

import { fetchClientConfig, parseClientConfig } from "../src/cli/client-config.ts";
import { createTelemetryOverrides } from "../src/harnesses/pi/telemetry-environment.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";
import { takeProductEvents } from "../src/telemetry/product-events.ts";

const policy = {
  enabled: true,
  endpoint: "/api/v1/otel" as const,
  protocol: "http/protobuf" as const,
  traceSampleRatio: 0.25,
  metricExportIntervalMs: 20_000,
};

function fetcher(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe("protected client config", () => {
  test("authenticates at the pinned path, disallows redirects, and extracts safe refresh headers", async () => {
    let seenUrl = "";
    let seenOptions: RequestInit | undefined;
    const result = await fetchClientConfig("saved-token", {
      serviceOrigin: "https://axon.example.test",
      fetcher: (async (url, options) => {
        seenUrl = String(url);
        seenOptions = options;
        return Response.json(
          { schemaVersion: 1, telemetry: policy, env: { EVIL: "ignored" } },
          {
            headers: { "x-session-refresh-token": "rotated-token" },
          },
        );
      }) as typeof fetch,
    });
    expect(seenUrl).toBe("https://axon.example.test/api/v1/cli/config");
    expect(new Headers(seenOptions?.headers).get("authorization")).toBe("Bearer saved-token");
    expect(seenOptions?.redirect).toBe("error");
    expect(seenOptions?.cache).toBe("no-store");
    expect(seenOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      config: { schemaVersion: 1, telemetry: policy },
      sessionRefreshToken: "rotated-token",
    });
  });

  test("allows an absent telemetry policy and strips unknown fields", () => {
    expect(
      parseClientConfig({ schemaVersion: 1, endpoint: "https://evil.test", user: {} }),
    ).toEqual({ schemaVersion: 1 });
  });

  test("manages the Pi default model only when provider and model are both set", () => {
    const base = { codemodeEnabled: true, litellmMcpEnabled: false };
    for (const unset of [null, "", undefined]) {
      expect(
        parseClientConfig({
          schemaVersion: 1,
          pi: { ...base, defaultProvider: unset, defaultModel: unset },
        }).pi,
      ).toEqual(base);
    }
    const pi = { ...base, defaultProvider: "litellm", defaultModel: "openai/gpt-6.1-sol" };
    expect(parseClientConfig({ schemaVersion: 1, pi }).pi).toEqual(pi);
  });

  test("accepts boolean cache notice defaults and isolates invalid values", () => {
    const base = { codemodeEnabled: true, litellmMcpEnabled: false };
    for (const showCacheMissNotices of [true, false]) {
      const pi = { ...base, showCacheMissNotices };
      expect(parseClientConfig({ schemaVersion: 1, pi }).pi).toEqual(pi);
    }
    for (const showCacheMissNotices of [null, "true", 0, 1, [], {}]) {
      expect(
        parseClientConfig({
          schemaVersion: 1,
          pi: { ...base, showCacheMissNotices },
          telemetry: policy,
        }),
      ).toEqual({ schemaVersion: 1, telemetry: policy });
    }
  });

  test("validates optional Pi defaults without accepting arbitrary settings", () => {
    for (const codemodeEnabled of [true, false]) {
      for (const litellmMcpEnabled of [true, false]) {
        const pi = { codemodeEnabled, litellmMcpEnabled };
        expect(parseClientConfig({ schemaVersion: 1, pi }).pi).toEqual(pi);
      }
    }
    for (const pi of [
      {},
      null,
      { codemodeEnabled: true },
      { litellmMcpEnabled: true },
      { codemodeEnabled: true, litellmMcpEnabled: "true" },
      { codemodeEnabled: true, litellmMcpEnabled: 1 },
      { codemodeEnabled: true, litellmMcpEnabled: null },
      { codemodeEnabled: "true", litellmMcpEnabled: true },
      { codemodeEnabled: 1, litellmMcpEnabled: true },
      { codemodeEnabled: true, litellmMcpEnabled: true, shellCommandPrefix: "unsafe" },
      { codemodeEnabled: true, litellmMcpEnabled: true, codemode: { inlineBudget: 3000 } },
      { codemodeEnabled: true, litellmMcpEnabled: true, defaultProvider: "litellm" },
      { codemodeEnabled: true, litellmMcpEnabled: true, defaultModel: "openai/gpt-6.1-sol" },
      { codemodeEnabled: true, litellmMcpEnabled: true, defaultProvider: "", defaultModel: "x/y" },
      {
        codemodeEnabled: true,
        litellmMcpEnabled: true,
        defaultProvider: " litellm",
        defaultModel: "x/y",
      },
      {
        codemodeEnabled: true,
        litellmMcpEnabled: true,
        defaultProvider: "litellm",
        defaultModel: "x\ny",
      },
      {
        codemodeEnabled: true,
        litellmMcpEnabled: true,
        defaultProvider: "litellm",
        defaultModel: 1,
      },
    ]) {
      expect(parseClientConfig({ schemaVersion: 1, pi, telemetry: policy })).toEqual({
        schemaVersion: 1,
        telemetry: policy,
      });
    }
  });

  test("rejects wrong envelopes and isolates invalid telemetry sections", () => {
    for (const envelope of [{ schemaVersion: 2 }, {}, null, [], true])
      expect(() => parseClientConfig(envelope)).toThrow();
    for (const payload of [
      { schemaVersion: 1, telemetry: {} },
      { schemaVersion: 1, telemetry: { ...policy, traceSampleRatio: 2 } },
      { schemaVersion: 1, telemetry: { ...policy, protocol: "http/json" } },
      { schemaVersion: 1, telemetry: { ...policy, metricExportIntervalMs: 1 } },
      { schemaVersion: 1, telemetry: { ...policy, enabled: "true" } },
    ])
      expect(parseClientConfig(payload)).toEqual({ schemaVersion: 1 });
  });

  test("rejects every config destination except the fixed proxy path", () => {
    for (const endpoint of [
      "http://collector.test",
      "https://user:pass@collector.test",
      "https://collector.test?token=secret",
      "https://collector.test#fragment",
      "file:///tmp/sink",
      "https://collector.test:0",
      "https://collector.test/with space",
    ])
      expect(
        parseClientConfig({ schemaVersion: 1, telemetry: { ...policy, endpoint } }).telemetry,
      ).toBeUndefined();
    expect(
      parseClientConfig({ schemaVersion: 1, telemetry: { ...policy, protocol: "grpc" } }).telemetry,
    ).toBeUndefined();
    expect(parseClientConfig({ schemaVersion: 1, telemetry: policy }).telemetry?.endpoint).toBe(
      "/api/v1/otel",
    );
  });

  test("HTTP errors, invalid JSON/schema, HTML, oversized responses, and network errors fall back", async () => {
    for (const response of [
      new Response("secret", { status: 401 }),
      new Response("secret", { status: 403 }),
      new Response("down", { status: 503 }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      Response.json({ schemaVersion: 100 }),
      new Response("<html>SPA</html>"),
      Response.json({ schemaVersion: 1 }, { headers: { "content-length": "100000" } }),
      new Response(`"${"x".repeat(17000)}"`, {
        headers: { "content-type": "application/json" },
      }),
    ])
      expect(await fetchClientConfig("token", { fetcher: fetcher(response) })).toEqual({});
    expect(
      await fetchClientConfig("token", {
        fetcher: (async () => {
          throw new Error("private-url");
        }) as unknown as typeof fetch,
      }),
    ).toEqual({});
  });

  test("deadline covers response body reading, not just headers", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"schemaVersion":'));
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-session-refresh-token": "rotated-after-headers",
            },
          },
        );
      },
    });
    try {
      takeProductEvents();
      const started = Date.now();
      expect(
        await fetchClientConfig("token", { serviceOrigin: server.url.origin, timeoutMs: 30 }),
      ).toEqual({ sessionRefreshToken: "rotated-after-headers" });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(takeProductEvents()).toEqual([
        expect.objectContaining({
          category: "config",
          stage: "fetch",
          outcome: "failed",
          reason: "timeout",
        }),
      ]);
    } finally {
      server.stop(true);
    }
  });
});

describe("Pi telemetry environment", () => {
  test("remote config wins over base and per-signal env settings without mutating them", () => {
    const environment = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://old.test",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=old-secret",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://old.test/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://old.test/metrics",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://old.test/logs",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=signal-secret",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc",
      OTEL_TRACES_SAMPLER: "always_on",
      OTEL_METRIC_EXPORT_INTERVAL: "1000",
      PI_ORG_OTEL_ENABLED: "true",
      OTEL_SERVICE_NAME: "local-service",
    };
    const child = createHarnessEnvironment(
      environment,
      createTelemetryOverrides(environment, policy, false, {
        home: "/tmp/managed",
        serviceOrigin: "https://axon.example.test",
      }),
    );
    expect(child["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("https://axon.example.test/api/v1/otel");
    expect(child["PI_ORG_OTEL_MANAGED_HOME"]).toBe("/tmp/managed");
    expect(child["PI_ORG_OTEL_MANAGED_ENDPOINT"]).toBe(child["OTEL_EXPORTER_OTLP_ENDPOINT"]);
    expect(child["OTEL_EXPORTER_OTLP_PROTOCOL"]).toBe("http/protobuf");
    expect(child["OTEL_TRACES_SAMPLER_ARG"]).toBe("0.25");
    expect(child["OTEL_METRIC_EXPORT_INTERVAL"]).toBe("20000");
    for (const name of [
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    ])
      expect(child[name]).toBeUndefined();
    expect(child["OTEL_SERVICE_NAME"]).toBe("local-service");
    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://old.test");
    expect(environment.OTEL_EXPORTER_OTLP_HEADERS).toBe("authorization=old-secret");
  });

  test("backend enablement beats local preferences; offline always wins", () => {
    expect(
      createTelemetryOverrides({ PI_ORG_OTEL_ENABLED: "true" }, { ...policy, enabled: false }),
    ).toMatchObject({ PI_ORG_OTEL_ENABLED: "false" });
    for (const value of ["false", "0", "no", "off", " FALSE ", " NO ", " Off "]) {
      const environment = {
        PI_ORG_OTEL_ENABLED: value,
        OTEL_TRACES_SAMPLER: "always_off",
        OTEL_TRACES_SAMPLER_ARG: "0",
      };
      expect(
        createTelemetryOverrides(environment, policy, false, { home: "/tmp/managed" }),
      ).toMatchObject({
        PI_ORG_OTEL_ENABLED: "true",
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.25",
      });
      // No-policy fallback retains the existing false/0/no parser (not a new env contract).
      expect(createTelemetryOverrides(environment)["PI_ORG_OTEL_ENABLED"]).toBe(
        value.trim().toLowerCase() === "off" ? undefined : "false",
      );
      expect(environment.PI_ORG_OTEL_ENABLED).toBe(value);
    }
    expect(createTelemetryOverrides({}, policy, true)).toMatchObject({
      PI_ORG_OTEL_ENABLED: "false",
    });
  });

  test("missing/unavailable policy preserves env fallback", () => {
    const environment = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://old.test",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=env-key",
      PI_ORG_OTEL_MANAGED_ENDPOINT: "https://evil.test",
      PI_ORG_OTEL_MANAGED_HOME: "/tmp/evil",
    };
    const child = createHarnessEnvironment(environment, createTelemetryOverrides(environment));
    expect(child["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("https://old.test");
    expect(child["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("authorization=env-key");
    expect(child["PI_ORG_OTEL_MANAGED_ENDPOINT"]).toBeUndefined();
    expect(child["PI_ORG_OTEL_MANAGED_HOME"]).toBeUndefined();
  });
});
