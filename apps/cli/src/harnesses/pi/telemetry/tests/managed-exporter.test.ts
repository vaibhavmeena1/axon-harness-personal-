import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEncryptedSession, saveEncryptedSession } from "../../../../cli/auth/session.ts";
import { withFileLock } from "../../../../launcher/file-lock.ts";
import { resolveAxonPaths } from "../../../../product/paths.ts";
import { resolveConfig } from "../src/config.ts";
import { resolveIdentity } from "../src/identity.ts";
import { ManagedOtlpTransport } from "../src/otel/managed-exporter.ts";
import { createOtelRuntime } from "../src/otel/runtime.ts";
import { AgentTelemetryTracker } from "../src/tracker.ts";

async function withHome(operation: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "axon-managed-otel-"));
  try {
    await saveEncryptedSession(resolveAxonPaths({ AXON_HOME: home }), "initial-token");
    await operation(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function manageEnv(values: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("managed identity never reads Git email", async () => {
  const identity = await resolveIdentity({
    env: { PI_ORG_OTEL_MANAGED_ENDPOINT: "https://backend.test/api/v1/otel" },
    readGitEmail: () => {
      throw new Error("must not read Git");
    },
  });
  expect(identity).toEqual({ userId: "managed", source: "axon_auth" });
});

test("each batch reads current session, persists rotation, and ignores ambient OTEL credentials", async () => {
  await withHome(async (home) => {
    const seen: Array<{ authorization: string | null; cookie: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          body: await request.text(),
        });
        return new Response(null, { headers: { "x-session-refresh-token": "rotated-token" } });
      },
    });
    const restore = manageEnv({ OTEL_EXPORTER_OTLP_HEADERS: "authorization=ambient-secret" });
    const transport = new ManagedOtlpTransport(`${server.url.origin}/api/v1/otel/v1/logs`, home);
    try {
      expect((await transport.send(new TextEncoder().encode("payload"), 1000)).status).toBe(
        "success",
      );
      expect(await loadEncryptedSession(resolveAxonPaths({ AXON_HOME: home }))).toBe(
        "rotated-token",
      );
      expect((await transport.send(new Uint8Array(), 1000)).status).toBe("success");
      expect(seen.map((entry) => entry.authorization)).toEqual([
        "Bearer initial-token",
        "Bearer rotated-token",
      ]);
      expect(seen[0]?.body).toBe("payload");
      expect(seen.every((entry) => entry.cookie === null)).toBe(true);
    } finally {
      transport.shutdown();
      restore();
      server.stop(true);
    }
  });
});

test("an old response cannot overwrite a concurrent new login", async () => {
  await withHome(async (home) => {
    const paths = resolveAxonPaths({ AXON_HOME: home });
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await saveEncryptedSession(paths, "new-login-token");
        return new Response(null, { headers: { "x-session-refresh-token": "stale-rotation" } });
      },
    });
    const transport = new ManagedOtlpTransport(server.url.toString(), home);
    try {
      expect((await transport.send(new Uint8Array(), 1000)).status).toBe("success");
      expect(await loadEncryptedSession(paths)).toBe("new-login-token");
    } finally {
      transport.shutdown();
      server.stop(true);
    }
  });
});

test("retries transient status using the rotated session and respects Retry-After/deadline", async () => {
  await withHome(async (home) => {
    const seen: Array<string | null> = [];
    let alwaysBusy = false;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization"));
        return seen.length === 1 || alwaysBusy
          ? new Response(null, {
              status: 503,
              headers: {
                "retry-after": alwaysBusy ? "60" : "0",
                "x-session-refresh-token": "rotated-token",
              },
            })
          : new Response(null);
      },
    });
    const transport = new ManagedOtlpTransport(server.url.toString(), home);
    try {
      expect((await transport.send(new Uint8Array(), 1000)).status).toBe("success");
      expect(seen).toEqual(["Bearer initial-token", "Bearer rotated-token"]);
      alwaysBusy = true;
      const started = Date.now();
      expect((await transport.send(new Uint8Array(), 50)).status).toBe("failure");
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      transport.shutdown();
      server.stop(true);
    }
  });
});

test("does not follow redirects or retry authentication errors; errors never contain secrets", async () => {
  await withHome(async (home) => {
    let leaked = false;
    const destination = Bun.serve({
      port: 0,
      fetch() {
        leaked = true;
        return new Response(null);
      },
    });
    let status = 302;
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts++;
        return new Response("private-body-secret", {
          status,
          headers: { location: destination.url.toString() },
        });
      },
    });
    const transport = new ManagedOtlpTransport(server.url.toString(), home);
    try {
      for (const code of [302, 401, 403]) {
        status = code;
        const result = await transport.send(new Uint8Array(), 1000);
        expect(result.status).toBe("failure");
        if (result.status === "failure") {
          expect(result.error.message).not.toContain("token");
          expect(result.error.message).not.toContain("private-body");
        }
      }
      expect(attempts).toBe(3);
      expect(leaked).toBe(false);
    } finally {
      transport.shutdown();
      server.stop(true);
      destination.stop(true);
    }
  });
});

test.each(["", "/axon"])(
  "all three managed SDK exporters send serialized protobuf below base path %j",
  async (basePath) => {
    await withHome(async (home) => {
      const requests: Array<{
        path: string;
        authorization: string | null;
        contentType: string | null;
        body: Buffer;
      }> = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          requests.push({
            path: new URL(request.url).pathname,
            authorization: request.headers.get("authorization"),
            contentType: request.headers.get("content-type"),
            body: Buffer.from(await request.arrayBuffer()),
          });
          return new Response(null, { headers: { "content-type": "application/x-protobuf" } });
        },
      });
      const endpoint = `${server.url.origin}${basePath}/api/v1/otel`;
      const restore = manageEnv({
        PI_ORG_OTEL_MANAGED_ENDPOINT: endpoint,
        PI_ORG_OTEL_MANAGED_HOME: home,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://must-not-contact.test",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://must-not-contact.test/traces",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=ambient-secret",
        PI_ORG_OTEL_DIAGNOSTICS: "false",
      });
      try {
        const config = resolveConfig();
        expect(config).toBeDefined();
        if (!config) throw new Error("missing config");
        const runtime = createOtelRuntime(config, await resolveIdentity());
        const tracker = new AgentTelemetryTracker(runtime);
        tracker.startSession({
          sessionId: "s",
          project: "p",
          mode: "tui",
          reason: "startup",
          ephemeral: false,
          cwd: home,
        });
        tracker.startInteraction(10, 0);
        tracker.startRun();
        tracker.startTurn(0);
        tracker.startLlm({ provider: "litellm", model: "test" });
        tracker.endLlm({ stopReason: "stop", usage: { input: 1, output: 1 } });
        tracker.endTurn("ok", { stopReason: "stop" }, 0);
        tracker.endRun("stop");
        tracker.endInteraction();
        tracker.endSession("quit");
        await runtime.shutdown();
        expect(new Set(requests.map((request) => request.path))).toEqual(
          new Set(
            ["traces", "metrics", "logs"].map((signal) => `${basePath}/api/v1/otel/v1/${signal}`),
          ),
        );
        for (const request of requests) {
          expect(request.authorization).toBe("Bearer initial-token");
          expect(request.contentType).toBe("application/x-protobuf");
          expect(request.body.byteLength).toBeGreaterThan(0);
          expect(request.body.includes(Buffer.from("axon_auth"))).toBe(true);
          expect(request.body.includes(Buffer.from("initial-token"))).toBe(false);
          expect(request.body.includes(Buffer.from("ambient-secret"))).toBe(false);
        }
      } finally {
        restore();
        server.stop(true);
      }
    });
  },
);

test("rotation lock contention obeys batch deadline, retains CAS and never persists after cancellation", async () => {
  await withHome(async (home) => {
    const paths = resolveAxonPaths({ AXON_HOME: home });
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const lock = withFileLock(join(paths.locks, "session.lock"), async () => {
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { headers: { "x-session-refresh-token": "must-not-persist" } });
      },
    });
    const transport = new ManagedOtlpTransport(server.url.toString(), home);
    try {
      const started = Date.now();
      expect((await transport.send(new Uint8Array(), 50)).status).toBe("failure");
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await loadEncryptedSession(paths)).toBe("initial-token");
    } finally {
      release();
      await lock;
      transport.shutdown();
      server.stop(true);
    }
    expect(await loadEncryptedSession(paths)).toBe("initial-token");
  });
});

test("bounded chunked/oversized responses and hanging body cancellation", async () => {
  await withHome(async (home) => {
    const originalFetch = globalThis.fetch;
    const transport = new ManagedOtlpTransport("http://127.0.0.1:9/never-fetched", home);
    try {
      for (const response of [
        new Response("x", { headers: { "content-length": "65537" } }),
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(65537));
              controller.close();
            },
          }),
        ),
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1));
            },
          }),
        ),
      ]) {
        globalThis.fetch = (async () => response) as unknown as typeof fetch;
        const started = Date.now();
        expect((await transport.send(new Uint8Array(), 50)).status).toBe("failure");
        expect(Date.now() - started).toBeLessThan(1000);
      }
    } finally {
      globalThis.fetch = originalFetch;
      transport.shutdown();
    }
  });
});

test("managed deadline also bounds never-settling stream cancellation and uncooperative fetch", async () => {
  await withHome(async (home) => {
    const originalFetch = globalThis.fetch;
    const transport = new ManagedOtlpTransport("http://127.0.0.1:9/never-fetched", home);
    try {
      for (const status of [200, 503, 401]) {
        globalThis.fetch = (async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (status === 200) controller.enqueue(new Uint8Array(1));
              },
              cancel() {
                return new Promise<void>(() => {});
              },
            }),
            { status, headers: { "retry-after": "0" } },
          )) as unknown as typeof fetch;
        const started = Date.now();
        expect((await transport.send(new Uint8Array(), 50)).status).toBe("failure");
        expect(Date.now() - started).toBeLessThan(500);
      }
      globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      const started = Date.now();
      expect((await transport.send(new Uint8Array(), 50)).status).toBe("failure");
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      globalThis.fetch = originalFetch;
      transport.shutdown();
    }
  });
});

test("runtime shutdown is shared and aborts managed hanging bodies at its deadline", async () => {
  await withHome(async (home) => {
    const originalFetch = globalThis.fetch;
    let cancelled = 0;
    const restore = manageEnv({
      PI_ORG_OTEL_MANAGED_ENDPOINT: "http://127.0.0.1:9/api/v1/otel",
      PI_ORG_OTEL_MANAGED_HOME: home,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
      PI_ORG_OTEL_DIAGNOSTICS: "false",
    });
    try {
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled++;
            },
          }),
        )) as unknown as typeof fetch;
      const config = resolveConfig();
      if (!config) throw new Error("missing config");
      const runtime = createOtelRuntime(
        { ...config, shutdownTimeoutMs: 100, exportTimeoutMs: 1000 },
        { userId: "managed", source: "axon_auth" },
      );
      runtime.tracer.startSpan("fixture").end();
      runtime.logs.emit("info", "fixture", "fixture");
      runtime.metrics.count("fixture", 1);
      const started = Date.now();
      const shutdown = runtime.shutdown();
      expect(runtime.shutdown()).toBe(shutdown);
      await shutdown;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(Date.now() - started).toBeLessThan(500);
      expect(cancelled).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });
});

test.each([
  "https://evil.test/other",
  "http://backend.test/axon/api/v1/otel",
  "https://user:password@backend.test/axon/api/v1/otel",
  "https://backend.test/axon/api/v1/otel?collector=other",
  "https://backend.test/axon/../api/v1/otel",
  "https://backend.test/axon/%2e%2e/api/v1/otel",
  "https://backend.test/axon//api/v1/otel",
])(
  "invalid managed endpoint %j fails closed rather than using env credentials",
  async (endpoint) => {
    const restore = manageEnv({
      PI_ORG_OTEL_MANAGED_ENDPOINT: endpoint,
      PI_ORG_OTEL_MANAGED_HOME: "/tmp/home",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://fallback.test",
    });
    try {
      const config = resolveConfig();
      if (!config) throw new Error("missing config");
      expect(() => createOtelRuntime(config, { userId: "managed", source: "axon_auth" })).toThrow();
    } finally {
      restore();
    }
  },
);
