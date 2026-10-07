import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadEncryptedSession, saveEncryptedSession } from "../src/cli/auth/session.ts";
import {
  normalizeManifestPackages,
  resolveInstalledPackagePath,
} from "../src/harnesses/pi/setup/packages/manifest.ts";
import { DEPUTYDEV_MANIFEST } from "../src/product/manifest.ts";
import { resolveDeputyDevPaths } from "../src/product/paths.ts";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];
let authorization: string | null;
let mode: "valid" | "failed" = "valid";
const projectRoot = resolve(import.meta.dir, "..");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ddcli-pi-config-"));
  const paths = resolveDeputyDevPaths({ DEPUTYDEV_HOME: root });
  await saveEncryptedSession(paths, "initial-token");
  const packages = normalizeManifestPackages(DEPUTYDEV_MANIFEST);
  for (const entry of packages) {
    const directory = resolveInstalledPackagePath(entry, paths.pi);
    await mkdir(directory, { recursive: true });
    await Bun.write(
      join(directory, "package.json"),
      JSON.stringify({
        name: entry.packageName,
        version: entry.versionPolicy.kind === "floating" ? "1.0.0" : entry.versionPolicy.version,
      }),
    );
  }
  await Bun.write(
    join(paths.pi, "settings.json"),
    JSON.stringify({ packages: packages.map((entry) => entry.configuredSource) }),
  );
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/api/v1/cli/config") {
        authorization = request.headers.get("authorization");
        if (mode === "failed") return new Response("unavailable", { status: 503 });
        return Response.json(
          {
            schemaVersion: 1,
            telemetry: {
              enabled: true,
              endpoint: "/api/v1/otel",
              protocol: "http/protobuf",
              traceSampleRatio: 0.5,
              metricExportIntervalMs: 15000,
            },
          },
          {
            headers: { "x-session-refresh-token": "rotated-token" },
          },
        );
      }
      return Response.json({ mcpServers: {} });
    },
  });
});
afterAll(async () => {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function launchSpec(
  options: { interactive?: boolean; offline?: boolean; disabled?: boolean; admin?: boolean } = {},
) {
  const script = [
    'import { createPiAdapter } from "./src/harnesses/pi/adapter.ts";',
    'import { resolveHarnessRegistration } from "./src/harnesses/registry.ts";',
    'import { resolveDeputyDevPaths } from "./src/product/paths.ts";',
    'Object.defineProperty(process.stdin, "isTTY", { value: ' +
      (options.interactive !== false) +
      " });",
    'Object.defineProperty(process.stdout, "isTTY", { value: ' +
      (options.interactive !== false) +
      " });",
    'const context = { cwd: process.env.HOME, environment: process.env, paths: resolveDeputyDevPaths(), registration: resolveHarnessRegistration("pi"), executable: "/unused" };',
    "const adapter = createPiAdapter();",
    "const args = " +
      JSON.stringify(options.admin ? ["--help"] : options.offline ? ["--offline"] : ["hello"]) +
      ";",
    "await adapter.prepare(context, args);",
    "const spec = await adapter.buildLaunchSpec(context, args);",
    "console.log(JSON.stringify(spec.environment));",
    "spec.dispose?.();",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: root,
      CI: "false",
      DEPUTYDEV_HOME: root,
      DEPUTYDEV_SERVICE_ORIGIN: server.url.origin,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.test",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://env.example.test/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=env-secret",
      PI_ORG_OTEL_ENABLED: options.disabled ? "false" : "true",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  expect(stderr).not.toContain("token");
  return JSON.parse(stdout) as Record<string, string>;
}

describe("real Pi adapter client config integration", () => {
  test("fetches once, applies remote precedence, and persists refresh without exposing it to Pi", async () => {
    requests = [];
    const environment = await launchSpec();
    expect(requests.filter((path) => path === "/api/v1/cli/config")).toHaveLength(1);
    expect(authorization).toBe("Bearer initial-token");
    expect(environment["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(`${server.url.origin}/api/v1/otel`);
    expect(environment["OTEL_EXPORTER_OTLP_PROTOCOL"]).toBe("http/protobuf");
    expect(environment["PI_ORG_OTEL_MANAGED_ENDPOINT"]).toBe(`${server.url.origin}/api/v1/otel`);
    expect(environment["PI_ORG_OTEL_MANAGED_HOME"]).toBe(root);
    expect(environment["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]).toBeUndefined();
    expect(environment["OTEL_EXPORTER_OTLP_HEADERS"]).toBeUndefined();
    const capability = environment["PI_DEPUTYDEV_AUTH_RELAY_KEY"];
    expect(capability).toBeString();
    expect(capability).not.toBe("rotated-token");
    expect(environment["LITELLM_API_KEY"]).toBe(capability);
    expect(environment["PI_MODEL_RECOMMENDER_API_KEY"]).toBe(capability);
    const relayOrigin = environment["PI_DEPUTYDEV_AUTH_RELAY_URL"];
    if (relayOrigin === undefined) throw new Error("Missing local auth relay origin");
    expect(new URL(relayOrigin).hostname).toBe("127.0.0.1");
    expect(environment["LITELLM_BASE_URL"]).toBe(`${relayOrigin}/litellm`);
    expect(environment["PI_MODEL_RECOMMENDER_URL"]).toBe(
      `${relayOrigin}/api/v1/model-recommendations`,
    );
    expect(await loadEncryptedSession(resolveDeputyDevPaths({ DEPUTYDEV_HOME: root }))).toBe(
      "rotated-token",
    );
  });

  test("config outage preserves env fallback without breaking the launch", async () => {
    mode = "failed";
    const environment = await launchSpec();
    expect(environment["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("https://env.example.test");
    expect(environment["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("authorization=env-secret");
    expect(environment["PI_ORG_OTEL_MANAGED_ENDPOINT"]).toBeUndefined();
    expect(environment["PI_ORG_OTEL_MANAGED_HOME"]).toBeUndefined();
    mode = "valid";
  });

  test("search policy is fetched for scripted and telemetry-disabled launches, but not offline or admin", async () => {
    for (const options of [
      { interactive: false },
      { offline: true },
      { disabled: true },
      { admin: true },
    ]) {
      requests = [];
      const environment = await launchSpec(options);
      if (options.offline || options.admin) {
        expect(requests).not.toContain("/api/v1/cli/config");
      } else {
        expect(requests.filter((path) => path === "/api/v1/cli/config")).toHaveLength(1);
      }
      if (options.offline || options.disabled)
        expect(environment["PI_ORG_OTEL_ENABLED"]).toBe("false");
    }
  });
});
