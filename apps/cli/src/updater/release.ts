import { stat } from "node:fs/promises";
import { join } from "node:path";

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const ARCHIVE = "axon-darwin-arm64.gz";
const BINARY = "axon-darwin-arm64";

export interface ReleaseClient {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}

export function assertReleaseVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error("release version is not canonical semantic version syntax");
  }
}

async function request(
  client: ReleaseClient,
  url: string,
  followRedirect: boolean,
): Promise<Response> {
  const fetcher = client.fetcher ?? fetch;
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(current, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (followRedirect && response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("release redirect has no location");
      const next = new URL(location, current);
      // In production only HTTPS redirects are allowed. Loopback HTTP is for dev/tests.
      const development =
        client.baseUrl.startsWith("http://localhost:") ||
        client.baseUrl.startsWith("http://127.0.0.1:");
      if (
        next.protocol !== "https:" &&
        !(
          development &&
          next.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(next.hostname)
        )
      ) {
        throw new Error("release redirect must use HTTPS");
      }
      await response.body?.cancel();
      current = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`release request failed (HTTP ${response.status})`);
    }
    return response;
  }
  throw new Error("too many release redirects");
}

async function smallText(client: ReleaseClient, path: string): Promise<string> {
  const response = await request(client, `${client.baseUrl}/${path}`, false);
  if (!response.body) throw new Error("release metadata has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error("release metadata is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function latestReleaseVersion(client: ReleaseClient): Promise<string> {
  const value = await smallText(client, "latest/VERSION");
  if (!value.endsWith("\n") || value.includes("\r") || value.indexOf("\n") !== value.length - 1) {
    throw new Error("release VERSION must contain exactly one line");
  }
  const version = value.slice(0, -1);
  assertReleaseVersion(version);
  return version;
}

export interface ReleaseHashes {
  readonly archive: string;
  readonly binary: string;
}

export async function releaseHashes(
  client: ReleaseClient,
  version: string,
): Promise<ReleaseHashes> {
  assertReleaseVersion(version);
  const data = await smallText(client, `${encodeURIComponent(version)}/checksums.txt`);
  const lines = data.split("\n");
  if (lines.length !== 3 || lines[2] !== "") throw new Error("invalid release checksum file");
  const archive = lines[0]?.match(/^([0-9a-f]{64}) {2}axon-darwin-arm64\.gz$/)?.[1];
  const binary = lines[1]?.match(/^([0-9a-f]{64}) {2}axon-darwin-arm64$/)?.[1];
  if (!archive || !binary || !HASH_PATTERN.test(archive) || !HASH_PATTERN.test(binary)) {
    throw new Error("invalid release checksum file");
  }
  return { archive, binary };
}

async function writeBounded(
  source: ReadableStream<Uint8Array>,
  path: string,
  limit: number,
): Promise<void> {
  const reader = source.getReader();
  const writer = Bun.file(path).writer();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("release file exceeds maximum size");
      await writer.write(value);
    }
  } finally {
    await writer.end();
    await reader.cancel().catch(() => {});
  }
}

async function hashFile(path: string, maxSize: number): Promise<string> {
  const file = await stat(path);
  if (!file.isFile() || file.size === 0 || file.size > maxSize) {
    throw new Error("release file has invalid size");
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

export async function downloadVerifiedRelease(
  client: ReleaseClient,
  version: string,
  directory: string,
): Promise<string> {
  assertReleaseVersion(version);
  const expected = await releaseHashes(client, version);
  const archivePath = join(directory, ARCHIVE);
  const binaryPath = join(directory, BINARY);
  const response = await request(
    client,
    `${client.baseUrl}/${encodeURIComponent(version)}/${ARCHIVE}`,
    true,
  );
  if (!response.body) throw new Error("release archive has no body");
  await writeBounded(response.body, archivePath, MAX_ARCHIVE_BYTES);
  if ((await hashFile(archivePath, MAX_ARCHIVE_BYTES)) !== expected.archive) {
    throw new Error("compressed release SHA-256 mismatch");
  }

  const gzip = Bun.spawn(["gzip", "-dc", archivePath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    if (!gzip.stdout) throw new Error("gzip has no output");
    await writeBounded(gzip.stdout, binaryPath, MAX_BINARY_BYTES);
    if ((await gzip.exited) !== 0) throw new Error("release archive is not valid gzip data");
  } catch (error) {
    gzip.kill();
    await gzip.exited;
    throw error;
  }
  if ((await hashFile(binaryPath, MAX_BINARY_BYTES)) !== expected.binary) {
    throw new Error("decompressed release SHA-256 mismatch");
  }
  return binaryPath;
}
