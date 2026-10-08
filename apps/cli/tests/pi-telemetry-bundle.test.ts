import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildPiTelemetry } from "../scripts/build-pi-telemetry.ts";
import { PI_ORG_TELEMETRY_VERSION } from "../src/harnesses/pi/telemetry/src/environment.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const bundlePath = join(
  repositoryRoot,
  "src",
  "harnesses",
  "pi",
  "resources",
  "extensions",
  "pi-org-telemetry.mjs",
);

describe("embedded Pi telemetry bundle", () => {
  test("is deterministic and current", async () => {
    await buildPiTelemetry({ check: true, repositoryRoot });
  });

  test("is standalone apart from Pi's extension API", async () => {
    const source = await Bun.file(bundlePath).text();
    expect(source).toContain("GENERATED FILE - DO NOT EDIT");
    expect(source).toContain("Apache License");
    expect(source).toContain(PI_ORG_TELEMETRY_VERSION);
    expect(source).not.toContain('from"@opentelemetry/');
    expect(source).not.toContain("node_modules/@opentelemetry");

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "axon-telemetry-import-"));
    const stubDirectory = join(
      temporaryDirectory,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    try {
      await Bun.write(
        join(stubDirectory, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          type: "module",
          exports: "./index.js",
        }),
      );
      await Bun.write(join(stubDirectory, "index.js"), 'export const VERSION = "0.85.0";\n');
      const isolatedBundle = join(temporaryDirectory, "pi-org-telemetry.mjs");
      await Bun.write(isolatedBundle, source);

      const subprocess = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          'import(process.argv[1]).then((module) => { if (typeof module.default !== "function") process.exit(1); })',
          isolatedBundle,
        ],
        {
          cwd: temporaryDirectory,
          env: { PATH: Reflect.get(process.env, "PATH") ?? "" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
