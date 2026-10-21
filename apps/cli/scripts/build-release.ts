import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  hostReleaseTarget,
  isReleaseTarget,
  RELEASE_TARGETS,
  type ReleaseTarget,
  releaseAssetNames,
} from "../src/product/release-targets.ts";
import { parseServiceOrigin } from "../src/product/service-origin.ts";
import { checkPiVersion } from "./check-pi-version.ts";
import {
  assertCanonicalSemVer,
  assertReleaseCommit,
  optionalEnvironmentVariable,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

export interface BuildReleaseOptions {
  /** Defaults to BUILD_TARGET, then to the host target. */
  readonly target?: ReleaseTarget;
  /** Defaults to RELEASE_BINARY_PATH, then to dist/axon-<target>. */
  readonly outputPath?: string;
}

function resolveTarget(): ReleaseTarget {
  const target = optionalEnvironmentVariable("BUILD_TARGET") ?? hostReleaseTarget();
  if (target === undefined || !isReleaseTarget(target)) {
    throw new Error(
      `release builds support ${RELEASE_TARGETS.join(", ")}, received ${target ?? `${process.platform}-${process.arch}`}`,
    );
  }
  return target;
}

function resolveOutputPath(repositoryRoot: string, target: ReleaseTarget): string {
  const configuredPath = optionalEnvironmentVariable("RELEASE_BINARY_PATH");
  return resolve(repositoryRoot, configuredPath || join("dist", releaseAssetNames(target).binary));
}

async function assertFileExists(path: string): Promise<void> {
  const fileStatus = await stat(path);
  if (!fileStatus.isFile() || fileStatus.size === 0) {
    throw new Error(`release compiler did not create a non-empty file: ${path}`);
  }
}

/** Compiles one release target and returns the executable path. */
export async function buildRelease(options: BuildReleaseOptions = {}): Promise<string> {
  const repositoryRoot = process.cwd();
  const version = requireEnvironmentVariable("RELEASE_VERSION");
  const commit = requireEnvironmentVariable("BUILD_COMMIT");
  const serviceOrigin = requireEnvironmentVariable("AXON_SERVICE_ORIGIN");
  const target = options.target ?? resolveTarget();
  const packageVersion = await readPackageVersion(join(repositoryRoot, "package.json"));
  await checkPiVersion(repositoryRoot);

  assertCanonicalSemVer(version, "release version");
  assertReleaseCommit(commit);
  if (version !== packageVersion) {
    throw new Error(
      `release version ${version} does not equal package.json version ${packageVersion}`,
    );
  }
  // Bun cross-compiles between macOS architectures; signing still needs a macOS host.
  if (process.platform !== "darwin") {
    throw new Error(`release compilation requires a macOS host, received ${process.platform}`);
  }

  const validatedServiceOrigin = parseServiceOrigin(serviceOrigin, { allowLoopbackHttp: false });
  const outputPath = options.outputPath ?? resolveOutputPath(repositoryRoot, target);
  const sourceMapPath = `${outputPath}.map`;
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([rm(outputPath, { force: true }), rm(sourceMapPath, { force: true })]);

  const compilerArguments = [
    "build",
    join(repositoryRoot, "src", "index.ts"),
    "--compile",
    "--format=esm",
    "--bytecode",
    "--minify",
    "--sourcemap=external",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    `--target=bun-${target}`,
    "--define",
    `BUILD_VERSION=${JSON.stringify(version)}`,
    "--define",
    'BUILD_KIND="binary"',
    "--define",
    `BUILD_TARGET=${JSON.stringify(target)}`,
    "--define",
    `BUILD_COMMIT=${JSON.stringify(commit)}`,
    "--define",
    `BUILD_SERVICE_ORIGIN=${JSON.stringify(validatedServiceOrigin)}`,
    "--outfile",
    outputPath,
  ];

  const compiler = Bun.spawn([process.execPath, ...compilerArguments], {
    cwd: repositoryRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await compiler.exited;
  if (exitCode !== 0) {
    throw new Error(`Bun release compilation failed with exit code ${exitCode}`);
  }

  await Promise.all([assertFileExists(outputPath), assertFileExists(sourceMapPath)]);
  console.log(`Built ${releaseAssetNames(target).binary} for release ${version}.`);
  return outputPath;
}

if (import.meta.main) {
  try {
    await buildRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
