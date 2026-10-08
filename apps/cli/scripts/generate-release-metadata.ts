import { mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  assertCanonicalSemVer,
  assertGitHubRepository,
  assertReleaseCommit,
  formatCliReleaseTag,
  optionalEnvironmentVariable,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

const RELEASE_TARGET = "darwin-arm64";
const BINARY_NAME = "axon-darwin-arm64";
const ARCHIVE_NAME = `${BINARY_NAME}.gz`;

interface FileDigest {
  readonly sha256: string;
  readonly size: number;
}

async function digestFile(path: string): Promise<FileDigest> {
  const fileStatus = await stat(path);
  if (!fileStatus.isFile() || fileStatus.size === 0) {
    throw new Error(`release artifact must be a non-empty file: ${path}`);
  }
  const bytes = await Bun.file(path).arrayBuffer();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { sha256, size: fileStatus.size };
}

function resolveInputPath(environmentName: string, fallback: string): string {
  const configuredPath = optionalEnvironmentVariable(environmentName);
  return resolve(process.cwd(), configuredPath || fallback);
}

export async function generateReleaseMetadata(): Promise<void> {
  const version = requireEnvironmentVariable("RELEASE_VERSION");
  const commit = requireEnvironmentVariable("BUILD_COMMIT");
  const repository = requireEnvironmentVariable("GITHUB_REPOSITORY");
  const serviceEnvironment =
    optionalEnvironmentVariable("RELEASE_SERVICE_ENVIRONMENT") || "production";
  const target = optionalEnvironmentVariable("BUILD_TARGET") || RELEASE_TARGET;
  const packageVersion = await readPackageVersion(join(process.cwd(), "package.json"));

  assertCanonicalSemVer(version, "release version");
  assertReleaseCommit(commit);
  assertGitHubRepository(repository);
  if (packageVersion !== version) {
    throw new Error(
      `package.json version ${packageVersion} does not equal release version ${version}`,
    );
  }
  if (target !== RELEASE_TARGET) {
    throw new Error(`release metadata only supports ${RELEASE_TARGET}, received ${target}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(serviceEnvironment)) {
    throw new Error("RELEASE_SERVICE_ENVIRONMENT contains unsupported characters");
  }

  const binaryPath = resolveInputPath("RELEASE_BINARY_PATH", join("dist", BINARY_NAME));
  const archivePath = resolveInputPath("RELEASE_ARCHIVE_PATH", join("release", ARCHIVE_NAME));
  if (basename(binaryPath) !== BINARY_NAME || basename(archivePath) !== ARCHIVE_NAME) {
    throw new Error(`release inputs must be named ${BINARY_NAME} and ${ARCHIVE_NAME}`);
  }

  const outputDirectory = resolveInputPath("RELEASE_OUTPUT_DIR", "release");
  const [binary, compressed] = await Promise.all([digestFile(binaryPath), digestFile(archivePath)]);
  const releaseTag = formatCliReleaseTag(version);
  const assetUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${ARCHIVE_NAME}`;
  const metadata = {
    schemaVersion: 1,
    version,
    releaseTag,
    target,
    commit,
    serviceEnvironment,
    assetUrl,
    artifacts: {
      compressed: {
        name: ARCHIVE_NAME,
        sha256: compressed.sha256,
        size: compressed.size,
      },
      binary: {
        name: BINARY_NAME,
        sha256: binary.sha256,
        size: binary.size,
      },
    },
  } as const;

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    Bun.write(join(outputDirectory, "VERSION"), `${version}\n`),
    Bun.write(
      join(outputDirectory, "checksums.txt"),
      `${compressed.sha256}  ${ARCHIVE_NAME}\n${binary.sha256}  ${BINARY_NAME}\n`,
    ),
    Bun.write(
      join(outputDirectory, "release-metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    ),
  ]);

  console.log(`Generated release metadata for ${version}.`);
}

if (import.meta.main) {
  try {
    await generateReleaseMetadata();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
