import { join } from "node:path";

import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../src/product/endpoints.ts";
import {
  LEGACY_CHECKSUMS_NAME,
  RELEASE_TARGETS,
  type ReleaseTarget,
  releaseAssetNames,
} from "../src/product/release-targets.ts";
import { parseServiceOrigin } from "../src/product/service-origin.ts";
import { assertCanonicalSemVer, requireEnvironmentVariable } from "./release-contract.ts";

interface PreparedArchive {
  readonly target: ReleaseTarget;
  readonly archive: Bun.BunFile;
  readonly expected: string;
}

async function hashStream(response: Response): Promise<string> {
  if (!response.body) throw new Error("release download verification has no body");
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of response.body) hasher.update(chunk);
  return hasher.digest("hex");
}

async function fetchCloudFrontArchive(url: string): Promise<Response> {
  const redirect = await fetch(url, {
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (redirect.status !== 302) return redirect;
  const location = redirect.headers.get("location");
  if (!location?.startsWith("https://")) throw new Error("invalid CloudFront redirect");
  await redirect.body?.cancel();
  return fetch(location, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

async function verifyCloudFrontArchive(url: string, expected: string): Promise<void> {
  // A guessed exact-version URL could have cached a 404 before publication.
  // Retry that error briefly, without repeating the non-overwriting S3 PUT.
  for (let attempt = 0; attempt < 12; attempt++) {
    let download: Response | undefined;
    try {
      download = await fetchCloudFrontArchive(url);
    } catch {
      // Retry transient CDN/network failures. Never log the signed redirect URL.
    }
    if (download?.ok) {
      if ((await hashStream(download)) !== expected) {
        throw new Error("CloudFront download hash does not match local release");
      }
      return;
    }
    await download?.body?.cancel();
    if (attempt < 11) await Bun.sleep(5_000);
  }
  throw new Error("CloudFront download could not be verified; do not promote latest");
}

async function assertBackendChecksums(url: string, localPath: string): Promise<void> {
  const configured = await fetch(url, { cache: "no-store" });
  const localChecksums = await Bun.file(localPath).text();
  if (!configured.ok || (await configured.text()) !== localChecksums) {
    throw new Error(
      "configure this version and every target's matching hashes in backend config.json, then restart it",
    );
  }
}

async function uploadArchive(
  root: string,
  token: string,
  version: string,
  { target, archive }: PreparedArchive,
): Promise<void> {
  const signed = await fetch(`${root}/uploads/presign`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version, target }),
    cache: "no-store",
  });
  if (!signed.ok) throw new Error(`could not request an upload URL (HTTP ${signed.status})`);
  const payload: unknown = await signed.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("url" in payload) ||
    typeof payload.url !== "string" ||
    !payload.url.startsWith("https://") ||
    !("headers" in payload) ||
    typeof payload.headers !== "object" ||
    payload.headers === null
  ) {
    throw new Error("backend returned an invalid presigned upload");
  }
  const headers = payload.headers as Record<string, string>;
  if (headers["If-None-Match"] !== "*" || headers["Content-Type"] !== "application/gzip") {
    throw new Error("backend did not protect the immutable release upload");
  }
  const uploaded = await fetch(payload.url, {
    method: "PUT",
    headers,
    body: archive,
    redirect: "error",
  });
  // 412 means an earlier run already stored this key. The CloudFront hash check that
  // follows proves it holds these exact bytes, so a partially published release can resume.
  if (!uploaded.ok && uploaded.status !== 412)
    throw new Error(
      `S3 upload failed (HTTP ${uploaded.status}); existing release keys must not be overwritten`,
    );
}

export async function publishS3Release(): Promise<void> {
  const version = requireEnvironmentVariable("RELEASE_VERSION");
  const token = requireEnvironmentVariable("CLI_UPLOAD_AUTH_KEY");
  const origin = parseServiceOrigin(requireEnvironmentVariable("AXON_SERVICE_ORIGIN"), {
    allowLoopbackHttp: false,
  });
  assertCanonicalSemVer(version, "release version");
  const root = resolveServiceUrl(origin, SERVICE_ENDPOINTS.release.base);
  const releaseDirectory = join(process.cwd(), "release");
  const versionRoot = `${root}/${encodeURIComponent(version)}`;
  const configuration: unknown = await Bun.file(
    join(releaseDirectory, "cli-release-config.json"),
  ).json();
  if (typeof configuration !== "object" || configuration === null || !(version in configuration)) {
    throw new Error("release configuration does not contain the requested version");
  }
  const entry = configuration[version as keyof typeof configuration] as Record<string, unknown>;

  // Verify every target locally and against the backend before uploading any of them.
  const prepared: PreparedArchive[] = [];
  for (const target of RELEASE_TARGETS) {
    const names = releaseAssetNames(target);
    const asset = Reflect.get(entry, target);
    const expected =
      typeof asset === "object" && asset !== null
        ? Reflect.get(asset, "archive_sha256")
        : undefined;
    const archive = Bun.file(join(releaseDirectory, names.archive));
    if (
      typeof expected !== "string" ||
      !/^[0-9a-f]{64}$/.test(expected) ||
      !(await archive.exists())
    ) {
      throw new Error(`${target} release archive or SHA-256 is missing`);
    }
    const localHash = new Bun.CryptoHasher("sha256")
      .update(await archive.arrayBuffer())
      .digest("hex");
    if (localHash !== expected)
      throw new Error(`local ${target} archive does not match the prepared release`);
    await assertBackendChecksums(
      `${versionRoot}/${names.checksums}`,
      join(releaseDirectory, names.checksums),
    );
    prepared.push({ target, archive, expected });
  }
  await assertBackendChecksums(
    `${versionRoot}/${LEGACY_CHECKSUMS_NAME}`,
    join(releaseDirectory, LEGACY_CHECKSUMS_NAME),
  );

  for (const upload of prepared) {
    await uploadArchive(root, token, version, upload);
    // Download through the same public CloudFront path as users, not an S3 HEAD/ETag.
    await verifyCloudFrontArchive(
      `${versionRoot}/${releaseAssetNames(upload.target).archive}`,
      upload.expected,
    );
  }
  console.log(
    `Published and verified axon ${version} for ${RELEASE_TARGETS.join(" and ")}. Now set CLI_RELEASES.LATEST_VERSION in backend config.json and restart it.`,
  );
}

if (import.meta.main) {
  try {
    await publishS3Release();
  } catch {
    // Network errors can contain a presigned URL; never emit one into CI or terminal logs.
    console.error(
      "Publishing failed. Check backend configuration, credentials, and release assets.",
    );
    process.exitCode = 1;
  }
}
