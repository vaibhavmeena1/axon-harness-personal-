import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  formatReleaseChecksums,
  LEGACY_CHECKSUMS_NAME,
  LEGACY_CHECKSUMS_TARGET,
  RELEASE_TARGETS,
  releaseAssetNames,
} from "../src/product/release-targets.ts";
import {
  assertCanonicalSemVer,
  assertGitHubRepository,
  assertReleaseCommit,
  formatCliReleaseTag,
  optionalEnvironmentVariable,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

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

function resolveDirectory(environmentName: string, fallback: string): string {
  const configuredPath = optionalEnvironmentVariable(environmentName);
  return resolve(process.cwd(), configuredPath || fallback);
}

/**
 * Describes every target of one release. Reads dist/axon-<target> binaries and
 * release/axon-<target>.gz archives, and writes alongside the archives.
 */
export async function generateReleaseMetadata(): Promise<void> {
  const version = requireEnvironmentVariable("RELEASE_VERSION");
  const commit = requireEnvironmentVariable("BUILD_COMMIT");
  const repository = requireEnvironmentVariable("GITHUB_REPOSITORY");
  const serviceEnvironment =
    optionalEnvironmentVariable("RELEASE_SERVICE_ENVIRONMENT") || "production";
  const packageVersion = await readPackageVersion(join(process.cwd(), "package.json"));

  assertCanonicalSemVer(version, "release version");
  assertReleaseCommit(commit);
  assertGitHubRepository(repository);
  if (packageVersion !== version) {
    throw new Error(
      `package.json version ${packageVersion} does not equal release version ${version}`,
    );
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(serviceEnvironment)) {
    throw new Error("RELEASE_SERVICE_ENVIRONMENT contains unsupported characters");
  }

  const binaryDirectory = resolveDirectory("RELEASE_BINARY_DIR", "dist");
  const outputDirectory = resolveDirectory("RELEASE_OUTPUT_DIR", "release");
  const releaseTag = formatCliReleaseTag(version);
  const downloadBase = `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}`;
  const targets = await Promise.all(
    RELEASE_TARGETS.map(async (target) => {
      const names = releaseAssetNames(target);
      const [binary, compressed] = await Promise.all([
        digestFile(join(binaryDirectory, names.binary)),
        digestFile(join(outputDirectory, names.archive)),
      ]);
      return { target, names, binary, compressed };
    }),
  );
  const metadata = {
    schemaVersion: 2,
    version,
    releaseTag,
    commit,
    serviceEnvironment,
    targets: Object.fromEntries(
      targets.map(({ target, names, binary, compressed }) => [
        target,
        {
          assetUrl: `${downloadBase}/${names.archive}`,
          artifacts: {
            compressed: { name: names.archive, sha256: compressed.sha256, size: compressed.size },
            binary: { name: names.binary, sha256: binary.sha256, size: binary.size },
          },
        },
      ]),
    ),
  } as const;

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    Bun.write(join(outputDirectory, "VERSION"), `${version}\n`),
    ...targets.map(({ target, names, binary, compressed }) =>
      Bun.write(
        join(outputDirectory, names.checksums),
        formatReleaseChecksums(target, compressed.sha256, binary.sha256),
      ),
    ),
    Bun.write(
      join(outputDirectory, "release-metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    ),
  ]);
  await copyFile(
    join(outputDirectory, releaseAssetNames(LEGACY_CHECKSUMS_TARGET).checksums),
    join(outputDirectory, LEGACY_CHECKSUMS_NAME),
  );

  console.log(`Generated release metadata for ${version} (${RELEASE_TARGETS.join(", ")}).`);
}

if (import.meta.main) {
  try {
    await generateReleaseMetadata();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
