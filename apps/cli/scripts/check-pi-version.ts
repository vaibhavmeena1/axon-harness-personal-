import { join } from "node:path";

import { assertCanonicalSemVer } from "./release-contract.ts";

/** Keep the embedded runtime pin and the Pi API used to typecheck extensions in sync. */
export async function checkPiVersion(directory: string = process.cwd()): Promise<string> {
  const [configuration, manifest] = await Promise.all([
    Bun.file(join(directory, "pi-version.json")).json() as Promise<{ version?: unknown }>,
    Bun.file(join(directory, "package.json")).json() as Promise<{
      devDependencies?: Record<string, string>;
    }>,
  ]);
  const version = configuration.version;
  if (typeof version !== "string") throw new Error("pi-version.json must contain a version");
  assertCanonicalSemVer(version, "Pi version");
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    if (manifest.devDependencies?.[name] !== version) {
      throw new Error(`${name} devDependency must match pi-version.json (${version})`);
    }
  }
  return version;
}

if (import.meta.main) {
  try {
    console.log(`Pi version ${await checkPiVersion()} matches development dependencies.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
