import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILD_INFO } from "../src/build-info.ts";
import { LAUNCHER_EXIT_STATUS } from "../src/launcher/exit-status.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import { latestReleaseVersion } from "../src/updater/release.ts";
import { runStartupUpdate } from "../src/updater/startup.ts";
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

async function fixture(
  binaryVersion = version,
  basePath = "",
  launchScript = "",
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "axon-update-"));
  roots.push(root);
  const paths = resolveAxonPaths({}, root);
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await chmod(paths.bin, 0o700);
  await Bun.write(paths.managedBinary, "old binary\n");
  await chmod(paths.managedBinary, 0o700);
  const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${binaryVersion}'; exit 0; fi\n${launchScript}\n`;
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

const interactive = { ci: false, stdinIsTty: true, stdoutIsTty: true };

async function startup(
  f: Fixture,
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = {},
) {
  const warnings: string[] = [];
  const restarts: (readonly string[])[] = [];
  await runStartupUpdate(args, {
    context: f.context,
    invocation: interactive,
    environment,
    warn: (message) => warnings.push(message),
    restart: async (_context, argumentsVector) => {
      restarts.push(argumentsVector);
    },
  });
  return { warnings, restarts };
}

describe("startup updates", () => {
  test("installs latest before continuing with unchanged Pi arguments, ignoring old throttle", async () => {
    const f = await fixture();
    await Bun.write(f.paths.updateState, JSON.stringify({ nextCheckAt: Date.now() + 86_400_000 }));
    const args = ["--resume", "session-id", "--", "hello world", "--offline"];
    const result = await startup(f, args);
    expect(await Bun.file(f.paths.managedBinary).text()).toContain(version);
    expect(result.restarts).toEqual([["pi", ...args]]);
    expect(result.warnings[0]).toContain(`updated to ${version}`);
  });

  test("checks every launch without restarting an up-to-date or newer binary", async () => {
    const f = await fixture();
    for (const latest of ["0.1.0", "0.0.9", "0.1.0"]) {
      f.setVersion(latest);
      expect(await startup(f)).toEqual({ warnings: [], restarts: [] });
    }
    expect(f.requests).toHaveLength(3);
    expect(await Bun.file(f.paths.managedBinary).text()).toBe("old binary\n");
  });

  test("warns and allows the old version on discovery, checksum, or managed-path failure", async () => {
    for (const failure of ["metadata", "checksum", "unmanaged"]) {
      const f = await fixture();
      if (failure === "metadata") f.setVersion("invalid");
      if (failure === "checksum") f.setHash("0".repeat(64));
      const result = await startup(
        failure === "unmanaged"
          ? { ...f, context: { ...f.context, executable: process.execPath } }
          : f,
      );
      expect(result.restarts).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("continuing with the current version");
      expect(await Bun.file(f.paths.managedBinary).text()).toBe("old binary\n");
    }
  });

  test("warns and continues if the updated launcher cannot start", async () => {
    const f = await fixture();
    const warnings: string[] = [];
    await runStartupUpdate([], {
      context: f.context,
      invocation: interactive,
      environment: {},
      restart: async () => {
        throw new Error("spawn failed");
      },
      warn: (message) => warnings.push(message),
    });
    expect(warnings.at(-1)).toContain("could not start the updated launcher");
  });

  test("skips offline, opted-out, administrative, scripted, CI, and source launches", async () => {
    const f = await fixture();
    for (const args of [
      ["--offline"],
      ["--help"],
      ["--version"],
      ["auth"],
      ["install", "npm:foo"],
      ["-p", "hi"],
      ["--mode", "rpc"],
    ]) {
      expect(await startup(f, args)).toEqual({ warnings: [], restarts: [] });
    }
    await startup(f, [], { AXON_NO_UPDATE: "1" });
    await startup(f, [], { PI_OFFLINE: "true" });
    for (const invocation of [
      { ...interactive, ci: true },
      { ...interactive, stdinIsTty: false },
      { ...interactive, stdoutIsTty: false },
    ]) {
      await runStartupUpdate([], { context: f.context, environment: {}, invocation });
    }
    await runStartupUpdate([], {
      context: { ...f.context, build: { ...f.context.build, kind: "dev" } },
      environment: {},
      invocation: interactive,
    });
    expect(f.requests).toEqual([]);
  });

  test("real relaunch preserves arguments, cwd, environment, and child exit/signal", async () => {
    for (const signal of [false, true]) {
      const f = await fixture(
        version,
        "",
        signal ? "kill -TERM $$" : `printf '%s\\n' "$PWD" "$STARTUP_TEST_VALUE" "$@"; exit 42`,
      );
      const runner = join(f.paths.home, "startup-runner.ts");
      const args = ["--resume", "session with spaces", "--", "hello world"];
      await Bun.write(
        runner,
        `
        import { runStartupUpdate } from ${JSON.stringify(join(import.meta.dir, "../src/updater/startup.ts"))};
        await runStartupUpdate(${JSON.stringify(args)}, {
          context: { ...${JSON.stringify(f.context)}, verifySignature: async () => {} },
          invocation: ${JSON.stringify(interactive)}, environment: {},
        });
        throw new Error("old launcher must not continue after a successful relaunch");
      `,
      );
      const child = Bun.spawn([process.execPath, runner], {
        cwd: f.paths.home,
        env: { ...process.env, STARTUP_TEST_VALUE: "inherited" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toContain(`updated to ${version}`);
      if (signal) {
        expect(child.signalCode).toBe("SIGTERM");
      } else {
        expect(child.exitCode).toBe(42);
        expect(output.trim().split("\n")).toEqual([
          await realpath(f.paths.home),
          "inherited",
          "pi",
          ...args,
        ]);
      }
    }
  });

  test("metadata timeout also bounds a stalled response body", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("0."));
            },
          }),
        ),
    });
    servers.push(server);
    await expect(
      latestReleaseVersion({ baseUrl: `http://127.0.0.1:${server.port}`, metadataTimeoutMs: 25 }),
    ).rejects.toThrow();
  });
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
