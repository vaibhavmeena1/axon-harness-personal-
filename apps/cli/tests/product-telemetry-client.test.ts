import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import {
  closeProductTelemetry,
  flushProductTelemetry,
  initializeProductTelemetry,
} from "../src/telemetry/client.ts";
import { emitProductEvent, takeProductEvents } from "../src/telemetry/product-events.ts";

const policy = {
  enabled: true,
  endpoint: "/api/v1/otel" as const,
  protocol: "http/protobuf" as const,
  traceSampleRatio: 1,
  metricExportIntervalMs: 10000,
};

test("launcher product events export authenticated protobuf to the pinned backend without mutating ambient env", async () => {
  const home = await mkdtemp(join(tmpdir(), "axon-products-"));
  const paths = resolveAxonPaths({ AXON_HOME: home });
  const received: {
    path: string;
    auth: string | null;
    contentType: string | null;
    body: Buffer;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        body: Buffer.from(await request.arrayBuffer()),
      });
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/x-protobuf" },
      });
    },
  });
  const oldEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  try {
    await saveEncryptedSession(paths, "product-test-session");
    takeProductEvents();
    emitProductEvent({
      category: "update",
      stage: "install",
      outcome: "failed",
      reason: "validation",
    });
    await initializeProductTelemetry(paths, policy, { serviceOrigin: server.url.origin });
    emitProductEvent({
      category: "restore",
      stage: "request",
      outcome: "success",
      durationMs: 200,
    });
    await flushProductTelemetry(paths);
    assert.deepEqual(
      new Set(received.map((request) => request.path)),
      new Set(["/api/v1/otel/v1/traces", "/api/v1/otel/v1/metrics", "/api/v1/otel/v1/logs"]),
    );
    assert.ok(
      received.every(
        (request) =>
          request.auth === "Bearer product-test-session" &&
          request.contentType === "application/x-protobuf",
      ),
    );
    assert.ok(received.some((request) => request.body.includes(Buffer.from("axon.update.events"))));
    assert.ok(
      received.every((request) => !request.body.includes(Buffer.from("product-test-session"))),
    );
    assert.equal(process.env["OTEL_EXPORTER_OTLP_ENDPOINT"], oldEndpoint);
  } finally {
    await flushProductTelemetry(paths, true);
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent close waits for initialization, shares shutdown and detaches the event observer", async () => {
  const home = await mkdtemp(join(tmpdir(), "axon-product-close-"));
  const paths = resolveAxonPaths({ AXON_HOME: home });
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(new URL(request.url).pathname);
      await request.arrayBuffer();
      return new Response(null, { headers: { "content-type": "application/x-protobuf" } });
    },
  });
  try {
    await saveEncryptedSession(paths, "close-test-session");
    takeProductEvents();
    emitProductEvent({ category: "backup", stage: "commit", outcome: "success" });
    const initializing = initializeProductTelemetry(paths, policy, {
      serviceOrigin: server.url.origin,
    });
    const closing = closeProductTelemetry();
    assert.equal(closeProductTelemetry(), closing);
    await Promise.all([initializing, closing]);
    assert.ok(received.includes("/api/v1/otel/v1/metrics"));
    emitProductEvent({ category: "backup", stage: "commit", outcome: "success" });
    assert.equal(takeProductEvents().length, 1);
  } finally {
    await flushProductTelemetry(paths, true);
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

test("a short-lived CLI process exports product metrics, traces and logs before exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "axon-product-exit-"));
  const paths = resolveAxonPaths({ AXON_HOME: home });
  const received = new Map<string, Buffer[]>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert.equal(request.headers.get("authorization"), "Bearer exit-test-session");
      const path = new URL(request.url).pathname;
      const bodies = received.get(path) ?? [];
      bodies.push(Buffer.from(await request.arrayBuffer()));
      received.set(path, bodies);
      return new Response(null, { headers: { "content-type": "application/x-protobuf" } });
    },
  });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await saveEncryptedSession(paths, "exit-test-session");
    const client = new URL("../src/telemetry/client.ts", import.meta.url).href;
    const events = new URL("../src/telemetry/product-events.ts", import.meta.url).href;
    const pathsModule = new URL("../src/product/paths.ts", import.meta.url).href;
    child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import { initializeProductTelemetry, flushProductTelemetry } from ${JSON.stringify(client)};
       import { emitProductEvent } from ${JSON.stringify(events)};
       import { resolveAxonPaths } from ${JSON.stringify(pathsModule)};
       const paths = resolveAxonPaths({ AXON_HOME: ${JSON.stringify(home)} });
       await initializeProductTelemetry(paths, ${JSON.stringify(policy)}, { serviceOrigin: ${JSON.stringify(server.url.origin)} });
       emitProductEvent({ category: "backup", stage: "upload", outcome: "success", durationMs: 20, bytes: 1024 });
       emitProductEvent({ category: "backup", stage: "upload", outcome: "success", durationMs: 30, bytes: 2048 });
       await flushProductTelemetry(paths);`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(
      new Set(received.keys()),
      new Set(["/api/v1/otel/v1/traces", "/api/v1/otel/v1/metrics", "/api/v1/otel/v1/logs"]),
    );
    const metrics = received.get("/api/v1/otel/v1/metrics");
    assert.equal(
      metrics?.length,
      1,
      "shutdown exports without waiting for the 10s periodic interval",
    );
    for (const name of ["events", "duration", "transfer"])
      assert.ok(metrics?.[0]?.includes(Buffer.from(`axon.backup.${name}`)), name);
    assert.ok(
      [...received.values()]
        .flat()
        .every((body) => !body.includes(Buffer.from("exit-test-session"))),
    );
  } finally {
    if (child?.exitCode === null) child.kill();
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

test("disabled policy discards events without contacting a collector", async () => {
  takeProductEvents();
  emitProductEvent({ category: "config", stage: "fetch", outcome: "failed", reason: "timeout" });
  await initializeProductTelemetry(resolveAxonPaths(), { ...policy, enabled: false });
  assert.equal(takeProductEvents().length, 0);
  await flushProductTelemetry(resolveAxonPaths());
});
