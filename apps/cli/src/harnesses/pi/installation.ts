import { chmod, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import piVersion from "../../../pi-version.json";
import { BUILD_INFO } from "../../build-info.ts";
import type {
  DoctorFinding,
  ExecutableResolutionOptions,
  HarnessRegistration,
  LaunchContext,
} from "../../launcher/contracts.ts";
import { createHarnessEnvironment } from "../../launcher/environment.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { isExecutableFile, resolveCommandOnPath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { withFileLock } from "../../launcher/file-lock.ts";
import { compareSemVer, isSemVer, parseFirstSemVer } from "../../launcher/version.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { createPiEnvironment } from "./environment.ts";
import { isPiOffline } from "./setup/packages/invocation.ts";
import { type PiVersionProber, probePiVersion, resolvePiVersion } from "./version.ts";

/** Only Pi release that Axon installs and executes. Independent of the user's PATH Pi. */
export const PI_INSTALL_VERSION: string = piVersion.version;
export const PI_VERSION_ENVIRONMENT_VARIABLE = "AXON_PI_VERSION";
export const PI_RELEASES_API = "https://pi.dev/api/installer/releases";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_MINIMUM_NODE_VERSION = "22.19.0";
export const PI_OFFICIAL_INSTALLER_COMMAND = "curl -fsSL https://pi.dev/install.sh | sh";

const ARTIFACT_TIMEOUT_MS = 30_000;
const MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;
const TOOLCHAIN_PROBE_TIMEOUT_MS = 5_000;

export interface PiToolchain {
  readonly nodePath?: string;
  readonly nodeVersion?: string;
  readonly npmPath?: string;
}

export interface PiNpmCiRequest {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly npmPath: string;
}

export interface PiInstallationDependencies {
  readonly fetchArtifact?: (url: string) => Promise<string>;
  readonly probeToolchain?: (context: LaunchContext) => Promise<PiToolchain>;
  readonly probeVersion?: PiVersionProber;
  readonly runNpmCi?: (request: PiNpmCiRequest) => Promise<void>;
}

export interface PiReleaseArtifacts {
  /** `GET <releases>/<version>`: release metadata with first-party tarball integrity. */
  readonly metadata: string;
  readonly packageJson: string;
  readonly packageLock: string;
}

function setupRemediation(): string {
  return `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`;
}

export function resolveConfiguredPiVersion(
  environment: NodeJS.ProcessEnv,
  sourceRun: boolean = BUILD_INFO.isSourceRun,
): string {
  if (!isSemVer(PI_INSTALL_VERSION)) {
    throw new LauncherError(
      "pi-version.json must contain an exact Pi release version",
      LAUNCHER_EXIT_STATUS.profileFailure,
    );
  }
  const configured = environment[PI_VERSION_ENVIRONMENT_VARIABLE]?.trim();
  if (configured !== undefined && !isSemVer(configured)) {
    throw new LauncherError(
      `${PI_VERSION_ENVIRONMENT_VARIABLE} is not a valid Pi version: ${JSON.stringify(configured)}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation: `Set ${PI_VERSION_ENVIRONMENT_VARIABLE} to an exact Pi release version or unset it.`,
      },
    );
  }
  if (configured !== undefined && configured !== PI_INSTALL_VERSION && !sourceRun) {
    throw new LauncherError(
      `${PI_VERSION_ENVIRONMENT_VARIABLE} cannot override pinned Pi ${PI_INSTALL_VERSION} in a built CLI`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation: `Unset ${PI_VERSION_ENVIRONMENT_VARIABLE}; Pi changes in built CLIs require a new release.`,
      },
    );
  }
  return configured ?? PI_INSTALL_VERSION;
}

export function managedPiDirectory(paths: AxonPaths, version: string): string {
  return join(paths.piRuntime, version);
}

export function managedPiExecutable(paths: AxonPaths, version: string): string {
  return join(managedPiDirectory(paths, version), "node_modules", ".bin", "pi");
}

export function isManagedPiExecutable(paths: AxonPaths, executable: string): boolean {
  return executable.startsWith(`${paths.piRuntime}/`);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Apply the same checks Pi's own managed installer applies before `npm ci`:
 * both artifacts must describe exactly `${PI_PACKAGE_NAME}@${version}` with a
 * lockfile v3 whose resolved entries all carry integrity hashes.
 */
interface ReleasePackageJson {
  readonly version?: unknown;
  readonly dependencies?: unknown;
}

interface ReleaseLockEntry {
  version?: unknown;
  dependencies?: unknown;
  resolved?: unknown;
  integrity?: unknown;
}

interface ReleasePackageLock {
  readonly version?: unknown;
  readonly lockfileVersion?: unknown;
  readonly packages?: unknown;
}

interface ReleaseMetadataPackage {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly tarball?: unknown;
  readonly integrity?: unknown;
}

interface ReleaseMetadata {
  readonly version?: unknown;
  readonly packages?: unknown;
}

function asDependencyMap(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Pi release ${label} is not valid JSON`);
  }
}

/**
 * Apply the checks Pi's own managed installer applies before `npm ci`, then
 * close the gap it leaves open: the published lockfile omits `integrity` for
 * the first-party `@earendil-works` tarballs, while the release metadata
 * carries their SHA-512 hashes. Those hashes are merged into the lockfile so
 * `npm ci` verifies every resolved tarball. Returns the completed lockfile.
 */
export function validatePiReleaseArtifacts(artifacts: PiReleaseArtifacts, version: string): string {
  const parsedPackageJson = parseJson(artifacts.packageJson, "package.json");
  const parsedPackageLock = parseJson(artifacts.packageLock, "package-lock.json");
  const parsedMetadata = parseJson(artifacts.metadata, "metadata");
  if (
    !isJsonObject(parsedPackageJson) ||
    !isJsonObject(parsedPackageLock) ||
    !isJsonObject(parsedMetadata)
  ) {
    throw new Error("Pi release artifacts must be JSON objects");
  }
  const packageJson = parsedPackageJson as ReleasePackageJson;
  const packageLock = parsedPackageLock as ReleasePackageLock;
  const metadata = parsedMetadata as ReleaseMetadata;

  const dependencies = asDependencyMap(packageJson.dependencies);
  if (
    packageJson.version !== version ||
    dependencies === undefined ||
    dependencies[PI_PACKAGE_NAME] !== version
  ) {
    throw new Error(`Pi release package.json must describe ${PI_PACKAGE_NAME}@${version}`);
  }
  if (packageLock.lockfileVersion !== 3) {
    throw new Error("Pi release package-lock.json must use lockfileVersion 3");
  }
  if (!isJsonObject(packageLock.packages)) {
    throw new Error("Pi release package-lock.json has no packages map");
  }
  const packages = packageLock.packages as Record<string, ReleaseLockEntry | undefined>;
  const root = packages[""];
  const rootDependencies = asDependencyMap(root?.dependencies);
  if (
    packageLock.version !== version ||
    root?.version !== version ||
    rootDependencies === undefined ||
    rootDependencies[PI_PACKAGE_NAME] !== version
  ) {
    throw new Error(
      `Pi release package-lock.json root must describe ${PI_PACKAGE_NAME}@${version}`,
    );
  }
  if (packages[`node_modules/${PI_PACKAGE_NAME}`]?.version !== version) {
    throw new Error(`Pi release package-lock.json does not include ${PI_PACKAGE_NAME}@${version}`);
  }

  if (metadata.version !== version || !Array.isArray(metadata.packages)) {
    throw new Error(`Pi release metadata must describe version ${version}`);
  }
  for (const candidate of metadata.packages as readonly unknown[]) {
    if (!isJsonObject(candidate)) {
      continue;
    }
    const published = candidate as ReleaseMetadataPackage;
    if (
      typeof published.name !== "string" ||
      typeof published.tarball !== "string" ||
      typeof published.integrity !== "string" ||
      published.integrity === ""
    ) {
      continue;
    }
    const entry = packages[`node_modules/${published.name}`];
    if (
      entry !== undefined &&
      typeof entry === "object" &&
      entry.integrity === undefined &&
      entry.resolved === published.tarball &&
      entry.version === published.version
    ) {
      entry.integrity = published.integrity;
    }
  }

  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || entry === undefined || typeof entry !== "object") {
      continue;
    }
    if (typeof entry.resolved === "string" && typeof entry.integrity !== "string") {
      throw new Error(`Pi release package-lock.json entry lacks an integrity hash: ${path}`);
    }
  }

  return `${JSON.stringify(packageLock, null, 2)}\n`;
}

async function fetchReleaseArtifact(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_ARTIFACT_BYTES) {
    throw new Error(`${url} is larger than the allowed ${MAXIMUM_ARTIFACT_BYTES} bytes`);
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_ARTIFACT_BYTES) {
    throw new Error(`${url} is larger than the allowed ${MAXIMUM_ARTIFACT_BYTES} bytes`);
  }
  return body;
}

async function captureVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn([executable, "--version"], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);
    return exitCode === 0 ? parseFirstSemVer(stdout) : undefined;
  } catch {
    return undefined;
  }
}

async function probeInstalledToolchain(context: LaunchContext): Promise<PiToolchain> {
  const environment = createHarnessEnvironment(context.environment);
  const [nodePath, npmPath] = await Promise.all([
    resolveCommandOnPath("node", context.environment, context.cwd),
    resolveCommandOnPath("npm", context.environment, context.cwd),
  ]);
  const nodeVersion =
    nodePath === undefined ? undefined : await captureVersion(nodePath, environment);
  return {
    ...(nodePath === undefined ? {} : { nodePath }),
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
    ...(npmPath === undefined ? {} : { npmPath }),
  };
}

async function runNpmCi(request: PiNpmCiRequest): Promise<void> {
  const subprocess = Bun.spawn(
    [
      request.npmPath,
      "ci",
      "--ignore-scripts",
      "--min-release-age=0",
      "--omit=dev",
      "--include=optional",
      "--no-fund",
      "--no-audit",
      "--progress=false",
      "--loglevel=error",
    ],
    {
      cwd: request.cwd,
      env: request.environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await subprocess.exited;
  if (subprocess.signalCode !== null) {
    throw new Error(`npm ci terminated by signal ${subprocess.signalCode}`);
  }
  if (exitCode !== 0) {
    throw new Error(`npm ci exited with status ${exitCode}`);
  }
}

async function managedDirectoryExists(directory: string): Promise<boolean> {
  try {
    await lstat(directory);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function verifyManagedInstall(directory: string, version: string): Promise<boolean> {
  try {
    const directoryStatus = await lstat(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) return false;
    const packageJsonPath = join(directory, "node_modules", PI_PACKAGE_NAME, "package.json");
    const launcher = join(directory, "node_modules", ".bin", "pi");
    const root = await realpath(directory);
    const insideInstall = (path: string): boolean => {
      const offset = relative(root, path);
      return offset !== ".." && !offset.startsWith("../") && !isAbsolute(offset);
    };
    if (
      !insideInstall(await realpath(packageJsonPath)) ||
      !insideInstall(await realpath(launcher))
    ) {
      return false;
    }
    const status = await lstat(packageJsonPath);
    if (!status.isFile() || status.isSymbolicLink()) {
      return false;
    }
    const parsed = JSON.parse(await Bun.file(packageJsonPath).text()) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (parsed.name !== PI_PACKAGE_NAME || parsed.version !== version) {
      return false;
    }
    return await isExecutableFile(launcher);
  } catch {
    return false;
  }
}

function toolchainFailure(toolchain: PiToolchain, version: string): LauncherError {
  const problem =
    toolchain.nodePath === undefined
      ? "Node.js is not installed"
      : toolchain.nodeVersion === undefined
        ? "the Node.js version could not be determined"
        : compareSemVer(toolchain.nodeVersion, PI_MINIMUM_NODE_VERSION) < 0
          ? `Node.js ${toolchain.nodeVersion} is older than ${PI_MINIMUM_NODE_VERSION}`
          : "npm is not installed";
  return new LauncherError(
    `cannot install Pi ${version}: ${problem}`,
    LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
    {
      remediation:
        `Install Node.js ${PI_MINIMUM_NODE_VERSION} or newer and npm (for example: brew install node), ` +
        `or run the official installer (${PI_OFFICIAL_INSTALLER_COMMAND}), which can install Node.js interactively, ` +
        `then rerun ${PRODUCT_IDENTITY.command} pi.`,
    },
  );
}

async function installManagedPi(
  context: LaunchContext,
  version: string,
  dependencies: PiInstallationDependencies,
): Promise<string> {
  const toolchain = await (dependencies.probeToolchain ?? probeInstalledToolchain)(context);
  if (
    toolchain.nodeVersion === undefined ||
    toolchain.npmPath === undefined ||
    compareSemVer(toolchain.nodeVersion, PI_MINIMUM_NODE_VERSION) < 0
  ) {
    throw toolchainFailure(toolchain, version);
  }

  console.error(`${PRODUCT_IDENTITY.command}: installing Pi ${version}...`);
  const fetchArtifact = dependencies.fetchArtifact ?? fetchReleaseArtifact;
  const releaseUrl = `${PI_RELEASES_API}/${encodeURIComponent(version)}`;
  const targetDirectory = managedPiDirectory(context.paths, version);
  await mkdir(context.paths.piRuntime, { recursive: true, mode: 0o700 });
  const stageDirectory = join(
    context.paths.piRuntime,
    `.staging-${process.pid}-${crypto.randomUUID()}`,
  );

  try {
    const [metadata, packageJson, packageLock] = await Promise.all([
      fetchArtifact(releaseUrl),
      fetchArtifact(`${releaseUrl}/package.json`),
      fetchArtifact(`${releaseUrl}/package-lock.json`),
    ]);
    const completedLock = validatePiReleaseArtifacts(
      { metadata, packageJson, packageLock },
      version,
    );

    await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
    await Bun.write(join(stageDirectory, "package.json"), packageJson);
    await Bun.write(join(stageDirectory, "package-lock.json"), completedLock);
    await (dependencies.runNpmCi ?? runNpmCi)({
      cwd: stageDirectory,
      environment: createHarnessEnvironment(context.environment),
      npmPath: toolchain.npmPath,
    });

    const launcher = join(stageDirectory, "node_modules", ".bin", "pi");
    try {
      await chmod(launcher, 0o755);
    } catch {
      // Verification below reports a missing or non-executable launcher.
    }
    if (!(await verifyManagedInstall(stageDirectory, version))) {
      throw new Error(`installed tree does not contain ${PI_PACKAGE_NAME}@${version}`);
    }
    if (
      (await (dependencies.probeVersion ?? probePiVersion)(
        launcher,
        createPiEnvironment(context.environment, context.paths, { PI_OFFLINE: "1" }),
      )) !== version
    ) {
      throw new Error(`installed Pi executable does not report ${version}`);
    }

    try {
      await rename(stageDirectory, targetDirectory);
    } catch (error) {
      // A racing installer may have activated the same version first.
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }
    throw new LauncherError(
      `failed to install Pi ${version}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        cause: error,
        remediation: `Check access to ${PI_RELEASES_API} and the npm registry, then rerun ${PRODUCT_IDENTITY.command} pi.`,
      },
    );
  } finally {
    await rm(stageDirectory, { force: true, recursive: true });
  }

  if (!(await verifyManagedInstall(targetDirectory, version))) {
    throw new LauncherError(
      `Pi ${version} installation completed but could not be verified at ${targetDirectory}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { remediation: `Remove ${targetDirectory} and rerun ${PRODUCT_IDENTITY.command} pi.` },
    );
  }
  return managedPiExecutable(context.paths, version);
}

/** Resolve only the isolated exact-version Pi; never use or modify the user's PATH Pi. */
export async function resolvePiExecutable(
  context: LaunchContext,
  registration: HarnessRegistration,
  options: ExecutableResolutionOptions,
  dependencies: PiInstallationDependencies = {},
): Promise<string> {
  const installVersion = resolveConfiguredPiVersion(context.environment);
  if (context.environment[registration.executableOverrideVariable] !== undefined) {
    throw new LauncherError(
      `${registration.executableOverrideVariable} cannot override pinned Pi ${installVersion}`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation: `Unset ${registration.executableOverrideVariable}; axon uses its own Pi runtime.`,
      },
    );
  }

  const managed = managedPiExecutable(context.paths, installVersion);
  const directory = managedPiDirectory(context.paths, installVersion);
  const versionOptions =
    dependencies.probeVersion === undefined ? {} : { probe: dependencies.probeVersion };
  const verifyVersion = async (): Promise<boolean> =>
    (await verifyManagedInstall(directory, installVersion)) &&
    (await resolvePiVersion(managed, context, versionOptions)) === installVersion;
  if (await verifyVersion()) return managed;

  if (await managedDirectoryExists(directory)) {
    throw new LauncherError(
      `managed Pi at ${directory} does not match pinned version ${installVersion}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { remediation: `Remove ${directory} and rerun ${PRODUCT_IDENTITY.command} pi while online.` },
    );
  }
  if (!options.allowInstall || isPiOffline(context.environment, options.userArguments)) {
    throw new LauncherError(
      `managed Pi ${installVersion} is unavailable`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages while online.` },
    );
  }

  return withFileLock(context.paths.piInstallLock, async () => {
    if (await verifyVersion()) return managed;
    if (await managedDirectoryExists(directory)) {
      throw new LauncherError(
        `managed Pi at ${directory} does not match pinned version ${installVersion}`,
        LAUNCHER_EXIT_STATUS.executableUnavailable,
        {
          remediation: `Remove ${directory} and rerun ${PRODUCT_IDENTITY.command} pi while online.`,
        },
      );
    }
    return installManagedPi(context, installVersion, dependencies);
  });
}

/** Doctor findings about the managed Pi runtime; never installs anything. */
export async function inspectPiRuntime(context: LaunchContext): Promise<readonly DoctorFinding[]> {
  const version = resolveConfiguredPiVersion(context.environment);
  const directory = managedPiDirectory(context.paths, version);
  if (await verifyManagedInstall(directory, version)) {
    const executable = managedPiExecutable(context.paths, version);
    const actual = await resolvePiVersion(executable, context);
    return actual === version
      ? [{ level: "info", message: `pi: pinned install ${version} at ${directory}` }]
      : [
          {
            level: "error",
            message: `pi: managed executable reports ${actual ?? "unknown"}, expected ${version}`,
          },
        ];
  }
  return [
    {
      level: "info",
      message: `pi: no managed install; Axon installs pinned Pi ${version} on an online launch`,
    },
  ];
}

export { setupRemediation as piSetupRemediation };
