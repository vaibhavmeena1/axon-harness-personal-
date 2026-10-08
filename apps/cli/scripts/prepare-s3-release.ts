import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../src/product/endpoints.ts";
import { parseServiceOrigin } from "../src/product/service-origin.ts";
import { buildRelease } from "./build-release.ts";
import {
  assertCanonicalSemVer,
  assertReleaseCommit,
  optionalEnvironmentVariable,
  readPackageVersion,
  requireEnvironmentVariable,
} from "./release-contract.ts";

const ARCHIVE = "axon-darwin-arm64.gz";
const EXECUTABLE = "axon-darwin-arm64";

async function run(...argumentsVector: string[]): Promise<string> {
  const child = Bun.spawn(argumentsVector, { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const result = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`${argumentsVector[0]} failed`);
  return result.trim();
}

async function digest(path: string): Promise<{ sha256: string; size: number }> {
  const file = Bun.file(path);
  const stats = await stat(path);
  if (!stats.isFile() || stats.size === 0) throw new Error(`empty release asset: ${path}`);
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);
  return { sha256: hasher.digest("hex"), size: stats.size };
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
  await buildRelease();
  const executable = join(process.cwd(), "dist", EXECUTABLE);
  const output = join(process.cwd(), "release");
  const archive = join(output, ARCHIVE);
  await mkdir(output, { recursive: true });
  if ((await run("lipo", "-archs", executable)) !== "arm64")
    throw new Error("not an arm64-only binary");
  await run("codesign", "--force", "--sign", "-", "--timestamp=none", executable);
  await run("codesign", "--verify", "--verbose=2", executable);
  if ((await run(executable, "--version")) !== version)
    throw new Error("release binary version mismatch");
  await copyFile(`${executable}.map`, join(output, `${EXECUTABLE}.map`));
  const gzip = Bun.spawn(["gzip", "-9", "-n", "-c", executable], {
    stdin: "ignore",
    stdout: Bun.file(archive),
    stderr: "inherit",
  });
  if ((await gzip.exited) !== 0) throw new Error("failed to compress the release binary");
  const compressed = await digest(archive);
  const binary = await digest(executable);
  const s3Key = `${prefix}${version}/${ARCHIVE}`;
  await Promise.all([
    Bun.write(
      join(output, "checksums.txt"),
      `${compressed.sha256}  ${ARCHIVE}\n${binary.sha256}  ${EXECUTABLE}\n`,
    ),
    Bun.write(join(output, "VERSION"), `${version}\n`),
    Bun.write(
      join(output, "cli-release-config.json"),
      `${JSON.stringify(
        {
          [version]: {
            s3_key: s3Key,
            archive_sha256: compressed.sha256,
            binary_sha256: binary.sha256,
          },
        },
        null,
        2,
      )}\n`,
    ),
    Bun.write(
      join(output, "release-metadata.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version,
          target: "darwin-arm64",
          commit,
          assetUrl: `${resolveServiceUrl(origin, SERVICE_ENDPOINTS.release.base)}/${encodeURIComponent(version)}/${ARCHIVE}`,
          artifacts: {
            compressed: { name: ARCHIVE, ...compressed },
            binary: { name: EXECUTABLE, ...binary },
          },
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  console.log(
    `Prepared ${version}. Add release/cli-release-config.json to backend CLI_RELEASES.VERSIONS before publishing.`,
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
