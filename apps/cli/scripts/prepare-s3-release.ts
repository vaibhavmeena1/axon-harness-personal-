import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../src/product/endpoints.ts";
import {
  formatReleaseChecksums,
  LEGACY_CHECKSUMS_NAME,
  LEGACY_CHECKSUMS_TARGET,
  LIPO_ARCHITECTURES,
  RELEASE_TARGETS,
  type ReleaseTarget,
  releaseAssetNames,
} from "../src/product/release-targets.ts";
import { parseServiceOrigin } from "../src/product/service-origin.ts";
import { buildRelease } from "./build-release.ts";
import {
  assertCanonicalSemVer,
  assertReleaseCommit,
  optionalEnvironmentVariable,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

interface Digest {
  readonly sha256: string;
  readonly size: number;
}

interface PreparedTarget {
  readonly target: ReleaseTarget;
  readonly s3Key: string;
  readonly compressed: Digest;
  readonly binary: Digest;
}

async function run(...argumentsVector: string[]): Promise<string> {
  const child = Bun.spawn(argumentsVector, { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const result = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${argumentsVector[0]} failed`);
  return result.trim();
}

async function digest(path: string): Promise<Digest> {
  const file = Bun.file(path);
  const stats = await stat(path);
  if (!stats.isFile() || stats.size === 0) throw new Error(`empty release asset: ${path}`);
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);
  return { sha256: hasher.digest("hex"), size: stats.size };
}

async function reportedVersion(executable: string, target: ReleaseTarget): Promise<string> {
  try {
    return await run(executable, "--version");
  } catch (error) {
    // Apple Silicon runs the cross-compiled x64 binary only through Rosetta.
    if (target === "darwin-x64" && process.arch === "arm64") {
      throw new Error(
        "could not run the darwin-x64 release binary; if Rosetta is missing, install it with `softwareupdate --install-rosetta`",
        { cause: error },
      );
    }
    throw error;
  }
}

async function prepareTarget(
  target: ReleaseTarget,
  version: string,
  prefix: string,
  output: string,
): Promise<PreparedTarget> {
  const names = releaseAssetNames(target);
  const executable = await buildRelease({
    target,
    outputPath: join(process.cwd(), "dist", names.binary),
  });
  const archive = join(output, names.archive);
  if ((await run("lipo", "-archs", executable)) !== LIPO_ARCHITECTURES[target])
    throw new Error(`not a ${LIPO_ARCHITECTURES[target]}-only binary: ${names.binary}`);
  await run("codesign", "--force", "--sign", "-", "--timestamp=none", executable);
  await run("codesign", "--verify", "--verbose=2", executable);
  if ((await reportedVersion(executable, target)) !== version)
    throw new Error(`${target} release binary version mismatch`);
  await copyFile(`${executable}.map`, join(output, names.sourceMap));
  // Bun's file-backed spawn output can retain trailing bytes from an older,
  // larger archive. Remove it first so every preparation starts with a new file.
  await rm(archive, { force: true });
  const gzip = Bun.spawn(["gzip", "-9", "-n", "-c", executable], {
    stdin: "ignore",
    stdout: Bun.file(archive),
    stderr: "inherit",
  });
  if ((await gzip.exited) !== 0) throw new Error("failed to compress the release binary");
  await run("gzip", "-t", archive);
  const compressed = await digest(archive);
  const binary = await digest(executable);
  await Bun.write(
    join(output, names.checksums),
    formatReleaseChecksums(target, compressed.sha256, binary.sha256),
  );
  return { target, s3Key: `${prefix}${version}/${names.archive}`, compressed, binary };
}

export async function prepareS3Release(): Promise<void> {
  const version = requireEnvironmentVariable("RELEASE_VERSION");
  const commit = requireEnvironmentVariable("BUILD_COMMIT");
  const origin = parseServiceOrigin(requireEnvironmentVariable("AXON_SERVICE_ORIGIN"), {
    allowLoopbackHttp: false,
  });
  assertCanonicalSemVer(version, "release version");
  assertReleaseCommit(commit);
  if (version !== (await readPackageVersion(join(process.cwd(), "package.json")))) {
    throw new Error("RELEASE_VERSION must match apps/cli/package.json");
  }
  const prefix = optionalEnvironmentVariable("RELEASE_KEY_PREFIX") ?? "cli/releases/";
  if (
    !/^[A-Za-z0-9_/-]+\/$/.test(prefix) ||
    prefix.startsWith("/") ||
    prefix.includes("//") ||
    prefix.split("/").includes("..")
  ) {
    throw new Error("RELEASE_KEY_PREFIX must be a safe relative S3 prefix ending in /");
  }
  const output = join(process.cwd(), "release");
  await mkdir(output, { recursive: true });
  // Every version ships every target, so no installed launcher is left without an update.
  const prepared: PreparedTarget[] = [];
  for (const target of RELEASE_TARGETS) {
    prepared.push(await prepareTarget(target, version, prefix, output));
  }
  const releaseBase = `${resolveServiceUrl(origin, SERVICE_ENDPOINTS.release.base)}/${encodeURIComponent(version)}`;
  await Promise.all([
    copyFile(
      join(output, releaseAssetNames(LEGACY_CHECKSUMS_TARGET).checksums),
      join(output, LEGACY_CHECKSUMS_NAME),
    ),
    Bun.write(join(output, "VERSION"), `${version}\n`),
    Bun.write(
      join(output, "cli-release-config.json"),
      `${JSON.stringify(
        {
          [version]: Object.fromEntries(
            prepared.map(({ target, s3Key, compressed, binary }) => [
              target,
              {
                s3_key: s3Key,
                archive_sha256: compressed.sha256,
                binary_sha256: binary.sha256,
              },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    ),
    Bun.write(
      join(output, "release-metadata.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          version,
          commit,
          targets: Object.fromEntries(
            prepared.map(({ target, compressed, binary }) => {
              const names = releaseAssetNames(target);
              return [
                target,
                {
                  assetUrl: `${releaseBase}/${names.archive}`,
                  artifacts: {
                    compressed: { name: names.archive, ...compressed },
                    binary: { name: names.binary, ...binary },
                  },
                },
              ];
            }),
          ),
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  console.log(
    `Prepared ${version} for ${RELEASE_TARGETS.join(" and ")}. Add release/cli-release-config.json to backend CLI_RELEASES.VERSIONS before publishing.`,
  );
}

if (import.meta.main) {
  try {
    await prepareS3Release();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
