import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { PI_INSTALL_VERSION, PI_PACKAGE_NAME } from "../src/harnesses/pi/installation.ts";
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
const DEVELOPMENT_VERSION = PI_INSTALL_VERSION === "0.90.0" ? "0.91.0" : "0.90.0";

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "deputydev launcher "));
  fakeHarnessPath = join(fixtureDirectory, "fake harness");
  await Bun.write(
    fakeHarnessPath,
    `#!/usr/bin/env -S bun --no-env-file
import { mkdir } from "node:fs/promises";

const argumentsVector = process.argv.slice(2);
if (argumentsVector[0] === "--version") {
  console.log(process.env.FAKE_PI_VERSION ?? "${PI_INSTALL_VERSION}");
  process.exit(0);
}
const [action, source] = argumentsVector;
const managedInstallTargets = new Set(${JSON.stringify(
      normalizeManifestPackages(DEPUTYDEV_MANIFEST).map((entry) => entry.configuredSource),
    )});
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
      "PI_DEPUTYDEV_BACKUP_SERVICE_ORIGIN",
      "PI_DEPUTYDEV_BACKUP_HOME",
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
  for (const [home, version] of [
    [join(fixtureDirectory, ".deputydev"), PI_INSTALL_VERSION],
    ...["managed home", "resource home", "print home", "setup home", "signal home"].map((name) => [
      join(fixtureDirectory, name),
      PI_INSTALL_VERSION,
    ]),
    [join(fixtureDirectory, "dev home"), DEVELOPMENT_VERSION],
  ]) {
    if (home === undefined || version === undefined) throw new Error("invalid Pi test fixture");
    await saveEncryptedSession(resolveDeputyDevPaths({ DEPUTYDEV_HOME: home }), "fixture-session");
    const directory = join(home, "pi-runtime", version, "node_modules");
    const packageDirectory = join(directory, PI_PACKAGE_NAME);
    const binaryDirectory = join(directory, ".bin");
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(binaryDirectory, { recursive: true });
    await Bun.write(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name: PI_PACKAGE_NAME, version }),
    );
    await Bun.write(join(binaryDirectory, "pi"), Bun.file(fakeHarnessPath));
    await chmod(join(binaryDirectory, "pi"), 0o755);
  }
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
      DEPUTYDEV_DEBUG: "0",
      DEPUTYDEV_PIN: "1.2.3",
      PI_CODING_AGENT_DIR: "/inherited/pi",
      PI_CODING_AGENT_SESSION_DIR: "/inherited/pi/sessions",
      PI_SKIP_VERSION_CHECK: "0",
      PI_DEPUTYDEV_BACKUP_SERVICE_ORIGIN: "https://untrusted.example.test",
      PI_DEPUTYDEV_BACKUP_HOME: "/inherited/backup-home",
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
        PI_DEPUTYDEV_BACKUP_SERVICE_ORIGIN: "http://127.0.0.1:1",
        PI_DEPUTYDEV_BACKUP_HOME: deputyDevHome,
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
      "--extension",
      join(deputyDevHome, "runtime", activeRuntime, "pi", "extensions", "session-backup.mjs"),
      "hello",
    ]);
    expect(stdout.arguments[1]).not.toContain("/current/");
    expect(stdout.arguments[3]).not.toContain("/current/");
    expect(stdout.arguments[5]).not.toContain("/current/");
  });

  test("forwards Pi auth commands without setup arguments", async () => {
    const subprocess = runLauncher(["pi", "auth", "print-api-key", "--provider", "openai"]);
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
    const subprocess = runLauncher(["pi", "install", "npm:user-package"]);
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.arguments).toEqual(["install", "npm:user-package"]);
  });

  test("source runs use the developer's exact Pi version without touching global Pi", async () => {
    const home = join(fixtureDirectory, "dev home");
    const subprocess = runLauncher(["pi", "--help"], {
      DEPUTYDEV_HOME: home,
      DEPUTYDEV_PI_VERSION: DEVELOPMENT_VERSION,
      FAKE_PI_VERSION: DEVELOPMENT_VERSION,
    });
    const [stdout, status] = await Promise.all([
      new Response(subprocess.stdout).json() as Promise<{ arguments: string[] }>,
      subprocess.exited,
    ]);
    expect(status).toBe(0);
    expect(stdout.arguments).toEqual(["--help"]);
    expect(
      await Bun.file(
        join(home, "pi-runtime", DEVELOPMENT_VERSION, "node_modules", ".bin", "pi"),
      ).exists(),
    ).toBe(true);
  });

  test("doctor reports the isolated exact Pi executable without installing", async () => {
    await chmod(join(fixtureDirectory, ".deputydev"), 0o700);
    await installEmbeddedPiPackages(join(fixtureDirectory, ".deputydev"));
    const installed = runLauncher(["doctor", "pi"]);
    const [output, status] = await Promise.all([
      new Response(installed.stdout).text(),
      installed.exited,
    ]);
    expect(status).toBe(0);
    expect(output).toContain(`pi-runtime/${PI_INSTALL_VERSION}/node_modules/.bin/pi`);
    expect(output).toContain(`version ${PI_INSTALL_VERSION} (pinned)`);

    const absentHome = join(fixtureDirectory, "doctor missing home");
    await saveEncryptedSession(
      resolveDeputyDevPaths({ DEPUTYDEV_HOME: absentHome }),
      "fixture-session",
    );
    const absent = runLauncher(["doctor", "pi"], { DEPUTYDEV_HOME: absentHome });
    const [missingOutput, missingStatus] = await Promise.all([
      new Response(absent.stdout).text(),
      absent.exited,
    ]);
    expect(missingStatus).toBe(121);
    expect(missingOutput).toContain(`managed Pi ${PI_INSTALL_VERSION} is unavailable`);
    expect(await Bun.file(join(absentHome, "pi-runtime", PI_INSTALL_VERSION)).exists()).toBe(false);
  });

  test("blocks every forwarded Pi update before resolving or installing Pi", async () => {
    for (const argumentsVector of [
      ["pi", "update"],
      ["pi", "update", "--self"],
      ["pi", "update", "--all"],
      ["pi", "update", "--extensions"],
      ["pi", "update", "--models"],
      ["pi", "update", "npm:example"],
    ]) {
      const subprocess = runLauncher(argumentsVector, {
        DEPUTYDEV_HOME: join(fixtureDirectory, "no installed Pi"),
      });
      const [stderr, status] = await Promise.all([
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      expect(status).toBe(120);
      expect(stderr).toContain("ddcli pi update is disabled");
    }
  });

  test("runs explicit Pi setup", async () => {
    const deputyDevHome = join(fixtureDirectory, "setup home");
    const subprocess = runLauncher(["setup", "pi", "--sync-packages"], {
      DEPUTYDEV_HOME: deputyDevHome,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    expect(exitCode).toBe(0);
    for (const entry of normalizeManifestPackages(DEPUTYDEV_MANIFEST)) {
      expect(stderr).toContain(`Installing ${entry.configuredSource}...`);
    }
    expect(stdout).toContain("Pi resources ready:");
    expect(stdout).toContain("Pi required packages ready: 2");
  });

  test("passes through the Pi child exit code", async () => {
    const subprocess = runLauncher(["pi", "--help"], {
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
    expect(missingStatus).toBe(123);
  });
});
