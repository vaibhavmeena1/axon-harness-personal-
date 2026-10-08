import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPiVersion } from "../scripts/check-pi-version.ts";
import {
  managedPiExecutable,
  PI_INSTALL_VERSION,
  PI_PACKAGE_NAME,
  PI_RELEASES_API,
  type PiReleaseArtifacts,
  type PiToolchain,
  resolveConfiguredPiVersion,
  resolvePiExecutable,
  validatePiReleaseArtifacts,
} from "../src/harnesses/pi/installation.ts";
import { resolvePiVersion } from "../src/harnesses/pi/version.ts";
import { resolveHarnessRegistration } from "../src/harnesses/registry.ts";
import type { HarnessRegistration, LaunchContext } from "../src/launcher/contracts.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const fixtureRoots: string[] = [];
const DEVELOPMENT_VERSION = PI_INSTALL_VERSION === "0.90.0" ? "0.91.0" : "0.90.0";

async function writePi(path: string, version: string): Promise<void> {
  await Bun.write(path, `#!/bin/sh\necho "${version}"\n`);
  await chmod(path, 0o755);
}

async function createFixture(name: string): Promise<{
  readonly bin: string;
  readonly context: LaunchContext;
  readonly home: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `axon-pi-install-${name}-`));
  fixtureRoots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(bin, { recursive: true })]);
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: bin,
    AXON_HOME: join(root, "axon"),
  };
  return {
    root,
    home,
    bin,
    context: {
      cwd: root,
      environment,
      paths: resolveAxonPaths(environment, home),
    },
  };
}

function piRegistration(): HarnessRegistration {
  const registration = resolveHarnessRegistration("pi");
  if (registration === undefined) {
    throw new Error("Pi registration is missing");
  }
  return registration;
}

const PI_TARBALL_INTEGRITY = "sha512-first-party-fixture";

function releaseArtifacts(version: string): PiReleaseArtifacts {
  const piEntry = `node_modules/${PI_PACKAGE_NAME}`;
  const tarball = `https://registry.npmjs.org/${PI_PACKAGE_NAME}/-/pi-coding-agent-${version}.tgz`;
  return {
    // Like the live API: first-party tarball hashes live in the metadata, not the lockfile.
    metadata: JSON.stringify({
      schemaVersion: 1,
      version,
      packages: [{ name: PI_PACKAGE_NAME, version, tarball, integrity: PI_TARBALL_INTEGRITY }],
    }),
    packageJson: JSON.stringify({
      name: "pi-managed-install",
      version,
      dependencies: { [PI_PACKAGE_NAME]: version },
    }),
    packageLock: JSON.stringify({
      name: "pi-managed-install",
      version,
      lockfileVersion: 3,
      packages: {
        "": { version, dependencies: { [PI_PACKAGE_NAME]: version } },
        [piEntry]: { version, resolved: tarball },
        "node_modules/third-party": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/third-party/-/third-party-1.0.0.tgz",
          integrity: "sha512-third-party-fixture",
        },
      },
    }),
  };
}

const healthyToolchain: PiToolchain = {
  nodePath: "/fixture/node",
  nodeVersion: "22.19.0",
  npmPath: "/fixture/npm",
};

function installerDependencies(fixture: { readonly root: string }, version: string) {
  const state = { fetched: [] as string[], npmRuns: 0 };
  const dependencies = {
    fetchArtifact: async (url: string) => {
      state.fetched.push(url);
      const artifacts = releaseArtifacts(version);
      if (url.endsWith("/package.json")) {
        return artifacts.packageJson;
      }
      return url.endsWith("/package-lock.json") ? artifacts.packageLock : artifacts.metadata;
    },
    probeToolchain: async () => healthyToolchain,
    runNpmCi: async (request: { readonly cwd: string; readonly npmPath: string }) => {
      state.npmRuns += 1;
      expect(request.npmPath).toBe("/fixture/npm");
      // npm ci receives the lockfile completed with first-party integrity hashes.
      const stagedLock = JSON.parse(
        await Bun.file(join(request.cwd, "package-lock.json")).text(),
      ) as {
        packages: Record<string, { integrity?: string }>;
      };
      expect(stagedLock.packages[`node_modules/${PI_PACKAGE_NAME}`]?.integrity).toBe(
        PI_TARBALL_INTEGRITY,
      );
      expect(request.cwd.startsWith(join(fixture.root, "axon", "pi-runtime"))).toBe(true);
      const packageDirectory = join(request.cwd, "node_modules", PI_PACKAGE_NAME);
      await mkdir(packageDirectory, { recursive: true });
      await Bun.write(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name: PI_PACKAGE_NAME, version }),
      );
      await mkdir(join(request.cwd, "node_modules", ".bin"), { recursive: true });
      await writePi(join(request.cwd, "node_modules", ".bin", "pi"), version);
    },
  };
  return { dependencies, state };
}

const launchOptions = { userArguments: [], allowInstall: true } as const;

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Pi version policy", () => {
  test("checks the default against typecheck dependencies before building", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axon-pi-config-"));
    fixtureRoots.push(directory);
    await Bun.write(join(directory, "pi-version.json"), JSON.stringify({ version: "0.90.0" }));
    await Bun.write(
      join(directory, "package.json"),
      JSON.stringify({
        devDependencies: {
          "@earendil-works/pi-coding-agent": "0.85.0",
          "@earendil-works/pi-tui": "0.90.0",
        },
      }),
    );
    await expect(checkPiVersion(directory)).rejects.toThrow("must match pi-version.json");
    await Bun.write(join(directory, "pi-version.json"), JSON.stringify({ version: "latest" }));
    await expect(checkPiVersion(directory)).rejects.toThrow();
  });

  test("allows exact-version overrides in source runs but pins built CLIs", async () => {
    expect(await checkPiVersion(join(import.meta.dir, ".."))).toBe(PI_INSTALL_VERSION);
    expect(resolveConfiguredPiVersion({})).toBe(PI_INSTALL_VERSION);
    expect(resolveConfiguredPiVersion({ AXON_PI_VERSION: DEVELOPMENT_VERSION })).toBe(
      DEVELOPMENT_VERSION,
    );
    expect(resolveConfiguredPiVersion({ AXON_PI_VERSION: PI_INSTALL_VERSION }, false)).toBe(
      PI_INSTALL_VERSION,
    );
    expect(() =>
      resolveConfiguredPiVersion({ AXON_PI_VERSION: DEVELOPMENT_VERSION }, false),
    ).toThrow("cannot override pinned Pi");
    for (const version of ["latest", "1.2.3; rm -rf", " "]) {
      expect(() => resolveConfiguredPiVersion({ AXON_PI_VERSION: version })).toThrow(
        "is not a valid Pi version",
      );
    }
  });

  test("validates release artifacts the way Pi's managed installer does", () => {
    const good = releaseArtifacts("0.85.1");
    const completed = JSON.parse(validatePiReleaseArtifacts(good, "0.85.1")) as {
      packages: Record<string, { integrity?: string }>;
    };
    expect(completed.packages[`node_modules/${PI_PACKAGE_NAME}`]?.integrity).toBe(
      PI_TARBALL_INTEGRITY,
    );
    expect(completed.packages["node_modules/third-party"]?.integrity).toBe(
      "sha512-third-party-fixture",
    );
    expect(() => validatePiReleaseArtifacts(good, "0.85.0")).toThrow("must describe");

    const metadataMismatch = JSON.parse(good.metadata) as { version: string };
    metadataMismatch.version = "0.85.0";
    expect(() =>
      validatePiReleaseArtifacts({ ...good, metadata: JSON.stringify(metadataMismatch) }, "0.85.1"),
    ).toThrow("metadata must describe");

    const noMetadataIntegrity = JSON.parse(good.metadata) as {
      packages: { integrity?: string }[];
    };
    delete noMetadataIntegrity.packages[0]?.integrity;
    expect(() =>
      validatePiReleaseArtifacts(
        { ...good, metadata: JSON.stringify(noMetadataIntegrity) },
        "0.85.1",
      ),
    ).toThrow("lacks an integrity hash");

    const lockV2 = JSON.parse(good.packageLock) as { lockfileVersion: number };
    lockV2.lockfileVersion = 2;
    expect(() =>
      validatePiReleaseArtifacts({ ...good, packageLock: JSON.stringify(lockV2) }, "0.85.1"),
    ).toThrow("lockfileVersion 3");

    const noIntegrity = JSON.parse(good.packageLock) as {
      packages: Record<string, { integrity?: string }>;
    };
    delete noIntegrity.packages["node_modules/third-party"]?.integrity;
    expect(() =>
      validatePiReleaseArtifacts({ ...good, packageLock: JSON.stringify(noIntegrity) }, "0.85.1"),
    ).toThrow("lacks an integrity hash: node_modules/third-party");

    expect(() =>
      validatePiReleaseArtifacts({ ...good, packageJson: "not json" }, "0.85.1"),
    ).toThrow("not valid JSON");
  });
});

describe("Pi version probe cache", () => {
  test("probes once per executable identity and never caches unknown versions", async () => {
    const fixture = await createFixture("probe");
    const executable = join(fixture.bin, "pi");
    await writePi(executable, "0.85.1");
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return probes === 1 ? undefined : "0.85.1";
    };

    expect(await resolvePiVersion(executable, fixture.context, { probe })).toBeUndefined();
    expect(await resolvePiVersion(executable, fixture.context, { probe })).toBe("0.85.1");
    expect(await resolvePiVersion(executable, fixture.context, { probe })).toBe("0.85.1");
    expect(probes).toBe(2);
    expect(await Bun.file(fixture.context.paths.piExecutableState).exists()).toBe(true);

    // A changed executable invalidates the cached record.
    await Bun.sleep(5);
    await writePi(executable, "0.86.0 with a longer banner line\n");
    expect(await resolvePiVersion(executable, fixture.context)).toBe("0.86.0");
  });
});

describe("Pi executable resolution", () => {
  test("ignores even an exact-version PATH pi and installs an isolated copy", async () => {
    const fixture = await createFixture("compatible");
    const executable = join(fixture.bin, "pi");
    await writePi(executable, PI_INSTALL_VERSION);
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      launchOptions,
      dependencies,
    );

    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION));
    expect(state.npmRuns).toBe(1);
    expect(await Bun.file(executable).text()).toContain(PI_INSTALL_VERSION);
  });

  test("ignores an older PATH pi and reuses the pinned release afterwards", async () => {
    const fixture = await createFixture("too-old");
    await writePi(join(fixture.bin, "pi"), "0.80.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);
    const registration = piRegistration();

    const resolved = await resolvePiExecutable(
      fixture.context,
      registration,
      launchOptions,
      dependencies,
    );

    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION));
    expect(state.fetched.sort()).toEqual([
      `${PI_RELEASES_API}/${PI_INSTALL_VERSION}`,
      `${PI_RELEASES_API}/${PI_INSTALL_VERSION}/package-lock.json`,
      `${PI_RELEASES_API}/${PI_INSTALL_VERSION}/package.json`,
    ]);
    expect(state.npmRuns).toBe(1);
    expect(await Bun.file(resolved).exists()).toBe(true);

    const again = await resolvePiExecutable(
      fixture.context,
      registration,
      launchOptions,
      dependencies,
    );
    expect(again).toBe(resolved);
    expect(state.fetched).toHaveLength(3);
    expect(state.npmRuns).toBe(1);
  });

  test("ignores a newer PATH pi", async () => {
    const fixture = await createFixture("newer");
    await writePi(join(fixture.bin, "pi"), "0.90.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);
    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      launchOptions,
      dependencies,
    );
    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION));
    expect(state.npmRuns).toBe(1);
  });

  test("routes Pi administration through the managed version too", async () => {
    const fixture = await createFixture("administrative");
    await writePi(join(fixture.bin, "pi"), "0.80.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);
    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      { userArguments: ["install", "npm:example"], allowInstall: true },
      dependencies,
    );
    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION));
    expect(state.npmRuns).toBe(1);
  });

  test("rejects executable overrides before installing", async () => {
    const fixture = await createFixture("override");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);
    Reflect.set(fixture.context.environment, "AXON_PI_BIN", join(fixture.root, "custom pi"));
    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, dependencies),
    ).rejects.toThrow("cannot override pinned Pi");
    expect(state.npmRuns).toBe(0);
  });

  test("installs an exact development override into its own directory", async () => {
    const fixture = await createFixture("dev-version");
    Reflect.set(fixture.context.environment, "AXON_PI_VERSION", DEVELOPMENT_VERSION);
    const { dependencies, state } = installerDependencies(fixture, DEVELOPMENT_VERSION);
    const resolved = await resolvePiExecutable(
      fixture.context,
      piRegistration(),
      launchOptions,
      dependencies,
    );
    expect(resolved).toBe(managedPiExecutable(fixture.context.paths, DEVELOPMENT_VERSION));
    expect(state.fetched).toContain(`${PI_RELEASES_API}/${DEVELOPMENT_VERSION}`);
  });

  test("refuses a managed install whose executable reports another version", async () => {
    const fixture = await createFixture("mismatch");
    const directory = join(fixture.context.paths.piRuntime, PI_INSTALL_VERSION);
    const binary = managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION);
    await mkdir(join(directory, "node_modules", PI_PACKAGE_NAME), { recursive: true });
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    await Bun.write(
      join(directory, "node_modules", PI_PACKAGE_NAME, "package.json"),
      JSON.stringify({ name: PI_PACKAGE_NAME, version: PI_INSTALL_VERSION }),
    );
    await writePi(binary, DEVELOPMENT_VERSION);
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);
    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, dependencies),
    ).rejects.toMatchObject({
      exitStatus: 121,
      message: expect.stringContaining("does not match pinned version"),
    });
    expect(state.fetched).toEqual([]);
    expect(await Bun.file(binary).text()).toContain(DEVELOPMENT_VERSION);
  });

  test("never installs for diagnostics or offline launches", async () => {
    const fixture = await createFixture("no-install");
    await writePi(join(fixture.bin, "pi"), "0.80.0");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    await expect(
      resolvePiExecutable(
        fixture.context,
        piRegistration(),
        { userArguments: [], allowInstall: false },
        dependencies,
      ),
    ).rejects.toMatchObject({ exitStatus: 121 });
    await expect(
      resolvePiExecutable(
        fixture.context,
        piRegistration(),
        { userArguments: ["--offline"], allowInstall: true },
        dependencies,
      ),
    ).rejects.toMatchObject({ exitStatus: 121 });
    expect(state.fetched).toEqual([]);
  });

  test("explains a missing or old Node.js toolchain without downloading", async () => {
    const fixture = await createFixture("toolchain");
    const { dependencies, state } = installerDependencies(fixture, PI_INSTALL_VERSION);

    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, {
        ...dependencies,
        probeToolchain: async () => ({ nodePath: "/fixture/node", nodeVersion: "20.0.0" }),
      }),
    ).rejects.toMatchObject({
      exitStatus: 125,
      message: expect.stringContaining("Node.js 20.0.0 is older than 22.19.0"),
      remediation: expect.stringContaining("https://pi.dev/install.sh"),
    });
    expect(state.fetched).toEqual([]);
  });

  test("rejects a staged executable reporting a different version", async () => {
    const fixture = await createFixture("bad-executable");
    const { dependencies } = installerDependencies(fixture, PI_INSTALL_VERSION);
    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, {
        ...dependencies,
        probeVersion: async () => DEVELOPMENT_VERSION,
      }),
    ).rejects.toMatchObject({
      exitStatus: 123,
      message: `failed to install Pi ${PI_INSTALL_VERSION}`,
    });
    expect(
      await Bun.file(managedPiExecutable(fixture.context.paths, PI_INSTALL_VERSION)).exists(),
    ).toBe(false);
  });

  test("fails clearly when the installed tree does not match the pinned version", async () => {
    const fixture = await createFixture("bad-tree");
    const { dependencies } = installerDependencies(fixture, PI_INSTALL_VERSION);

    await expect(
      resolvePiExecutable(fixture.context, piRegistration(), launchOptions, {
        ...dependencies,
        runNpmCi: async () => {},
      }),
    ).rejects.toMatchObject({
      exitStatus: 123,
      message: `failed to install Pi ${PI_INSTALL_VERSION}`,
    });
    expect(await Bun.file(fixture.context.paths.piRuntime).exists()).toBe(false);
  });
});
