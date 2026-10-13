import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadEncryptedSession, saveEncryptedSession } from "../src/cli/auth/session.ts";
import {
  normalizeManifestPackages,
  resolveInstalledPackagePath,
} from "../src/harnesses/pi/setup/packages/manifest.ts";
import { AXON_MANIFEST } from "../src/product/manifest.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];
let authorization: string | null;
let mode: "valid" | "failed" | "switched" = "valid";
let codemodeEnabled: boolean | undefined = true;
let litellmMcpEnabled = true;
const projectRoot = resolve(import.meta.dir, "..");
const terminalPolicy = {
  yoloMode: false,
  allowYoloMode: true,
  autoApproveCommands: ["pwd", "git status"],
  requireApprovalCommands: ["git push"],
  blockedCommands: ["rm"],
  approvalTimeoutMs: 60_000,
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-pi-config-"));
  const paths = resolveAxonPaths({ AXON_HOME: root });
  await saveEncryptedSession(paths, "initial-token");
  const packages = normalizeManifestPackages(AXON_MANIFEST);
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
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/api/v1/cli/config") {
        authorization = request.headers.get("authorization");
        if (mode === "failed") return new Response("unavailable", { status: 503 });
        if (mode === "switched") await saveEncryptedSession(paths, "different-account-token");
        return Response.json(
          {
            schemaVersion: 1,
            ...(codemodeEnabled === undefined
              ? {}
              : { pi: { codemodeEnabled, litellmMcpEnabled } }),
            terminalPermissions: terminalPolicy,
            webSearch: {
              enabled: true,
              model: "gemini-3.8-flash",
              allowedModels: ["gemini-3.8-flash"],
              timeoutMs: 60000,
              maxQueryCharacters: 20000,
              maxResultCharacters: 30000,
              maxOutputTokens: 8192,
              maxSources: 20,
              temperature: 1,
              useUrlContext: false,
              requireGrounding: true,
            },
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
  options: {
    interactive?: boolean;
    offline?: boolean;
    disabled?: boolean;
    searchDisabled?: boolean;
    admin?: boolean;
    providerOffline?: boolean;
    discoveryDisabled?: boolean;
    piOfflineEnvironment?: string;
    userArguments?: readonly string[];
  } = {},
) {
  const script = [
    'import { createPiAdapter } from "./src/harnesses/pi/adapter.ts";',
    'import { resolveHarnessRegistration } from "./src/harnesses/registry.ts";',
    'import { resolveAxonPaths } from "./src/product/paths.ts";',
    'Object.defineProperty(process.stdin, "isTTY", { value: ' +
      (options.interactive !== false) +
      " });",
    'Object.defineProperty(process.stdout, "isTTY", { value: ' +
      (options.interactive !== false) +
      " });",
    'const context = { cwd: process.env.HOME, environment: process.env, paths: resolveAxonPaths(), registration: resolveHarnessRegistration("pi"), executable: "/unused" };',
    "const adapter = createPiAdapter();",
    "const args = " +
      JSON.stringify(
        options.userArguments ??
          (options.admin ? ["--help"] : options.offline ? ["--offline"] : ["hello"]),
      ) +
      ";",
    "await adapter.prepare(context, args);",
    "const spec = await adapter.buildLaunchSpec(context, args);",
    "console.log(JSON.stringify({ environment: spec.environment, arguments: spec.arguments }));",
    "spec.dispose?.();",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: root,
      CI: "false",
      AXON_HOME: root,
      AXON_SERVICE_ORIGIN: server.url.origin,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://env.example.test",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://env.example.test/v1/traces",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=env-secret",
      PI_ORG_OTEL_ENABLED: options.disabled ? "false" : "true",
      PI_WEB_SEARCH_ENABLED: options.searchDisabled ? "false" : "true",
      PI_TERMINAL_MANAGED_CONFIG: "inherited-marker",
      PI_OFFLINE: options.piOfflineEnvironment,
      LITELLM_OFFLINE: options.providerOffline ? "1" : undefined,
      LITELLM_DISCOVERY_TIMEOUT_MS: options.discoveryDisabled ? "0" : undefined,
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
  const spec = JSON.parse(stdout) as { environment: Record<string, string>; arguments: string[] };
  if (options.userArguments) {
    expect(spec.arguments.slice(-options.userArguments.length)).toEqual([...options.userArguments]);
  }
  return spec.environment;
}

describe("real Pi adapter client config integration", () => {
  test("fetches once, applies remote precedence, and persists refresh without exposing it to Pi", async () => {
    requests = [];
    const environment = await launchSpec();
    expect(requests.filter((path) => path === "/api/v1/cli/config")).toHaveLength(1);
    expect(authorization).toBe("Bearer initial-token");
    expect(JSON.parse(environment["PI_TERMINAL_MANAGED_CONFIG"] ?? "null")).toEqual(terminalPolicy);
    expect(environment["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(`${server.url.origin}/api/v1/otel`);
    expect(environment["OTEL_EXPORTER_OTLP_PROTOCOL"]).toBe("http/protobuf");
    expect(environment["PI_ORG_OTEL_MANAGED_ENDPOINT"]).toBe(`${server.url.origin}/api/v1/otel`);
    expect(environment["PI_ORG_OTEL_MANAGED_HOME"]).toBe(root);
    expect(environment["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]).toBeUndefined();
    expect(environment["OTEL_EXPORTER_OTLP_HEADERS"]).toBeUndefined();
    const capability = environment["PI_AXON_AUTH_RELAY_KEY"];
    expect(capability).toBeString();
    expect(capability).not.toBe("rotated-token");
    expect(environment["LITELLM_API_KEY"]).toBe(capability);
    expect(environment["PI_AXON_CONFIG_REFRESH_ENABLED"]).toBe("true");
    expect(environment["PI_MODEL_RECOMMENDER_API_KEY"]).toBe(capability);
    const relayOrigin = environment["PI_AXON_AUTH_RELAY_URL"];
    if (relayOrigin === undefined) throw new Error("Missing local auth relay origin");
    expect(new URL(relayOrigin).hostname).toBe("127.0.0.1");
    expect(environment["LITELLM_BASE_URL"]).toBe(`${relayOrigin}/litellm`);
    expect(environment["PI_WEB_SEARCH_URL"]).toBe(`${relayOrigin}/litellm/v1/chat/completions`);
    expect(environment["PI_WEB_SEARCH_API_KEY"]).toBe(capability);
    expect(environment["PI_WEB_SEARCH_MODEL"]).toBe("gemini-3.8-flash");
    expect(environment["PI_WEB_SEARCH_TEMPERATURE"]).toBe("1");
    expect(environment["PI_WEB_SEARCH_REQUIRE_GROUNDING"]).toBe("true");
    expect(environment["PI_WEB_SEARCH_MODE"]).toBeUndefined();
    expect(environment["PI_WEB_SEARCH_THINKING_LEVEL"]).toBeUndefined();
    expect(environment["PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE"]).toBeUndefined();
    expect(environment["PI_MODEL_RECOMMENDER_URL"]).toBe(
      `${relayOrigin}/api/v1/model-recommendations`,
    );
    const paths = resolveAxonPaths({ AXON_HOME: root });
    expect(await loadEncryptedSession(paths)).toBe("rotated-token");
    const settings = await Bun.file(join(paths.pi, "settings.json")).json();
    expect(settings.defaultTools).toEqual(["+codemode"]);
    expect(settings.litellm.mcp.enabled).toBe(true);
    expect(settings.codemode).toBeUndefined();
    expect(settings.packages).toEqual(
      normalizeManifestPackages(AXON_MANIFEST).map((entry) => entry.configuredSource),
    );
  });

  test("config outage preserves env fallback without breaking the launch", async () => {
    mode = "failed";
    const settingsPath = join(root, "pi", "settings.json");
    const settings = await Bun.file(settingsPath).text();
    const environment = await launchSpec();
    expect(await Bun.file(settingsPath).text()).toBe(settings);
    expect(environment["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("https://env.example.test");
    expect(environment["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("authorization=env-secret");
    expect(environment["PI_ORG_OTEL_MANAGED_ENDPOINT"]).toBeUndefined();
    expect(environment["PI_ORG_OTEL_MANAGED_HOME"]).toBeUndefined();
    expect(environment["PI_TERMINAL_MANAGED_CONFIG"]).toBeUndefined();
    mode = "valid";
  });

  test("defaults are fetched even with both features disabled, but not offline or admin", async () => {
    for (const options of [
      { interactive: false },
      { offline: true },
      { disabled: true },
      { disabled: true, searchDisabled: true },
      { admin: true },
    ]) {
      requests = [];
      const environment = await launchSpec(options);
      if (options.offline || options.admin) {
        expect(requests).not.toContain("/api/v1/cli/config");
        expect(environment["PI_TERMINAL_MANAGED_CONFIG"]).toBeUndefined();
      } else {
        expect(requests.filter((path) => path === "/api/v1/cli/config")).toHaveLength(1);
      }
      expect(environment["PI_AXON_CONFIG_REFRESH_ENABLED"]).toBe(
        options.admin ? undefined : options.offline ? "false" : "true",
      );
      if (options.offline || options.disabled)
        expect(environment["PI_ORG_OTEL_ENABLED"]).toBe("false");
      if (options.offline || options.searchDisabled)
        expect(environment["PI_WEB_SEARCH_ENABLED"]).toBe("false");
    }
  });

  test("backend config edits change startup defaults without checking or blocking CLI overrides", async () => {
    const settingsPath = join(root, "pi", "settings.json");
    try {
      for (const codemode of [true, false]) {
        for (const mcp of [true, false]) {
          codemodeEnabled = codemode;
          litellmMcpEnabled = mcp;
          await launchSpec({
            disabled: true,
            searchDisabled: true,
            userArguments: ["--tools", "read,bash", "hello"],
          });
          const settings = await Bun.file(settingsPath).json();
          expect(settings.defaultTools).toEqual([codemode ? "+codemode" : "-codemode"]);
          expect(settings.litellm.mcp.enabled).toBe(mcp);
        }
      }
    } finally {
      codemodeEnabled = true;
      litellmMcpEnabled = true;
    }
  });

  test("missing defaults, offline and administrative launches keep the last local default", async () => {
    const settingsPath = join(root, "pi", "settings.json");
    const settings = await Bun.file(settingsPath).text();
    codemodeEnabled = undefined;
    await launchSpec();
    expect(await Bun.file(settingsPath).text()).toBe(settings);
    codemodeEnabled = false;
    for (const options of [{ offline: true }, { admin: true }]) {
      await launchSpec(options);
      expect(await Bun.file(settingsPath).text()).toBe(settings);
    }
    codemodeEnabled = true;
  });

  test("does not persist defaults fetched for an account that changed during the request", async () => {
    mode = "switched";
    codemodeEnabled = false;
    const settingsPath = join(root, "pi", "settings.json");
    const settings = await Bun.file(settingsPath).text();
    try {
      const environment = await launchSpec();
      expect(await Bun.file(settingsPath).text()).toBe(settings);
      expect(environment["PI_TERMINAL_MANAGED_CONFIG"]).toBeUndefined();
      expect(await loadEncryptedSession(resolveAxonPaths({ AXON_HOME: root }))).toBe(
        "different-account-token",
      );
    } finally {
      mode = "valid";
      codemodeEnabled = true;
    }
  });

  test("removes obsolete relay models before an online Pi launch", async () => {
    const oldRelay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const cachePath = join(root, "pi", "models-store.json");
    const otherProvider = { models: [{ id: "keep" }], checkedAt: 123 };
    try {
      await Bun.write(
        cachePath,
        JSON.stringify({
          litellm: {
            models: [
              { id: "old", provider: "litellm", baseUrl: `${oldRelay.url.origin}/litellm/v1` },
            ],
          },
          openrouter: otherProvider,
        }),
      );
      const environment = await launchSpec();
      expect(environment["PI_AXON_AUTH_RELAY_URL"]).not.toBe(oldRelay.url.origin);
      expect(await Bun.file(cachePath).json()).toEqual({ openrouter: otherProvider });
    } finally {
      oldRelay.stop(true);
      await rm(cachePath, { force: true });
    }
  });

  test("offline, administrative, and discovery-disabled launches leave the model cache unchanged", async () => {
    const cachePath = join(root, "pi", "models-store.json");
    const content = JSON.stringify({
      litellm: {
        models: [{ id: "old", provider: "litellm", baseUrl: "http://127.0.0.1:54320/litellm/v1" }],
      },
    });
    try {
      for (const options of [
        { offline: true },
        { admin: true },
        { providerOffline: true },
        { discoveryDisabled: true },
        // The provider treats any PI_OFFLINE presence as disabling startup discovery.
        { piOfflineEnvironment: "false" },
      ]) {
        await Bun.write(cachePath, content);
        await launchSpec(options);
        expect(await Bun.file(cachePath).text()).toBe(content);
      }
    } finally {
      await rm(cachePath, { force: true });
    }
  });

  test("unsafe model cache is left untouched and does not block Pi startup", async () => {
    const cachePath = join(root, "pi", "models-store.json");
    try {
      await Bun.write(cachePath, "{malformed");
      const environment = await launchSpec();
      expect(environment["LITELLM_BASE_URL"]).toContain("/litellm");
      expect(await Bun.file(cachePath).text()).toBe("{malformed");
    } finally {
      await rm(cachePath, { force: true });
    }
  });
});
