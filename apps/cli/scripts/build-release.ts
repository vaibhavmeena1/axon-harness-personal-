import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseServiceOrigin } from "../src/product/service-origin.ts";
import { checkPiVersion } from "./check-pi-version.ts";
import {
  assertCanonicalSemVer,
  assertReleaseCommit,
  optionalEnvironmentVariable,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

const RELEASE_TARGET = "darwin-arm64";
const RELEASE_ASSET_BASENAME = "axon-darwin-arm64";

function resolveOutputPath(repositoryRoot: string): string {
  const configuredPath = optionalEnvironmentVariable("RELEASE_BINARY_PATH");
  return resolve(repositoryRoot, configuredPath || join("dist", RELEASE_ASSET_BASENAME));
}

async function assertFileExists(path: string): Promise<void> {
  const fileStatus = await stat(path);
  if (!fileStatus.isFile() || fileStatus.size === 0) {
    throw new Error(`release compiler did not create a non-empty file: ${path}`);
  }
}

export async function buildRelease(): Promise<void> {
  const repositoryRoot = process.cwd();
  const version = requireEnvironmentVariable("RELEASE_VERSION");
  const commit = requireEnvironmentVariable("BUILD_COMMIT");
  const serviceOrigin = requireEnvironmentVariable("AXON_SERVICE_ORIGIN");
  const target = optionalEnvironmentVariable("BUILD_TARGET") || RELEASE_TARGET;
  const packageVersion = await readPackageVersion(join(repositoryRoot, "package.json"));
  await checkPiVersion(repositoryRoot);

  assertCanonicalSemVer(version, "release version");
  assertReleaseCommit(commit);
  if (version !== packageVersion) {
    throw new Error(
      `release version ${version} does not equal package.json version ${packageVersion}`,
    );
  }
  if (target !== RELEASE_TARGET) {
    throw new Error(`only ${RELEASE_TARGET} release builds are supported, received ${target}`);
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `release compilation requires a native Darwin arm64 host, received ${process.platform}-${process.arch}`,
    );
  }

  const validatedServiceOrigin = parseServiceOrigin(serviceOrigin, { allowLoopbackHttp: false });
  const outputPath = resolveOutputPath(repositoryRoot);
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
    "--target=bun-darwin-arm64",
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
  console.log(`Built ${RELEASE_ASSET_BASENAME} for release ${version}.`);
}

if (import.meta.main) {
  try {
    await buildRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
