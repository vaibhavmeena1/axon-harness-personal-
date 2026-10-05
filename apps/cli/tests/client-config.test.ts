import { describe, expect, test } from "bun:test";

import { fetchClientConfig, parseClientConfig } from "../src/cli/client-config.ts";
import { createTelemetryOverrides } from "../src/harnesses/pi/telemetry-environment.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";

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
      serviceOrigin: "https://deputydev.example.test",
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
    expect(seenUrl).toBe("https://deputydev.example.test/api/v1/cli/config");
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

  test("rejects wrong versions, invalid bounds, and missing endpoints", () => {
    for (const payload of [
      { schemaVersion: 2 },
      { schemaVersion: 1, telemetry: {} },
      { schemaVersion: 1, telemetry: { ...policy, traceSampleRatio: 2 } },
      { schemaVersion: 1, telemetry: { ...policy, protocol: "http/json" } },
      { schemaVersion: 1, telemetry: { ...policy, metricExportIntervalMs: 1 } },
      { schemaVersion: 1, telemetry: { ...policy, enabled: "true" } },
    ])
      expect(() => parseClientConfig(payload)).toThrow();
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
      expect(() =>
        parseClientConfig({ schemaVersion: 1, telemetry: { ...policy, endpoint } }),
      ).toThrow();
    expect(() =>
      parseClientConfig({ schemaVersion: 1, telemetry: { ...policy, protocol: "grpc" } }),
    ).toThrow();
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
      new Response('"' + "x".repeat(17000) + '"', {
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
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    try {
      const started = Date.now();
      expect(
        await fetchClientConfig("token", { serviceOrigin: server.url.origin, timeoutMs: 30 }),
      ).toEqual({});
      expect(Date.now() - started).toBeLessThan(1000);
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
        serviceOrigin: "https://deputydev.example.test",
      }),
    );
    expect(child["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("https://deputydev.example.test/api/v1/otel");
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

  test("disabled policy beats enabled env; local kill switch and offline always win", () => {
    expect(
      createTelemetryOverrides({ PI_ORG_OTEL_ENABLED: "true" }, { ...policy, enabled: false }),
    ).toMatchObject({ PI_ORG_OTEL_ENABLED: "false" });
    for (const value of ["false", "0", "no", " FALSE "])
      expect(createTelemetryOverrides({ PI_ORG_OTEL_ENABLED: value }, policy)).toMatchObject({
        PI_ORG_OTEL_ENABLED: "false",
      });
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
