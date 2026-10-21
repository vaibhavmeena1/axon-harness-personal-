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
      const compiledTargets = [];
      Bun.spawn = (argv, options) => {
        if (argv[1] === "build" && argv.includes("--compile")) {
          compiledBase = argv.find(arg => arg.startsWith("BUILD_SERVICE_ORIGIN="));
          compiledTargets.push(argv.find(arg => arg.startsWith("--target=")));
          const output = argv[argv.indexOf("--outfile") + 1];
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, "#!/bin/sh\\nprintf '%s\\\\n' '0.2.0'\\n", { mode: 0o755 });
          writeFileSync(output + ".map", "{}");
          return spawn([process.execPath, "--eval", ""], options);
        }
        if (argv[0] === "lipo") {
          const arch = argv[2].endsWith("x64") ? "x86_64" : "arm64";
          return spawn([process.execPath, "--eval", "console.log('" + arch + "')"], options);
        }
        if (argv[0] === "codesign") return spawn([process.execPath, "--eval", ""], options);
        return spawn(argv, options);
      };
      const targets = ["darwin-arm64", "darwin-x64"];
      // Re-preparing over a larger artifact must not retain its trailing bytes.
      mkdirSync("release", { recursive: true });
      writeFileSync("release/axon-darwin-arm64.gz", Buffer.alloc(1024 * 1024, 0xff));
      const { prepareS3Release } = await import(${JSON.stringify(prepare)});
      await prepareS3Release();
      assert.deepEqual(compiledTargets, targets.map(target => "--target=bun-" + target));
      assert.equal(compiledBase, 'BUILD_SERVICE_ORIGIN="https://deputydev.ai/axon"');
      const config = await Bun.file("release/cli-release-config.json").json();
      const metadata = await Bun.file("release/release-metadata.json").json();
      const base = "https://deputydev.ai/axon/api/v1/cli/releases";
      const archives = {};
      for (const target of targets) {
        const archive = "release/axon-" + target + ".gz";
        const gzipCheck = spawn(["gzip", "-t", archive], { stdout: "pipe", stderr: "pipe" });
        assert.equal(await gzipCheck.exited, 0, "prepared archive must have no trailing garbage");
        const entry = config["0.2.0"][target];
        assert.equal(entry.s3_key, "axon-prod/cli/releases/0.2.0/axon-" + target + ".gz");
        assert.equal(metadata.targets[target].assetUrl, base + "/0.2.0/axon-" + target + ".gz");
        const bytes = await Bun.file(archive).arrayBuffer();
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        assert.equal(hash, entry.archive_sha256);
        assert.match(await Bun.file("release/checksums-" + target + ".txt").text(), new RegExp("^" + hash + "  axon-" + target + "\\.gz\\n"));
        archives[target] = { bytes, hash };
      }
      // Installed pre-x64 launchers keep reading arm64 hashes from checksums.txt.
      assert.equal(
        await Bun.file("release/checksums.txt").text(),
        await Bun.file("release/checksums-darwin-arm64.txt").text(),
      );
      const { publishS3Release } = await import(${JSON.stringify(publish)});
      for (const existing of [false, true]) {
        const calls = [];
        let uploading;
        globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          calls.push([request.method, request.url]);
          const checksumFile = request.url.startsWith(base + "/0.2.0/checksums")
            ? request.url.slice((base + "/0.2.0/").length) : undefined;
          if (checksumFile) return new Response(await Bun.file("release/" + checksumFile).text());
          if (request.url === base + "/uploads/presign") {
            assert.equal(request.method, "POST");
            assert.equal(request.headers.get("authorization"), "Bearer synthetic-upload-secret");
            const body = await request.json();
            assert.equal(body.version, "0.2.0");
            uploading = body.target;
            return Response.json({ url: "https://storage.example.test/upload", headers: {
              "If-None-Match": "*", "Content-Type": "application/gzip",
            } });
          }
          if (request.url === "https://storage.example.test/upload") {
            assert.equal(request.method, "PUT");
            assert.equal(request.headers.get("if-none-match"), "*");
            assert.equal(new Bun.CryptoHasher("sha256").update(await request.arrayBuffer()).digest("hex"), archives[uploading].hash);
            // A resumed publication finds keys stored by an earlier run.
            return new Response(null, { status: existing ? 412 : 200 });
          }
          for (const target of targets) {
            if (request.url === metadata.targets[target].assetUrl)
              return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/" + target } });
            if (request.url === "https://cdn.example.test/" + target) return new Response(archives[target].bytes);
          }
          throw new Error("Unexpected release request: " + request.url);
        };
        await publishS3Release();
        assert.deepEqual(calls, [
          ["GET", base + "/0.2.0/checksums-darwin-arm64.txt"],
          ["GET", base + "/0.2.0/checksums-darwin-x64.txt"],
          ["GET", base + "/0.2.0/checksums.txt"],
          ...targets.flatMap(target => [
            ["POST", base + "/uploads/presign"],
            ["PUT", "https://storage.example.test/upload"],
            ["GET", metadata.targets[target].assetUrl],
            ["GET", "https://cdn.example.test/" + target],
          ]),
        ]);
      }
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
