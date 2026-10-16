import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { PI_INSTALL_VERSION, PI_PACKAGE_NAME } from "../src/harnesses/pi/installation.ts";
import {
  normalizeManifestPackages,
  resolveInstalledPackagePath,
} from "../src/harnesses/pi/setup/packages/manifest.ts";
import { AXON_MANIFEST, EMBEDDED_PI_RESOURCES } from "../src/product/manifest.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

async function output(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

// Compile the actual entrypoint: isolated manifest probes and source-mode tests
// miss Bun's collision between code imports and file-loader imports of one path.
test.each(["unminified", "minified"] as const)(
  "compiled Pi startup and setup materialize every embedded asset (%s)",
  async (mode) => {
    const minify = mode === "minified";
    const root = await mkdtemp(join(tmpdir(), "axon-compiled-resources-"));
    const projectRoot = resolve(import.meta.dir, "..");
    const paths = resolveAxonPaths({ AXON_HOME: join(root, "home"), HOME: root });
    const policy = {
      yoloMode: false,
      allowYoloMode: true,
      autoApproveCommands: ["git status"],
      requireApprovalCommands: [],
      blockedCommands: ["rm"],
      approvalTimeoutMs: 60_000,
    };
    let configRequests = 0;
    const exported: Buffer[] = [];
    const service = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/auth/verify-auth-token") {
          return Response.json({ status: "VERIFIED" });
        }
        if (path === "/api/v1/cli/config") {
          configRequests++;
          return Response.json({
            schemaVersion: 1,
            terminalPermissions: policy,
            compaction: { enabled: true, model: "litellm/summary", thresholdTokens: 80000 },
            modelRecommender: { enabled: true, autoSelectMs: 10000 },
            litellmClient: { discoveryTimeoutMs: 0, defaultContextWindow: 256000 },
            telemetry: { enabled: true, traceSampleRatio: 1, metricExportIntervalMs: 10000 },
          });
        }
        if (path.startsWith("/api/v1/otel/")) {
          exported.push(Buffer.from(await request.arrayBuffer()));
          return new Response(null, { headers: { "content-type": "application/x-protobuf" } });
        }
        return new Response(null, { status: 404 });
      },
    });
    try {
      const executable = join(root, "axon");
      const build = await output(
        Bun.spawn(
          [
            process.execPath,
            "build",
            "src/index.ts",
            "--compile",
            "--format=esm",
            "--bytecode",
            ...(minify ? ["--minify"] : []),
            "--sourcemap=external",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            "--define",
            'BUILD_VERSION="0.2.0"',
            "--define",
            'BUILD_KIND="dev"',
            "--define",
            `BUILD_SERVICE_ORIGIN=${JSON.stringify(service.url.origin)}`,
            "--outfile",
            executable,
          ],
          { cwd: projectRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ),
      );
      expect({ status: build.status, stderr: build.status === 0 ? "" : build.stderr }).toEqual({
        status: 0,
        stderr: "",
      });

      await saveEncryptedSession(paths, "compiled-resource-fixture-session");
      const runtime = join(paths.piRuntime, PI_INSTALL_VERSION, "node_modules");
      const pi = join(runtime, ".bin", "pi");
      await mkdir(join(runtime, PI_PACKAGE_NAME), { recursive: true });
      await mkdir(join(runtime, ".bin"), { recursive: true });
      await Bun.write(
        join(runtime, PI_PACKAGE_NAME, "package.json"),
        JSON.stringify({ name: PI_PACKAGE_NAME, version: PI_INSTALL_VERSION }),
      );
      await Bun.write(
        pi,
        `#!/usr/bin/env bun
if (process.argv[2] === "--version") {
  console.log(${JSON.stringify(PI_INSTALL_VERSION)});
} else {
  console.log(JSON.stringify({
    arguments: process.argv.slice(2),
    policy: JSON.parse(process.env.PI_TERMINAL_MANAGED_CONFIG ?? "null"),
    launchPreferences: Object.fromEntries(["PI_COMPACTION_ENABLED", "PI_COMPACTION_MODEL", "PI_COMPACTION_THRESHOLD_TOKENS", "PI_MODEL_RECOMMENDER_DISABLED", "PI_MODEL_RECOMMENDER_AUTO_SELECT_MS", "LITELLM_DISCOVERY_TIMEOUT_MS", "LITELLM_DEFAULT_CONTEXT_WINDOW", "PI_ORG_OTEL_ENABLED"].map(key => [key, process.env[key]])),
  }));
}
`,
      );
      await chmod(pi, 0o755);
      const packages = normalizeManifestPackages(AXON_MANIFEST);
      for (const entry of packages) {
        if (entry.sourceKind !== "npm" || entry.versionPolicy.kind !== "exact") {
          throw new Error(`Compiled resource fixture requires an exact npm package: ${entry.id}`);
        }
        const directory = resolveInstalledPackagePath(entry, paths.pi);
        await mkdir(directory, { recursive: true });
        await Bun.write(
          join(directory, "package.json"),
          JSON.stringify({ name: entry.packageName, version: entry.versionPolicy.version }),
        );
      }
      await Bun.write(
        join(paths.pi, "settings.json"),
        JSON.stringify({ packages: packages.map((entry) => entry.configuredSource) }),
      );
      const run = (args: string[]) =>
        output(
          Bun.spawn([executable, ...args], {
            cwd: root,
            env: {
              HOME: root,
              AXON_HOME: paths.home,
              AXON_DEBUG: "1",
              PI_ORG_OTEL_ENABLED: "false",
              OTEL_TRACES_SAMPLER: "always_off",
              PI_COMPACTION_ENABLED: "false",
              PI_COMPACTION_THRESHOLD_TOKENS: "1",
              PI_MODEL_RECOMMENDER_DISABLED: "true",
              LITELLM_DISCOVERY_TIMEOUT_MS: "5000",
              PATH: process.env["PATH"] ?? "",
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        );

      const launch = await run(["pi", "--print", "hello"]);
      expect({ status: launch.status, error: launch.status === 0 ? "" : launch.stderr }).toEqual({
        status: 0,
        error: "",
      });
      const launched = JSON.parse(launch.stdout) as {
        arguments: string[];
        policy: unknown;
        launchPreferences: unknown;
      };
      expect(launched.policy).toEqual(policy);
      expect(launched.launchPreferences).toEqual({
        PI_COMPACTION_ENABLED: "true",
        PI_COMPACTION_MODEL: "litellm/summary",
        PI_COMPACTION_THRESHOLD_TOKENS: "80000",
        PI_MODEL_RECOMMENDER_DISABLED: "false",
        PI_MODEL_RECOMMENDER_AUTO_SELECT_MS: "10000",
        LITELLM_DISCOVERY_TIMEOUT_MS: "0",
        LITELLM_DEFAULT_CONTEXT_WINDOW: "256000",
        PI_ORG_OTEL_ENABLED: "true",
      });
      expect(configRequests).toBe(1);
      expect(exported.some((body) => body.includes(Buffer.from("axon.startup.events")))).toBe(true);
      // Actual compiled process teardown must preserve help/administrative exemptions.
      const before = configRequests;
      expect((await run(["--help"])).status).toBe(0);
      expect((await run(["pi", "--help"])).status).toBe(0);
      const offline = await run(["pi", "--offline", "--print", "hello"]);
      // This fixture has no cached verification lease; offline preflight stays local.
      expect(offline.status).toBe(123);
      expect(offline.stderr).toContain("Cannot verify your Axon session while offline");
      expect(configRequests).toBe(before);
      expect(launched.arguments.slice(-2)).toEqual(["--print", "hello"]);
      const runtimeDirectory = join(paths.runtime, await readlink(paths.runtimeCurrent));
      for (const resource of EMBEDDED_PI_RESOURCES) {
        const path = join(runtimeDirectory, resource.destination);
        expect(launched.arguments).toContain(path);
        expect(await Bun.file(path).text()).toBe(await Bun.file(resource.sourcePath).text());
      }

      const setup = await run(["setup", "pi", "--sync-packages"]);
      expect({ status: setup.status, error: setup.status === 0 ? "" : setup.stderr }).toEqual({
        status: 0,
        error: "",
      });
      expect(setup.stdout).toContain("Pi resources ready:");
      expect(setup.stdout).toContain(`Pi required packages ready: ${packages.length}`);
    } finally {
      await service.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
