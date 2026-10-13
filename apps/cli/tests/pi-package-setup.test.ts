import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectPiPackages } from "../src/harnesses/pi/setup/packages/doctor.ts";
import {
  classifyPiInvocation,
  isPiOffline,
  type PiInvocationEnvironment,
} from "../src/harnesses/pi/setup/packages/invocation.ts";
import {
  type AxonManifest,
  normalizeManifestPackages,
  parseAxonManifest,
  resolveInstalledPackagePath,
} from "../src/harnesses/pi/setup/packages/manifest.ts";
import { readPiSettings } from "../src/harnesses/pi/setup/packages/settings.ts";
import { readPiPackageState } from "../src/harnesses/pi/setup/packages/state.ts";
import { synchronizePiPackages } from "../src/harnesses/pi/setup/packages/sync.ts";
import { materializePiResources } from "../src/harnesses/pi/setup/resources.ts";
import { resolveHarnessRegistration } from "../src/harnesses/registry.ts";
import type { HarnessLaunchContext } from "../src/launcher/contracts.ts";
import { withFileLock } from "../src/launcher/file-lock.ts";
import { AXON_MANIFEST, EMBEDDED_PI_RESOURCES } from "../src/product/manifest.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "axon-pi-packages-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true });
});

function createContext(name: string, executable: string = "/usr/bin/false"): HarnessLaunchContext {
  const environment = {
    HOME: fixtureDirectory,
    PATH: Reflect.get(process.env, "PATH") as string,
    AXON_HOME: join(fixtureDirectory, name),
  };
  const registration = resolveHarnessRegistration("pi");
  if (registration === undefined) {
    throw new Error("Pi registration missing");
  }
  return {
    cwd: fixtureDirectory,
    environment,
    executable,
    paths: resolveAxonPaths(environment),
    registration,
  };
}

function manifest(
  packages: readonly Record<string, unknown>[],
  revision: string = "test",
): AxonManifest {
  return parseAxonManifest({
    schemaVersion: 1,
    revision,
    pi: { packages, resources: [] },
  });
}

function exactPackage(version: string, revokedVersions: readonly string[] = []) {
  return {
    id: "required-tools",
    source: "npm:@example/pi-tools",
    required: true,
    versionPolicy: { kind: "exact", version },
    install: { action: "pi.install" },
    revokedVersions,
  } as const;
}

function minimumPackage(version: string) {
  return {
    id: "minimum-tools",
    source: "npm:minimum-tools",
    required: true,
    versionPolicy: { kind: "minimum", version },
    install: { action: "pi.install" },
    updates: { owner: "pi-or-user" },
  } as const;
}

function floatingPackage() {
  return {
    id: "floating-tools",
    source: "npm:floating-tools",
    required: true,
    versionPolicy: { kind: "floating" },
    install: { action: "pi.install" },
    updates: { owner: "pi-or-user" },
  } as const;
}

async function writeNpmPackage(
  context: HarnessLaunchContext,
  packageManifest: AxonManifest,
  version: string,
): Promise<void> {
  const packageEntry = normalizeManifestPackages(packageManifest)[0];
  if (packageEntry === undefined) {
    throw new Error("test package missing");
  }
  const path = resolveInstalledPackagePath(packageEntry, context.paths.pi);
  await mkdir(path, { recursive: true });
  await Bun.write(
    join(path, "package.json"),
    JSON.stringify({ name: packageEntry.packageName, version }),
  );
}

async function writeSettings(
  context: HarnessLaunchContext,
  packages: readonly unknown[],
): Promise<void> {
  await mkdir(context.paths.pi, { recursive: true });
  await Bun.write(
    join(context.paths.pi, "settings.json"),
    `${JSON.stringify({ theme: "user-theme", packages }, null, 2)}\n`,
  );
}

async function settingsPackages(context: HarnessLaunchContext): Promise<readonly unknown[]> {
  return (await readPiSettings(join(context.paths.pi, "settings.json"))).packages;
}

const interactive: PiInvocationEnvironment = {
  ci: false,
  stdinIsTty: true,
  stdoutIsTty: true,
};

describe("Pi package manifest", () => {
  test("declares the embedded install targets and update ownership", () => {
    const packages = normalizeManifestPackages(AXON_MANIFEST);

    expect(
      packages.map((entry) => ({
        id: entry.id,
        installTarget: entry.configuredSource,
        updateOwner: entry.updates?.owner ?? "axon",
        versionPolicy: entry.versionPolicy,
      })),
    ).toEqual([
      {
        id: "rpiv-ask-user-question",
        installTarget: "npm:@juicesharp/rpiv-ask-user-question@2.12.0",
        updateOwner: "axon",
        versionPolicy: { kind: "exact", version: "2.12.0" },
      },
      {
        id: "pi-provider-litellm",
        installTarget: "npm:pi-provider-litellm@4.2.0",
        updateOwner: "axon",
        versionPolicy: { kind: "exact", version: "4.2.0" },
      },
    ]);
  });

  test("retires the legacy MCP adapter from previously managed installs", async () => {
    const context = createContext("retired-mcp-adapter");
    const legacyManifest = manifest(
      [
        {
          id: "pi-mcp-adapter",
          source: "npm:pi-mcp-adapter",
          required: true,
          versionPolicy: { kind: "exact", version: "2.34.0" },
          install: { action: "pi.install" },
        },
      ],
      "legacy-mcp-adapter",
    );
    const legacyPackage = normalizeManifestPackages(legacyManifest)[0];
    if (legacyPackage === undefined) throw new Error("legacy MCP adapter entry missing");
    await writeNpmPackage(context, legacyManifest, "2.34.0");
    await writeSettings(context, ["npm:pi-mcp-adapter@2.34.0"]);
    await synchronizePiPackages({ allowInstall: false, context, manifest: legacyManifest });

    const actions: string[] = [];
    const installedPath = resolveInstalledPackagePath(legacyPackage, context.paths.pi);
    await synchronizePiPackages({
      allowInstall: false,
      context,
      manifest: manifest([], "without-mcp-adapter"),
      runAction: async ({ action, source }) => {
        actions.push(`${action}:${source}`);
        await rm(installedPath, { force: true, recursive: true });
        return { exitCode: 0 };
      },
    });

    expect(actions).toEqual(["remove:npm:pi-mcp-adapter@2.34.0"]);
    expect(await Bun.file(installedPath).exists()).toBe(false);
    expect(await settingsPackages(context)).toEqual([]);
    expect(Object.keys((await readPiPackageState(context.paths.piPackageState)).packages)).toEqual(
      [],
    );
    expect(
      normalizeManifestPackages(AXON_MANIFEST).some((entry) => entry.id === "pi-mcp-adapter"),
    ).toBe(false);
  });

  test("normalizes exact, minimum, and floating npm install sources", () => {
    const packages = normalizeManifestPackages(
      manifest([exactPackage("1.4.2"), minimumPackage("2.3.0"), floatingPackage()]),
    );

    expect(packages.map((entry) => entry.configuredSource)).toEqual([
      "npm:@example/pi-tools@1.4.2",
      "npm:minimum-tools@>=2.3.0",
      "npm:floating-tools",
    ]);
  });

  test("rejects arbitrary actions, versioned base sources, duplicates, and git minimums", () => {
    expect(() =>
      manifest([
        {
          ...exactPackage("1.0.0"),
          install: { action: "shell.exec" },
        },
      ]),
    ).toThrow();
    expect(() =>
      manifest([{ ...exactPackage("1.0.0"), source: "npm:@example/pi-tools@1.0.0" }]),
    ).toThrow();
    expect(() => manifest([exactPackage("1.0.0"), exactPackage("1.0.0")])).toThrow();
    expect(() =>
      manifest([
        {
          ...minimumPackage("1.0.0"),
          source: "git:github.com/example/pi-tools",
        },
      ]),
    ).toThrow();
  });

  test("accepts an immutable exact git commit", () => {
    const [packageEntry] = normalizeManifestPackages(
      manifest([
        {
          id: "git-tools",
          source: "git:github.com/example/pi-tools",
          required: true,
          versionPolicy: { kind: "exact", commit: "a".repeat(40) },
          install: { action: "pi.install" },
        },
      ]),
    );

    expect(packageEntry?.identity).toBe("git:github.com/example/pi-tools");
    expect(packageEntry?.configuredSource).toBe(
      `git:github.com/example/pi-tools@${"a".repeat(40)}`,
    );
  });
});

describe("Pi invocation policy", () => {
  test("classifies administrative, interactive, and non-interactive launches", () => {
    expect(classifyPiInvocation(["install", "npm:pkg"], interactive)).toBe("administrative");
    expect(classifyPiInvocation(["--help"], interactive)).toBe("administrative");
    expect(classifyPiInvocation([], interactive)).toBe("interactive");
    expect(classifyPiInvocation(["-p", "hello"], interactive)).toBe("noninteractive");
    expect(classifyPiInvocation([], { ...interactive, stdoutIsTty: false })).toBe("noninteractive");
    expect(classifyPiInvocation(["--mode", "json"], interactive)).toBe("noninteractive");
    expect(classifyPiInvocation([], { ...interactive, ci: true })).toBe("noninteractive");
  });

  test("forwards Pi auth and experimental commands untouched", () => {
    expect(
      classifyPiInvocation(["auth", "print-api-key", "--provider", "openai"], interactive),
    ).toBe("administrative");
    expect(classifyPiInvocation(["server"], interactive)).toBe("administrative");
    expect(classifyPiInvocation(["client", "list"], interactive)).toBe("administrative");
  });

  test("ignores tokens after the Pi option terminator", () => {
    expect(classifyPiInvocation(["--", "--help"], interactive)).toBe("interactive");
    expect(classifyPiInvocation(["--", "-p"], interactive)).toBe("interactive");
    expect(classifyPiInvocation(["--", "--mode", "json"], interactive)).toBe("interactive");
    expect(classifyPiInvocation(["-p", "--", "--help"], interactive)).toBe("noninteractive");
    expect(classifyPiInvocation(["--help", "--", "x"], interactive)).toBe("administrative");
  });

  test("detects Pi offline mode from the flag or the environment", () => {
    expect(isPiOffline({}, ["--offline"])).toBe(true);
    expect(isPiOffline({ PI_OFFLINE: "1" }, [])).toBe(true);
    expect(isPiOffline({ PI_OFFLINE: "true" }, [])).toBe(true);
    expect(isPiOffline({ PI_OFFLINE: "0" }, [])).toBe(false);
    expect(isPiOffline({}, ["--", "--offline"])).toBe(false);
    expect(isPiOffline({}, ["hello"])).toBe(false);
  });
});

describe("Pi package doctor", () => {
  test("reports a wrong exact version as an error unless a verified fallback exists", async () => {
    const context = createContext("doctor-fallback");
    const oldManifest = manifest([exactPackage("1.0.0")]);
    const newManifest = manifest([exactPackage("1.4.2")], "bumped");
    const revokingManifest = manifest([exactPackage("1.4.2", ["1.0.0"])], "revoked");
    await writeNpmPackage(context, oldManifest, "1.0.0");
    await writeSettings(context, ["npm:@example/pi-tools@1.0.0"]);

    // Nothing verified yet: an installed-but-wrong version is an error.
    const unverified = await inspectPiPackages(context, newManifest);
    expect(unverified.map((finding) => finding.level)).toEqual(["error"]);
    expect(unverified[0]?.message).toContain("does not satisfy policy");

    // Verify 1.0.0 under the old manifest, then evaluate the bumped manifest.
    await synchronizePiPackages({
      allowInstall: false,
      context,
      manifest: oldManifest,
      runAction: async () => ({ exitCode: 1 }),
    });
    const fallback = await inspectPiPackages(context, newManifest);
    expect(fallback.map((finding) => finding.level)).toEqual(["warning"]);
    expect(fallback[0]?.message).toContain("using last verified version 1.0.0");

    const revoked = await inspectPiPackages(context, revokingManifest);
    expect(revoked.map((finding) => finding.level)).toEqual(["error"]);
  });
});

describe("Pi package synchronization", () => {
  test("uses a local-only warm path for a verified exact package", async () => {
    const context = createContext("exact-warm");
    const packageManifest = manifest([exactPackage("1.4.2")]);
    await writeNpmPackage(context, packageManifest, "1.4.2");
    await writeSettings(context, ["npm:@example/pi-tools@1.4.2"]);
    let actionCalls = 0;
    const runAction = async () => {
      actionCalls += 1;
      return { exitCode: 0 };
    };

    const first = await synchronizePiPackages({
      allowInstall: false,
      context,
      manifest: packageManifest,
      runAction,
    });
    const second = await synchronizePiPackages({
      allowInstall: false,
      context,
      manifest: packageManifest,
      runAction,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(actionCalls).toBe(0);
  });

  test("installs a missing exact package and preserves unrelated settings", async () => {
    const context = createContext("exact-install");
    const packageManifest = manifest([exactPackage("1.4.2")]);
    await writeSettings(context, ["npm:user-package"]);
    const actions: string[] = [];

    await synchronizePiPackages({
      allowInstall: true,
      context,
      manifest: packageManifest,
      runAction: async ({ action, source }) => {
        actions.push(`${action}:${source}`);
        await writeNpmPackage(context, packageManifest, "1.4.2");
        return { exitCode: 0 };
      },
    });

    expect(actions).toEqual(["install:npm:@example/pi-tools@1.4.2"]);
    expect(await settingsPackages(context)).toEqual([
      "npm:user-package",
      "npm:@example/pi-tools@1.4.2",
    ]);
    const settings = JSON.parse(await Bun.file(join(context.paths.pi, "settings.json")).text()) as {
      theme: string;
    };
    expect(settings.theme).toBe("user-theme");
  });

  test("enforces a minimum floor without downgrading a higher version", async () => {
    const context = createContext("minimum-higher");
    const packageManifest = manifest([minimumPackage("2.3.0")]);
    await writeNpmPackage(context, packageManifest, "4.0.0");
    await writeSettings(context, ["npm:minimum-tools"]);
    let actionCalls = 0;

    await synchronizePiPackages({
      allowInstall: true,
      context,
      manifest: packageManifest,
      runAction: async () => {
        actionCalls += 1;
        return { exitCode: 0 };
      },
    });

    expect(actionCalls).toBe(0);
    expect(await settingsPackages(context)).toEqual(["npm:minimum-tools@>=2.3.0"]);
    const state = await readPiPackageState(context.paths.piPackageState);
    expect(state.packages["npm:minimum-tools"]?.installedVersion).toBe("4.0.0");
  });

  test("repairs a package below the minimum floor", async () => {
    const context = createContext("minimum-repair");
    const packageManifest = manifest([minimumPackage("2.3.0")]);
    await writeNpmPackage(context, packageManifest, "2.2.9");
    await writeSettings(context, ["npm:minimum-tools@>=1.0.0"]);

    await synchronizePiPackages({
      allowInstall: true,
      context,
      manifest: packageManifest,
      runAction: async ({ source }) => {
        expect(source).toBe("npm:minimum-tools@>=2.3.0");
        await writeNpmPackage(context, packageManifest, "2.3.0");
        return { exitCode: 0 };
      },
    });

    expect(await settingsPackages(context)).toEqual(["npm:minimum-tools@>=2.3.0"]);
  });

  test("accepts a Pi-updated floating version without running an action", async () => {
    const context = createContext("floating-update");
    const packageManifest = manifest([floatingPackage()]);
    await writeNpmPackage(context, packageManifest, "1.0.0");
    await writeSettings(context, ["npm:floating-tools"]);
    await synchronizePiPackages({ allowInstall: false, context, manifest: packageManifest });

    await writeNpmPackage(context, packageManifest, "2.0.0");
    let actionCalls = 0;
    await synchronizePiPackages({
      allowInstall: false,
      context,
      manifest: packageManifest,
      runAction: async () => {
        actionCalls += 1;
        return { exitCode: 0 };
      },
    });

    expect(actionCalls).toBe(0);
    const state = await readPiPackageState(context.paths.piPackageState);
    expect(state.packages["npm:floating-tools"]?.installedVersion).toBe("2.0.0");
  });

  test("restores a filtered required package entry", async () => {
    const context = createContext("filtered-entry");
    const packageManifest = manifest([floatingPackage()]);
    await writeNpmPackage(context, packageManifest, "1.0.0");
    await writeSettings(context, [
      { source: "npm:floating-tools@1.0.0", extensions: [], skills: [] },
      "npm:user-package",
    ]);

    await synchronizePiPackages({ allowInstall: false, context, manifest: packageManifest });

    expect(await settingsPackages(context)).toEqual(["npm:floating-tools", "npm:user-package"]);
  });

  test("blocks non-interactive first installation", async () => {
    const context = createContext("noninteractive-missing");
    const packageManifest = manifest([floatingPackage()]);

    await expect(
      synchronizePiPackages({
        allowInstall: false,
        context,
        manifest: packageManifest,
      }),
    ).rejects.toMatchObject({ exitStatus: 123 });
  });

  test("uses a verified exact fallback after an upgrade failure", async () => {
    const context = createContext("exact-fallback");
    const oldManifest = manifest([exactPackage("1.0.0")], "old");
    await writeNpmPackage(context, oldManifest, "1.0.0");
    await writeSettings(context, ["npm:@example/pi-tools@1.0.0"]);
    await synchronizePiPackages({ allowInstall: false, context, manifest: oldManifest });

    const result = await synchronizePiPackages({
      allowInstall: true,
      context,
      manifest: manifest([exactPackage("2.0.0")], "new"),
      runAction: async () => ({ exitCode: 1 }),
    });

    expect(result.warnings.join(" ")).toContain("last verified");
    expect(await settingsPackages(context)).toEqual(["npm:@example/pi-tools@1.0.0"]);

    let noninteractiveActions = 0;
    const warmFallback = await synchronizePiPackages({
      allowInstall: false,
      context,
      manifest: manifest([exactPackage("2.0.0")], "new"),
      runAction: async () => {
        noninteractiveActions += 1;
        return { exitCode: 1 };
      },
    });
    expect(warmFallback.changed).toBe(false);
    expect(warmFallback.warnings.join(" ")).toContain("last verified");
    expect(noninteractiveActions).toBe(0);
  });

  test("does not use a revoked exact fallback or a below-minimum fallback", async () => {
    const exactContext = createContext("revoked-fallback");
    const oldManifest = manifest([exactPackage("1.0.0")], "old");
    await writeNpmPackage(exactContext, oldManifest, "1.0.0");
    await writeSettings(exactContext, ["npm:@example/pi-tools@1.0.0"]);
    await synchronizePiPackages({
      allowInstall: false,
      context: exactContext,
      manifest: oldManifest,
    });

    await expect(
      synchronizePiPackages({
        allowInstall: true,
        context: exactContext,
        manifest: manifest([exactPackage("2.0.0", ["1.0.0"])], "new"),
        runAction: async () => ({ exitCode: 1 }),
      }),
    ).rejects.toMatchObject({ exitStatus: 123 });

    const minimumContext = createContext("minimum-no-fallback");
    const minimumManifest = manifest([minimumPackage("2.0.0")]);
    await writeNpmPackage(minimumContext, minimumManifest, "1.9.9");
    await writeSettings(minimumContext, ["npm:minimum-tools@>=1.0.0"]);
    await expect(
      synchronizePiPackages({
        allowInstall: false,
        context: minimumContext,
        manifest: minimumManifest,
      }),
    ).rejects.toMatchObject({ exitStatus: 123 });
  });

  test("removes an unchanged retired package but preserves an adopted one", async () => {
    const removedContext = createContext("retired-remove");
    const packageManifest = manifest([floatingPackage()], "with-package");
    await writeNpmPackage(removedContext, packageManifest, "1.0.0");
    await writeSettings(removedContext, ["npm:floating-tools"]);
    await synchronizePiPackages({
      allowInstall: false,
      context: removedContext,
      manifest: packageManifest,
    });
    const actions: string[] = [];
    await synchronizePiPackages({
      allowInstall: true,
      context: removedContext,
      manifest: manifest([], "without-package"),
      runAction: async ({ action, source }) => {
        actions.push(`${action}:${source}`);
        const retired = normalizeManifestPackages(packageManifest)[0];
        if (retired !== undefined) {
          await rm(resolveInstalledPackagePath(retired, removedContext.paths.pi), {
            force: true,
            recursive: true,
          });
        }
        return { exitCode: 0 };
      },
    });
    expect(actions).toEqual(["remove:npm:floating-tools"]);
    expect(await settingsPackages(removedContext)).toEqual([]);

    const adoptedContext = createContext("retired-adopted");
    await writeNpmPackage(adoptedContext, packageManifest, "1.0.0");
    await writeSettings(adoptedContext, ["npm:floating-tools"]);
    await synchronizePiPackages({
      allowInstall: false,
      context: adoptedContext,
      manifest: packageManifest,
    });
    await writeSettings(adoptedContext, [{ source: "npm:floating-tools", skills: [] }]);
    let adoptedActions = 0;
    const result = await synchronizePiPackages({
      allowInstall: true,
      context: adoptedContext,
      manifest: manifest([], "without-package"),
      runAction: async () => {
        adoptedActions += 1;
        return { exitCode: 0 };
      },
    });
    expect(adoptedActions).toBe(0);
    expect(result.warnings.join(" ")).toContain("preserved user-modified");
    expect(await settingsPackages(adoptedContext)).toEqual([
      { source: "npm:floating-tools", skills: [] },
    ]);
  });

  test("serializes concurrent first installs and rechecks after locking", async () => {
    const context = createContext("concurrent-install");
    const packageManifest = manifest([exactPackage("1.0.0")]);
    let installCalls = 0;
    const runAction = async () => {
      installCalls += 1;
      await Bun.sleep(50);
      await writeNpmPackage(context, packageManifest, "1.0.0");
      return { exitCode: 0 };
    };

    await Promise.all([
      synchronizePiPackages({ allowInstall: true, context, manifest: packageManifest, runAction }),
      synchronizePiPackages({ allowInstall: true, context, manifest: packageManifest, runAction }),
    ]);

    expect(installCalls).toBe(1);
  });

  test("runs the real Pi subprocess with isolated environment and strict argv", async () => {
    const contextBase = createContext("direct-subprocess");
    const fakePi = join(contextBase.paths.home, "fake-pi");
    const recordPath = join(contextBase.paths.home, "record.json");
    await mkdir(dirname(fakePi), { recursive: true });
    await Bun.write(
      fakePi,
      `#!/usr/bin/env -S bun --no-env-file
import { mkdir } from "node:fs/promises";
const [action, source] = process.argv.slice(2);
await Bun.write(process.env.FAKE_RECORD, JSON.stringify({
  action,
  source,
  piDir: process.env.PI_CODING_AGENT_DIR,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  skipVersion: process.env.PI_SKIP_VERSION_CHECK,
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
}));
const name = source.replace(/^npm:/, "").replace(/@[^@]+$/, "");
const packagePath = process.env.PI_CODING_AGENT_DIR + "/npm/node_modules/" + name;
await mkdir(packagePath, { recursive: true });
await Bun.write(packagePath + "/package.json", JSON.stringify({ name, version: "1.0.0" }));
`,
    );
    await chmod(fakePi, 0o755);
    const context: HarnessLaunchContext = {
      ...contextBase,
      executable: fakePi,
      environment: {
        ...contextBase.environment,
        FAKE_RECORD: recordPath,
        ANTHROPIC_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
      },
    };

    await synchronizePiPackages({
      allowInstall: true,
      context,
      manifest: manifest([exactPackage("1.0.0")]),
    });

    expect(await Bun.file(recordPath).json()).toEqual({
      action: "install",
      source: "npm:@example/pi-tools@1.0.0",
      piDir: context.paths.pi,
      sessionDir: context.paths.piSessions,
      skipVersion: "1",
    });
  });
});

describe("package and resource locks", () => {
  test("recovers a stale same-user lock", async () => {
    const lockPath = join(fixtureDirectory, "stale-lock");
    await mkdir(lockPath, { recursive: true });
    await Bun.write(
      join(lockPath, "owner.json"),
      JSON.stringify({ createdAt: 1, pid: 999_999_999, token: "stale" }),
    );
    await utimes(lockPath, new Date(1), new Date(1));

    const value = await withFileLock(lockPath, async () => "acquired", {
      staleAfterMs: 1,
      timeoutMs: 500,
    });

    expect(value).toBe("acquired");
  });

  test("materializes embedded resources once and activates runtime/current", async () => {
    const context = createContext("resources");
    const first = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
    const second = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);

    expect(second.hash).toBe(first.hash);
    expect(await readlink(context.paths.runtimeCurrent)).toContain(first.hash.slice(0, 16));
    expect(first.arguments).toHaveLength(EMBEDDED_PI_RESOURCES.length * 2);
    const materializedPaths = first.arguments.filter((_argument, index) => index % 2 === 1);
    expect(materializedPaths.map((path) => path.split("/").at(-1))).toEqual([
      "managed-config.ts",
      "axon.ts",
      "pi-org-telemetry.mjs",
      "model-recommender.ts",
      "session-backup.mjs",
      "web-search.ts",
      "git-ai.ts",
      "compaction.ts",
      "terminal-permissions.ts",
      "axon-dark.json",
      "axon-light.json",
    ]);
    expect(first.arguments.filter((argument) => argument === "--theme")).toHaveLength(2);
    for (const path of materializedPaths) {
      expect(await Bun.file(path).exists()).toBe(true);
    }
  });

  test("refuses to replace a non-symlink runtime/current", async () => {
    const context = createContext("unsafe-current");
    await mkdir(context.paths.runtime, { recursive: true });
    await mkdir(context.paths.runtimeCurrent);
    await symlink("unused", join(context.paths.runtime, "other-link"));

    await expect(materializePiResources(context.paths, EMBEDDED_PI_RESOURCES)).rejects.toThrow(
      "not a symlink",
    );
  });
});
