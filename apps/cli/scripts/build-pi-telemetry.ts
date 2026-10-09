import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TELEMETRY_ENTRY = "src/harnesses/pi/telemetry/src/index.ts";
const TELEMETRY_OUTPUT = "src/harnesses/pi/resources/extensions/pi-org-telemetry.mjs";
const UPSTREAM_LICENSE = "src/harnesses/pi/telemetry/LICENSE";
const OPENTELEMETRY_LICENSE = "node_modules/@opentelemetry/api/LICENSE";

export interface BuildPiTelemetryOptions {
  readonly check?: boolean;
  readonly repositoryRoot?: string;
}

async function legalBanner(repositoryRoot: string): Promise<string> {
  const [upstreamLicense, openTelemetryLicense] = await Promise.all([
    Bun.file(join(repositoryRoot, UPSTREAM_LICENSE)).text(),
    Bun.file(join(repositoryRoot, OPENTELEMETRY_LICENSE)).text(),
  ]);
  const escapeComment = (text: string): string => text.replaceAll("*/", "* /").trim();

  return `/*!
 * GENERATED FILE - DO NOT EDIT.
 * Build with: bun run telemetry:build
 *
 * pi-org-telemetry upstream license:
 * ${escapeComment(upstreamLicense).replaceAll("\n", "\n * ")}
 *
 * Bundled OpenTelemetry dependencies are licensed under Apache-2.0:
 * ${escapeComment(openTelemetryLicense).replaceAll("\n", "\n * ")}
 */\n`.replace(/[ \t]+$/gm, "");
}

async function buildBundle(repositoryRoot: string): Promise<string> {
  const temporaryDirectory = join(
    repositoryRoot,
    "node_modules",
    ".cache",
    `axon-telemetry-${process.pid}-${crypto.randomUUID()}`,
  );
  const temporaryOutput = join(temporaryDirectory, "pi-org-telemetry.mjs");
  await mkdir(temporaryDirectory, { recursive: true });

  try {
    const result = await Bun.build({
      entrypoints: [join(repositoryRoot, TELEMETRY_ENTRY)],
      external: ["@earendil-works/pi-coding-agent"],
      format: "esm",
      minify: true,
      outdir: temporaryDirectory,
      naming: "pi-org-telemetry.mjs",
      target: "node",
    });
    if (!result.success) {
      const details = result.logs.map((log) => log.message).join("\n");
      throw new Error(
        `could not bundle the Pi telemetry extension${details ? `:\n${details}` : ""}`,
      );
    }

    const bundle = await Bun.file(temporaryOutput).text();
    // Minified SDK multiline templates retain trailing spaces and space-before-tab indents.
    // Escape that literal whitespace without changing runtime text or reproducibility.
    const normalized = bundle
      .replace(/^( +)\t/gm, "$1\\t")
      .replace(/[ \t]+$/gm, (whitespace) =>
        whitespace.replaceAll(" ", "\\x20").replaceAll("\t", "\\t"),
      );
    return `${await legalBanner(repositoryRoot)}${normalized}`;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function buildPiTelemetry(options: BuildPiTelemetryOptions = {}): Promise<void> {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const outputPath = join(repositoryRoot, TELEMETRY_OUTPUT);
  const expected = await buildBundle(repositoryRoot);

  if (options.check) {
    const current = await Bun.file(outputPath)
      .text()
      .catch(() => undefined);
    if (current !== expected) {
      throw new Error(
        `${TELEMETRY_OUTPUT} is stale; run \`bun run telemetry:build\` and commit the result`,
      );
    }
    console.log(`Verified ${TELEMETRY_OUTPUT}.`);
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, expected);
  console.log(`Built ${TELEMETRY_OUTPUT}.`);
}

if (import.meta.main) {
  try {
    await buildPiTelemetry({ check: process.argv.slice(2).includes("--check") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
