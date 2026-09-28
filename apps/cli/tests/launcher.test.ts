import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  normalizeManifestPackages,
  resolveInstalledPackagePath,
} from "../src/harnesses/pi/setup/packages/manifest.ts";
import { resolveHarnessRegistration } from "../src/harnesses/registry.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";
import { DEPUTYDEV_MANIFEST } from "../src/product/manifest.ts";
import { resolveDeputyDevPaths } from "../src/product/paths.ts";

const projectRoot = resolve(import.meta.dir, "..");
let fixtureDirectory: string;
let fakeHarnessPath: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "deputydev launcher "));
  fakeHarnessPath = join(fixtureDirectory, "fake harness");
  await Bun.write(
    fakeHarnessPath,
    `#!/usr/bin/env -S bun --no-env-file
import { mkdir } from "node:fs/promises";

const argumentsVector = process.argv.slice(2);
const [action, source] = argumentsVector;
const managedInstallTargets = new Set([
  "npm:pi-mcp-adapter@2.34.0",
  "npm:@juicesharp/rpiv-ask-user-question",
  "npm:pi-provider-litellm@3.0.1",
]);
if (action === "install" && source !== undefined && managedInstallTargets.has(source)) {
  const packageSource = source.slice("npm:".length);
  const versionSeparator = packageSource.lastIndexOf("@");
  const hasVersion = versionSeparator > 0;
  const name = hasVersion ? packageSource.slice(0, versionSeparator) : packageSource;
  const requestedVersion = hasVersion ? packageSource.slice(versionSeparator + 1) : undefined;
  const version = requestedVersion?.match(/^\\d+\\.\\d+\\.\\d+(?:[-+].*)?$/)
    ? requestedVersion
    : "1.0.0";
  const packagePath = process.env.PI_CODING_AGENT_DIR + "/npm/node_modules/" + name;
  await mkdir(packagePath, { recursive: true });
  await Bun.write(packagePath + "/package.json", JSON.stringify({ name, version }));
  process.exit(0);
}

console.log(JSON.stringify({
  arguments: argumentsVector,
  deputyDevEnvironment: Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith("DEPUTYDEV_")),
  ),
  harnessEnvironment: Object.fromEntries(
    Object.entries(process.env).filter(([name]) => [
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_SKIP_VERSION_CHECK",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "OPENCODE_API_KEY",
      "LITELLM_API_KEY",
      "LITELLM_BASE_URL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "PI_ORG_OTEL_ENABLED",
    ].includes(name)),
  ),
  cwd: process.cwd(),
}));
const signal = process.env.FAKE_SIGNAL;
if (signal !== undefined) {
  process.kill(process.pid, signal);
}
process.exit(Number(process.env.FAKE_EXIT_CODE ?? "0"));
`,
  );
  await chmod(fakeHarnessPath, 0o755);
});

afterAll(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true });
});

async function installEmbeddedPiPackages(deputyDevHome: string): Promise<void> {
  const piAgentDirectory = join(deputyDevHome, "pi");
  const packages = normalizeManifestPackages(DEPUTYDEV_MANIFEST);

  for (const packageEntry of packages) {
    if (packageEntry.packageName === undefined) {
      throw new Error(`launcher fixture supports only npm packages: ${packageEntry.id}`);
    }
    const version =
      packageEntry.versionPolicy.kind === "floating" ? "1.0.0" : packageEntry.versionPolicy.version;
    if (version === undefined) {
      throw new Error(`launcher fixture requires an npm version: ${packageEntry.id}`);
    }
    const packagePath = resolveInstalledPackagePath(packageEntry, piAgentDirectory);
    await mkdir(packagePath, { recursive: true });
    await Bun.write(
      join(packagePath, "package.json"),
      JSON.stringify({ name: packageEntry.packageName, version }),
    );
  }

  await mkdir(piAgentDirectory, { recursive: true });
  await Bun.write(
    join(piAgentDirectory, "settings.json"),
    JSON.stringify({ packages: packages.map((packageEntry) => packageEntry.configuredSource) }),
  );
}

function runLauncher(
  argumentsVector: readonly string[],
  environment: Record<string, string> = {},
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, "--no-env-file", "src/index.ts", ...argumentsVector], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: fixtureDirectory,
      DEPUTYDEV_SERVICE_ORIGIN: "http://127.0.0.1:1",
      ...environment,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("harness registry", () => {
  test("registers only Pi", () => {
    expect(resolveHarnessRegistration("pi")?.id).toBe("pi");
    expect(resolveHarnessRegistration("pi")?.executableCandidates).toEqual(["pi"]);
    expect(resolveHarnessRegistration("opencode")).toBeUndefined();
    expect(resolveHarnessRegistration("opencode2")).toBeUndefined();
    expect(resolveHarnessRegistration("unknown")).toBeUndefined();
  });
});

describe("harness environment", () => {
  test("strips every DeputyDev variable and retains unrelated credentials", () => {
    const environment = createHarnessEnvironment({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "provider-secret",
      DEPUTYDEV_DEBUG: "1",
      DEPUTYDEV_PIN: "1.2.3",
      DEPUTYDEV_FUTURE_INTERNAL_CONTROL: "hidden",
    });

    expect(environment).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "provider-secret",
    });
  });

  test("applies ordered overrides and explicit removals without mutating inputs", () => {
    const inheritedEnvironment = {
      PATH: "/bin",
      REMOVE_ME: "inherited",
      REPLACE_ME: "inherited",
    };
    const firstLayer = {
      ADDED: "first",
      REPLACE_ME: "first",
    };
    const secondLayer = {
      ADDED: "second",
      REMOVE_ME: undefined,
    };

    const environment = createHarnessEnvironment(inheritedEnvironment, firstLayer, secondLayer);

    expect(environment).toEqual({
      PATH: "/bin",
      ADDED: "second",
      REPLACE_ME: "first",
    });
    expect(inheritedEnvironment).toEqual({
      PATH: "/bin",
      REMOVE_ME: "inherited",
      REPLACE_ME: "inherited",
    });
    expect(firstLayer).toEqual({ ADDED: "first", REPLACE_ME: "first" });
    expect(secondLayer).toEqual({ ADDED: "second", REMOVE_ME: undefined });
  });
});

describe("managed paths", () => {
  test("resolves dedicated Pi agent and session directories without creating legacy paths", () => {
    const paths = resolveDeputyDevPaths({ DEPUTYDEV_HOME: "/managed/deputydev" });

    expect(paths.pi).toBe("/managed/deputydev/pi");
    expect(paths.piSessions).toBe("/managed/deputydev/pi/sessions");
    expect(Object.keys(paths)).not.toContain("profiles");
    expect(Object.keys(paths)).not.toContain("opencodeStateRoot");
  });
});

test("rejects a manifest with a removed harness section", () => {
  expect(() =>
    normalizeManifestPackages({
      schemaVersion: 1,
      revision: "test",
      pi: { packages: [], resources: [] },
      opencode: { plugins: [], resources: [] },
    }),
  ).toThrow();
});

describe("launcher dispatch", () => {
  test("preserves Pi arguments and applies its isolated environment", async () => {
    const userArguments = ["--help", "--", "", "line one\nline two", "-leading-dash"];
    const deputyDevHome = join(fixtureDirectory, "managed home");
    const subprocess = runLauncher(["pi", ...userArguments], {
      DEPUTYDEV_HOME: deputyDevHome,
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
      DEPUTYDEV_DEBUG: "0",
      DEPUTYDEV_PIN: "1.2.3",
      PI_CODING_AGENT_DIR: "/inherited/pi",
      PI_CODING_AGENT_SESSION_DIR: "/inherited/pi/sessions",
      PI_SKIP_VERSION_CHECK: "0",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      GEMINI_API_KEY: "gemini-secret",
      OPENCODE_API_KEY: "provider-secret",
      LITELLM_API_KEY: "litellm-token",
      LITELLM_BASE_URL: "https://litellm.example",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
      PI_ORG_OTEL_ENABLED: "true",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toEqual({
      arguments: userArguments,
      deputyDevEnvironment: {},
      harnessEnvironment: {
        PI_CODING_AGENT_DIR: join(deputyDevHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: join(deputyDevHome, "pi", "sessions"),
        PI_SKIP_VERSION_CHECK: "1",
        LITELLM_API_KEY: "litellm-token",
        LITELLM_BASE_URL: "https://litellm.example",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
        PI_ORG_OTEL_ENABLED: "true",
      },
      cwd: projectRoot,
    });
  });

  test("injects the materialized DeputyDev extension for an ordinary Pi launch", async () => {
    const deputyDevHome = join(fixtureDirectory, "resource home");
    await installEmbeddedPiPackages(deputyDevHome);
    const subprocess = runLauncher(["pi", "hello"], {
      DEPUTYDEV_HOME: deputyDevHome,
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    // Pi is pointed at the immutable content-addressed runtime, never at the
    // mutable runtime/current symlink that another launcher version could repoint.
    const activeRuntime = await readlink(join(deputyDevHome, "runtime", "current"));
    expect(activeRuntime).not.toBe("current");
    expect(stdout.arguments).toEqual([
      "--extension",
      join(deputyDevHome, "runtime", activeRuntime, "pi", "extensions", "deputydev.ts"),
      "--extension",
      join(deputyDevHome, "runtime", activeRuntime, "pi", "extensions", "pi-org-telemetry.mjs"),
      "--extension",
      join(deputyDevHome, "runtime", activeRuntime, "pi", "extensions", "model-recommender.ts"),
      "hello",
    ]);
    expect(stdout.arguments[1]).not.toContain("/current/");
    expect(stdout.arguments[3]).not.toContain("/current/");
    expect(stdout.arguments[5]).not.toContain("/current/");
  });

  test("forwards Pi auth commands without setup arguments", async () => {
    const subprocess = runLauncher(["pi", "auth", "print-api-key", "--provider", "openai"], {
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.arguments).toEqual(["auth", "print-api-key", "--provider", "openai"]);
  });

  test("skips the organization MCP request for non-interactive launches", async () => {
    const deputyDevHome = join(fixtureDirectory, "print home");
    await installEmbeddedPiPackages(deputyDevHome);
    const subprocess = runLauncher(["pi", "-p", "hello"], {
      DEPUTYDEV_HOME: deputyDevHome,
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.arguments.slice(-2)).toEqual(["-p", "hello"]);
    expect(await Bun.file(join(deputyDevHome, "pi-mcp-sync.json")).exists()).toBe(false);
  });

  test("keeps forwarded Pi package commands free of setup arguments", async () => {
    const subprocess = runLauncher(["pi", "install", "npm:user-package"], {
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.arguments).toEqual(["install", "npm:user-package"]);
  });

  test("runs explicit Pi setup", async () => {
    const deputyDevHome = join(fixtureDirectory, "setup home");
    const subprocess = runLauncher(["setup", "pi", "--sync-packages"], {
      DEPUTYDEV_HOME: deputyDevHome,
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("Installing npm:pi-mcp-adapter@2.34.0...");
    expect(stderr).toContain("Installing npm:@juicesharp/rpiv-ask-user-question...");
    expect(stderr).toContain("Installing npm:pi-provider-litellm@3.0.1...");
    expect(stdout).toContain("Pi resources ready:");
    expect(stdout).toContain("Pi required packages ready: 3");
  });

  test("passes through the Pi child exit code", async () => {
    const subprocess = runLauncher(["pi", "--help"], {
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
      FAKE_EXIT_CODE: "42",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);

    expect(exitCode).toBe(42);
    expect(stdout.arguments).toEqual(["--help"]);
  });

  test("lists and advertises only Pi, rejecting removed harness commands", async () => {
    const harnesses = runLauncher(["harnesses"]);
    const help = runLauncher(["--help"]);
    const removed = runLauncher(["opencode2"], {
      DEPUTYDEV_OPENCODE_BIN: fakeHarnessPath,
    });
    const removedDoctor = runLauncher(["doctor", "opencode"]);
    const removedOption = runLauncher(["uninstall", "--remove-profiles"]);
    const [harnessesOutput, helpOutput, removedStatus, doctorStatus, optionStatus] =
      await Promise.all([
        new Response(harnesses.stdout).text(),
        new Response(help.stdout).text(),
        removed.exited,
        removedDoctor.exited,
        removedOption.exited,
      ]);

    expect(await harnesses.exited).toBe(0);
    expect(harnessesOutput.trim()).toBe("pi");
    expect(await help.exited).toBe(0);
    expect(helpOutput).toContain("ddcli pi [pi arguments...]");
    expect(helpOutput).not.toContain("opencode");
    expect(removedStatus).toBe(120);
    expect(doctorStatus).toBe(120);
    expect(optionStatus).toBe(120);
  });

  test("re-raises a child termination signal", async () => {
    const deputyDevHome = join(fixtureDirectory, "signal home");
    await installEmbeddedPiPackages(deputyDevHome);
    const subprocess = runLauncher(["pi"], {
      DEPUTYDEV_HOME: deputyDevHome,
      DEPUTYDEV_PI_BIN: fakeHarnessPath,
      FAKE_SIGNAL: "SIGTERM",
    });

    await subprocess.exited;

    expect(subprocess.signalCode).toBe("SIGTERM");
    expect(subprocess.exitCode).toBeNull();
  });

  test("uses reserved launcher statuses before a harness starts", async () => {
    const unknown = runLauncher(["not-a-command"]);
    const missingExecutable = runLauncher(["pi"], {
      DEPUTYDEV_PI_BIN: join(fixtureDirectory, "missing"),
    });

    const [unknownStatus, missingStatus] = await Promise.all([
      unknown.exited,
      missingExecutable.exited,
    ]);

    expect(unknownStatus).toBe(120);
    expect(missingStatus).toBe(121);
  });
});
