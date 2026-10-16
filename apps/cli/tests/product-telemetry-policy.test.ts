import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import {
  beginProductTelemetryInvocation,
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

for (const mode of [
  "enabled",
  "disabled",
  "absent",
  "invalid",
  "switched",
  "unreadable",
  "offline",
  "already_resolved_absent",
] as const) {
  test(`product telemetry resolves once through shutdown: ${mode}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "axon-policy-"));
    const paths = resolveAxonPaths({ HOME: home, AXON_HOME: home });
    let lookups = 0;
    const exports: Buffer[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/api/v1/cli/config") {
          lookups++;
          expect(request.headers.get("authorization")).toBe("Bearer current-session");
          if (mode === "switched") await saveEncryptedSession(paths, "different-account");
          if (mode === "unreadable") await Bun.write(paths.sharedAuthFile, "{invalid");
          return Response.json({
            schemaVersion: 1,
            ...(mode === "absent"
              ? {}
              : {
                  telemetry:
                    mode === "invalid"
                      ? { enabled: "true" }
                      : { ...policy, enabled: mode !== "disabled" },
                }),
          });
        }
        expect(request.headers.get("authorization")).toBe("Bearer current-session");
        exports.push(Buffer.from(await request.arrayBuffer()));
        return new Response(null, { headers: { "content-type": "application/x-protobuf" } });
      },
    });
    const oldHome = process.env["HOME"];
    const oldDisabled = process.env["PI_ORG_OTEL_ENABLED"];
    process.env["HOME"] = home;
    const localEnablement = mode === "disabled" ? "true" : "false";
    process.env["PI_ORG_OTEL_ENABLED"] = localEnablement;
    try {
      beginProductTelemetryInvocation();
      takeProductEvents();
      await saveEncryptedSession(paths, "current-session");
      emitProductEvent({ category: "startup", stage: "prepare", outcome: "success" });
      await initializeProductTelemetry(paths, undefined, {
        serviceOrigin: server.url.origin,
        ...(["offline", "already_resolved_absent"].includes(mode)
          ? { decision: mode === "offline" ? { offline: true, policy } : { offline: false } }
          : {}),
      });
      emitProductEvent({ category: "startup", stage: "spawn", outcome: "success" });
      await flushProductTelemetry(paths);
      // Even closing before a later finalizer must not forget an absent/invalid decision.
      await closeProductTelemetry();
      emitProductEvent({ category: "startup", stage: "ready", outcome: "success" });
      await flushProductTelemetry(paths);
      expect(lookups).toBe(["offline", "already_resolved_absent"].includes(mode) ? 0 : 1);
      if (mode === "enabled") {
        expect(exports.length).toBeGreaterThan(0);
        expect(exports.some((body) => body.includes(Buffer.from("prepare")))).toBe(true);
        expect(exports.some((body) => body.includes(Buffer.from("spawn")))).toBe(true);
      } else expect(exports).toEqual([]);
      expect(process.env["PI_ORG_OTEL_ENABLED"]).toBe(localEnablement);
    } finally {
      await flushProductTelemetry(paths, true);
      beginProductTelemetryInvocation();
      if (oldHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldHome;
      if (oldDisabled === undefined) delete process.env["PI_ORG_OTEL_ENABLED"];
      else process.env["PI_ORG_OTEL_ENABLED"] = oldDisabled;
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
}
