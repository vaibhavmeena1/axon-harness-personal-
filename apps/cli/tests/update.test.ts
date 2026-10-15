import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_INFO } from "../src/build-info.ts";
import { LAUNCHER_EXIT_STATUS } from "../src/launcher/exit-status.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import {
  checkForUpdate,
  installUpdate,
  runBackgroundUpdate,
  type UpdateContext,
} from "../src/updater/update.ts";

const roots: string[] = [];
const servers: Bun.Server<undefined>[] = [];
const version = "0.2.0";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface Fixture {
  readonly context: UpdateContext;
  readonly paths: ReturnType<typeof resolveAxonPaths>;
  readonly requests: string[];
  readonly setHash: (hash: string) => void;
  readonly setVersion: (version: string) => void;
}

async function fixture(binaryVersion = version, basePath = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "axon-update-"));
  roots.push(root);
  const paths = resolveAxonPaths({}, root);
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await chmod(paths.bin, 0o700);
  await Bun.write(paths.managedBinary, "old binary\n");
  await chmod(paths.managedBinary, 0o700);
  const script = `#!/bin/sh\n[ "$1" = "--version" ] && printf '%s\\n' '${binaryVersion}'\n`;
  const binary = new TextEncoder().encode(script);
  const archive = Bun.gzipSync(binary);
  let archiveHash = sha256(archive);
  let latest = version;
  const requests: string[] = [];
  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === `${basePath}/api/v1/cli/releases/latest/VERSION`)
        return new Response(`${latest}\n`);
      if (path === `${basePath}/api/v1/cli/releases/${version}/checksums.txt`) {
        return new Response(
          `${archiveHash}  axon-darwin-arm64.gz\n${sha256(binary)}  axon-darwin-arm64\n`,
        );
      }
      if (path === `${basePath}/api/v1/cli/releases/${version}/axon-darwin-arm64.gz`) {
        return Response.redirect(`http://127.0.0.1:${server.port}/archive`, 302);
      }
      if (path === "/archive") return new Response(archive);
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    context: {
      build: { ...BUILD_INFO, kind: "binary", version: "0.1.0", target: "darwin-arm64" },
      executable: paths.managedBinary,
      paths,
      client: { baseUrl: `${origin}${basePath}/api/v1/cli/releases` },
      verifySignature: async () => {},
    },
    paths,
    requests,
    setHash: (value) => {
      archiveHash = value;
    },
    setVersion: (value) => {
      latest = value;
    },
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("CLI manual and background updates", () => {
  test("compares embedded and configured versions without downloading on --check", async () => {
    const f = await fixture();
    expect(await checkForUpdate(f.context)).toBe(version);
    expect(f.requests).toEqual(["/api/v1/cli/releases/latest/VERSION"]);
    f.setVersion("0.1.0");
    expect(await checkForUpdate(f.context)).toBeUndefined();
    f.setVersion("invalid");
    expect(checkForUpdate(f.context)).rejects.toThrow("canonical semantic version");
  });

  test("downloads, hashes, probes and atomically replaces the managed binary", async () => {
    const f = await fixture();
    expect(await installUpdate(f.context)).toBe(version);
    expect(await Bun.file(f.paths.managedBinary).text()).toContain(version);
    expect(await Bun.file(f.paths.previousBinary).text()).toBe("old binary\n");
    expect(f.requests).toContain(`/api/v1/cli/releases/${version}/checksums.txt`);
    expect(f.requests).toContain("/archive");
    expect((await readdir(f.paths.bin)).filter((name) => name.startsWith(".axon-update-"))).toEqual(
      [],
    );
  });

  test("updates below /axon without prefixing the redirected storage URL", async () => {
    const f = await fixture(version, "/axon");
    expect(await installUpdate(f.context)).toBe(version);
    expect(f.requests).toEqual([
      "/axon/api/v1/cli/releases/latest/VERSION",
      `/axon/api/v1/cli/releases/${version}/checksums.txt`,
      `/axon/api/v1/cli/releases/${version}/axon-darwin-arm64.gz`,
      "/archive",
    ]);
  });

  test("never replaces an existing binary on checksum or version mismatch", async () => {
    const badHash = await fixture();
    badHash.setHash("0".repeat(64));
    await expect(installUpdate(badHash.context)).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    expect(await Bun.file(badHash.paths.managedBinary).text()).toBe("old binary\n");
    expect(await Bun.file(badHash.paths.previousBinary).exists()).toBe(false);

    const wrongVersion = await fixture("0.3.0");
    await expect(installUpdate(wrongVersion.context)).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    expect(await Bun.file(wrongVersion.paths.managedBinary).text()).toBe("old binary\n");
  });

  test("restores the original executable if the backup path cannot be replaced", async () => {
    const f = await fixture();
    await mkdir(f.paths.previousBinary);
    await expect(installUpdate(f.context)).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    expect(await Bun.file(f.paths.managedBinary).text()).toBe("old binary\n");
    expect((await stat(f.paths.previousBinary)).isDirectory()).toBe(true);
  });

  test("refuses to mutate an unmanaged executable or downgrade", async () => {
    const f = await fixture();
    await expect(
      installUpdate({ ...f.context, executable: process.execPath }),
    ).rejects.toMatchObject({
      exitStatus: LAUNCHER_EXIT_STATUS.updateFailure,
    });
    f.setVersion("0.0.9");
    expect(await installUpdate(f.context)).toBeUndefined();
    expect(await Bun.file(f.paths.managedBinary).text()).toBe("old binary\n");
  });

  test("background worker verifies once and respects the check interval", async () => {
    const f = await fixture();
    const ciVariable = "CI";
    const oldCI = process.env[ciVariable];
    delete process.env[ciVariable];
    try {
      await runBackgroundUpdate(f.context);
      expect(await Bun.file(f.paths.managedBinary).text()).toContain(version);
      expect((await stat(f.paths.updateState)).mode & 0o077).toBe(0);
      const count = f.requests.length;
      await runBackgroundUpdate({ ...f.context, executable: f.paths.managedBinary });
      expect(f.requests.length).toBe(count);
    } finally {
      if (oldCI !== undefined) process.env[ciVariable] = oldCI;
    }
  });
});
