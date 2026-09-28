import { stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import { BUILD_INFO } from "../../build-info.ts";
import {
  HARNESS_REGISTRY,
  loadHarnessAdapter,
  resolveHarnessRegistration,
} from "../../harnesses/registry.ts";
import type {
  DoctorFinding,
  HarnessRegistration,
  LaunchContext,
} from "../../launcher/contracts.ts";
import { createHarnessEnvironment } from "../../launcher/environment.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { resolveCommandOnPath, resolveExecutablePath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS, type LauncherExitStatus } from "../../launcher/exit-status.ts";
import { compareSemVer } from "../../launcher/version.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";

const PATH_ENVIRONMENT_VARIABLE = "PATH";

interface DoctorResult {
  readonly findings: readonly DoctorFinding[];
  readonly exitStatus: 0 | LauncherExitStatus;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function inspectHome(paths: DeputyDevPaths): Promise<DoctorResult> {
  try {
    const homeStatus = await stat(paths.home);
    const findings: DoctorFinding[] = [];
    let exitStatus: 0 | LauncherExitStatus = 0;

    if (!homeStatus.isDirectory()) {
      return {
        findings: [
          {
            level: "error",
            message: `DeputyDev home is not a directory: ${paths.home}`,
            remediation: `Move that path aside, then rerun ${PRODUCT_IDENTITY.command}.`,
          },
        ],
        exitStatus: LAUNCHER_EXIT_STATUS.profileFailure,
      };
    }

    const getUserId = process.getuid;
    if (getUserId !== undefined && homeStatus.uid !== getUserId()) {
      findings.push({
        level: "error",
        message: `DeputyDev home is owned by uid ${homeStatus.uid}; current uid is ${getUserId()}`,
        remediation: `Restore ownership of ${paths.home} to the current user.`,
      });
      exitStatus = LAUNCHER_EXIT_STATUS.profileFailure;
    }

    if ((homeStatus.mode & 0o077) !== 0) {
      findings.push({
        level: "error",
        message: `DeputyDev home permissions are ${formatMode(homeStatus.mode)}; expected 0700`,
        remediation: `Run: chmod 700 ${JSON.stringify(paths.home)}`,
      });
      exitStatus = LAUNCHER_EXIT_STATUS.profileFailure;
    } else {
      findings.push({
        level: "info",
        message: `DeputyDev home permissions are private (${formatMode(homeStatus.mode)})`,
      });
    }

    return { findings, exitStatus };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        findings: [
          {
            level: "info",
            message: `DeputyDev home does not exist yet: ${paths.home}`,
          },
        ],
        exitStatus: 0,
      };
    }

    return {
      findings: [
        {
          level: "error",
          message: `Could not inspect DeputyDev home: ${paths.home}`,
          remediation: "Check parent-directory permissions and rerun doctor.",
        },
      ],
      exitStatus: LAUNCHER_EXIT_STATUS.profileFailure,
    };
  }
}

function isDirectoryOnPath(
  directory: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): boolean {
  return (environment[PATH_ENVIRONMENT_VARIABLE] ?? "")
    .split(delimiter)
    .some((entry) => resolve(entry || cwd) === directory);
}

async function inspectLauncherPath(context: LaunchContext): Promise<readonly DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  if (isDirectoryOnPath(context.paths.bin, context.environment, context.cwd)) {
    findings.push({ level: "info", message: `${context.paths.bin} is on PATH` });
  } else {
    findings.push({
      level: "warning",
      message: `${context.paths.bin} is not on PATH`,
      remediation: `Add ${context.paths.bin} to your shell PATH.`,
    });
  }

  const commandPath = await resolveCommandOnPath(
    PRODUCT_IDENTITY.command,
    context.environment,
    context.cwd,
  );

  if (commandPath === undefined) {
    findings.push({
      level: "warning",
      message: `${PRODUCT_IDENTITY.command} does not resolve on PATH`,
      remediation: `Add ${context.paths.bin} to PATH after installing DeputyDev.`,
    });
  } else if (resolve(commandPath) !== resolve(context.paths.managedBinary)) {
    findings.push({
      level: "warning",
      message: `${PRODUCT_IDENTITY.command} resolves to ${commandPath}, not ${context.paths.managedBinary}`,
      remediation:
        "Place the managed DeputyDev bin directory before shadowing package-manager paths.",
    });
  } else {
    findings.push({
      level: "info",
      message: `${PRODUCT_IDENTITY.command} resolves to the managed binary`,
    });
  }

  return findings;
}

async function probeVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn([executable, "--version"], {
      env: createHarnessEnvironment(environment),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2_000,
      killSignal: "SIGKILL",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    if (exitCode !== 0) {
      return undefined;
    }

    const output = (stdout.trim() || stderr.trim()).split(/\r?\n/, 1)[0];
    return output?.slice(0, 300) || undefined;
  } catch {
    return undefined;
  }
}

function describeExecutableSource(
  registration: HarnessRegistration,
  context: LaunchContext,
  executable: string,
): string {
  if (context.environment[registration.executableOverrideVariable] !== undefined) {
    return "override";
  }
  if (resolve(executable).startsWith(`${resolve(context.paths.piRuntime)}/`)) {
    return "managed";
  }
  return "path";
}

function versionFinding(
  registration: HarnessRegistration,
  version: string | undefined,
  minimumVersion: string | undefined,
  exactVersion?: string,
): DoctorFinding {
  if (version === undefined) {
    return {
      level: "warning",
      message: `${registration.id}: executable version could not be determined`,
    };
  }
  if (exactVersion !== undefined) {
    return version === exactVersion
      ? { level: "info", message: `${registration.id}: version ${version} (pinned)` }
      : {
          level: "error",
          message: `${registration.id}: version ${version} does not match pinned ${exactVersion}`,
          remediation: `Run ${PRODUCT_IDENTITY.command} setup ${registration.id} --sync-packages while online.`,
        };
  }
  if (minimumVersion === undefined) {
    return {
      level: "info",
      message: `${registration.id}: version ${version}; compatibility range not yet evaluated`,
    };
  }
  if (compareSemVer(version, minimumVersion) < 0) {
    return {
      level: "error",
      message: `${registration.id}: version ${version} is older than the supported minimum ${minimumVersion}`,
      remediation: `Upgrade ${registration.id}, or run ${PRODUCT_IDENTITY.command} setup ${registration.id} --sync-packages to install the DeputyDev-managed version.`,
    };
  }
  return {
    level: "info",
    message: `${registration.id}: version ${version} (minimum ${minimumVersion})`,
  };
}

async function inspectHarness(
  registration: HarnessRegistration,
  context: LaunchContext,
): Promise<DoctorResult> {
  try {
    const adapter = await loadHarnessAdapter(registration.id);
    // Diagnostics locate executables but never download one.
    const executable =
      adapter.resolveExecutable === undefined
        ? (await resolveExecutablePath(registration, context.environment, context.cwd)).path
        : await adapter.resolveExecutable(context, registration, {
            userArguments: [],
            allowInstall: false,
          });
    const exactVersion = adapter.exactVersion?.(context);
    const version =
      adapter.probeVersion === undefined
        ? await probeVersion(executable, context.environment)
        : await adapter.probeVersion(context, executable);
    const adapterFindings = await adapter.doctor(context);

    return {
      findings: [
        {
          level: "info",
          message: `${registration.id}: executable ${executable} (${describeExecutableSource(registration, context, executable)})`,
        },
        versionFinding(registration, version, adapter.minimumVersion, exactVersion),
        ...adapterFindings,
      ],
      exitStatus:
        (exactVersion !== undefined && version !== exactVersion) ||
        (version !== undefined &&
          adapter.minimumVersion !== undefined &&
          compareSemVer(version, adapter.minimumVersion) < 0)
          ? LAUNCHER_EXIT_STATUS.profileFailure
          : 0,
    };
  } catch (error) {
    if (error instanceof LauncherError) {
      return {
        findings: [
          {
            level: "error",
            message: error.message,
            ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
          },
        ],
        exitStatus: error.exitStatus,
      };
    }

    return {
      findings: [
        {
          level: "error",
          message: `${registration.id}: diagnostics failed`,
          remediation: "Set DEPUTYDEV_DEBUG=1 and rerun doctor for details.",
        },
      ],
      exitStatus: LAUNCHER_EXIT_STATUS.profileFailure,
    };
  }
}

function mergeExitStatus(
  current: 0 | LauncherExitStatus,
  next: 0 | LauncherExitStatus,
): 0 | LauncherExitStatus {
  return current === 0 ? next : current;
}

function printFinding(finding: DoctorFinding): void {
  console.log(`[${finding.level}] ${finding.message}`);
  if (finding.remediation !== undefined) {
    console.log(`  remediation: ${finding.remediation}`);
  }
}

export async function runDoctor(
  context: LaunchContext,
  harnessToken?: string,
): Promise<0 | LauncherExitStatus> {
  const selectedRegistration =
    harnessToken === undefined ? undefined : resolveHarnessRegistration(harnessToken);

  if (harnessToken !== undefined && selectedRegistration === undefined) {
    throw new LauncherError(`unknown harness: ${harnessToken}`, LAUNCHER_EXIT_STATUS.usage, {
      remediation: `Run ${PRODUCT_IDENTITY.command} harnesses to list supported harnesses.`,
    });
  }

  const platformSupported = process.platform === "darwin" && process.arch === "arm64";
  const findings: DoctorFinding[] = [
    {
      level: platformSupported ? "info" : "error",
      message: platformSupported
        ? `platform: native darwin-arm64 (build target ${BUILD_INFO.target})`
        : `unsupported platform: ${process.platform}-${process.arch}; the initial release supports native darwin-arm64`,
      ...(platformSupported
        ? {}
        : { remediation: "Run DeputyDev on an Apple Silicon macOS host, outside a container." }),
    },
    {
      level: "info",
      message: `DeputyDev ${BUILD_INFO.version} (${BUILD_INFO.kind}, commit ${BUILD_INFO.commit})`,
    },
    {
      level: "info",
      message: `managed home: ${context.paths.home}`,
    },
  ];
  let exitStatus: 0 | LauncherExitStatus = platformSupported
    ? 0
    : LAUNCHER_EXIT_STATUS.unsupportedEnvironment;

  const homeResult = await inspectHome(context.paths);
  findings.push(...homeResult.findings);
  exitStatus = mergeExitStatus(exitStatus, homeResult.exitStatus);
  findings.push(...(await inspectLauncherPath(context)));

  const registrations =
    selectedRegistration === undefined ? HARNESS_REGISTRY : [selectedRegistration];
  for (const registration of registrations) {
    const harnessResult = await inspectHarness(registration, context);
    findings.push(...harnessResult.findings);
    exitStatus = mergeExitStatus(exitStatus, harnessResult.exitStatus);
  }

  for (const finding of findings) {
    printFinding(finding);
  }

  return exitStatus;
}
