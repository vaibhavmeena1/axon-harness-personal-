import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the real release scripts in isolation. Stub only native build/sign tools
// and remote HTTP: no production build, upload, browser, or network side effects.
test("release compilation, preparation and publication preserve the production base path", async () => {
  const root = await mkdtemp(join(tmpdir(), "axon-release-base-"));
  const prepare = new URL("../scripts/prepare-s3-release.ts", import.meta.url).href;
  const publish = new URL("../scripts/publish-s3-release.ts", import.meta.url).href;
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  await Bun.write(join(root, "package.json"), JSON.stringify({ ...manifest, version: "0.2.0" }));
  await Bun.write(
    join(root, "pi-version.json"),
    Bun.file(new URL("../pi-version.json", import.meta.url)),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "arm64" });
      const spawn = Bun.spawn;
      let compiledBase;
      Bun.spawn = (argv, options) => {
        if (argv[1] === "build" && argv.includes("--compile")) {
          compiledBase = argv.find(arg => arg.startsWith("BUILD_SERVICE_ORIGIN="));
          const output = argv[argv.indexOf("--outfile") + 1];
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, "#!/bin/sh\\nprintf '%s\\\\n' '0.2.0'\\n", { mode: 0o755 });
          writeFileSync(output + ".map", "{}");
          return spawn([process.execPath, "--eval", ""], options);
        }
        if (argv[0] === "lipo")
          return spawn([process.execPath, "--eval", "console.log('arm64')"], options);
        if (argv[0] === "codesign") return spawn([process.execPath, "--eval", ""], options);
        return spawn(argv, options);
      };
      // Re-preparing over a larger artifact must not retain its trailing bytes.
      mkdirSync("release", { recursive: true });
      writeFileSync("release/axon-darwin-arm64.gz", Buffer.alloc(1024 * 1024, 0xff));
      const { prepareS3Release } = await import(${JSON.stringify(prepare)});
      await prepareS3Release();
      const gzipCheck = spawn(["gzip", "-t", "release/axon-darwin-arm64.gz"], {
        stdout: "pipe", stderr: "pipe",
      });
      assert.equal(await gzipCheck.exited, 0, "prepared archive must have no trailing garbage");
      assert.equal(compiledBase, 'BUILD_SERVICE_ORIGIN="https://deputydev.ai/axon"');
      const config = await Bun.file("release/cli-release-config.json").json();
      const entry = config["0.2.0"];
      assert.equal(entry.s3_key, "axon-prod/cli/releases/0.2.0/axon-darwin-arm64.gz");
      const metadata = await Bun.file("release/release-metadata.json").json();
      const base = "https://deputydev.ai/axon/api/v1/cli/releases";
      assert.equal(metadata.assetUrl, base + "/0.2.0/axon-darwin-arm64.gz");
      const bytes = await Bun.file("release/axon-darwin-arm64.gz").arrayBuffer();
      assert.equal(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), entry.archive_sha256);
      const checksums = await Bun.file("release/checksums.txt").text();
      const calls = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        calls.push([request.method, request.url]);
        if (request.url === base + "/0.2.0/checksums.txt") return new Response(checksums);
        if (request.url === base + "/uploads/presign") {
          assert.equal(request.method, "POST");
          assert.equal(request.headers.get("authorization"), "Bearer synthetic-upload-secret");
          assert.deepEqual(await request.json(), { version: "0.2.0" });
          return Response.json({ url: "https://storage.example.test/upload", headers: {
            "If-None-Match": "*", "Content-Type": "application/gzip",
          } });
        }
        if (request.url === "https://storage.example.test/upload") {
          assert.equal(request.method, "PUT");
          assert.equal(request.headers.get("if-none-match"), "*");
          assert.equal(new Bun.CryptoHasher("sha256").update(await request.arrayBuffer()).digest("hex"), entry.archive_sha256);
          return new Response(null);
        }
        if (request.url === metadata.assetUrl)
          return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/archive" } });
        if (request.url === "https://cdn.example.test/archive") return new Response(bytes);
        throw new Error("Unexpected release request: " + request.url);
      };
      const { publishS3Release } = await import(${JSON.stringify(publish)});
      await publishS3Release();
      assert.deepEqual(calls, [
        ["GET", base + "/0.2.0/checksums.txt"],
        ["POST", base + "/uploads/presign"],
        ["PUT", "https://storage.example.test/upload"],
        ["GET", metadata.assetUrl],
        ["GET", "https://cdn.example.test/archive"],
      ]);
      `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        RELEASE_VERSION: "0.2.0",
        BUILD_COMMIT: "a".repeat(40),
        AXON_SERVICE_ORIGIN: "https://deputydev.ai/axon",
        RELEASE_KEY_PREFIX: "axon-prod/cli/releases/",
        CLI_UPLOAD_AUTH_KEY: "synthetic-upload-secret",
        RELEASE_BINARY_PATH: "",
        BUILD_TARGET: "darwin-arm64",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("Published and verified axon 0.2.0");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
