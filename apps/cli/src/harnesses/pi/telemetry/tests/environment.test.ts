import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  describeEnvironment,
  PI_ORG_TELEMETRY_VERSION,
  readExtensionVersion,
  readPiVersion,
} from "../src/environment.ts";

test("uses the version embedded in the standalone DeputyDev extension", () => {
  assert.equal(readExtensionVersion(), PI_ORG_TELEMETRY_VERSION);
  assert.equal(readExtensionVersion(), "0.3.0-deputydev.1");
});

test("falls back when pi cannot be imported", async () => {
  assert.equal(
    await readPiVersion(async () => {
      throw new Error("not resolvable");
    }),
    undefined,
  );
  assert.equal(await readPiVersion(async () => ({ VERSION: 42 })), undefined);
  assert.equal(await readPiVersion(async () => ({ VERSION: "0.85.1" })), "0.85.1");
});

test("maps platform and arch to semantic-convention values", () => {
  const environment = describeEnvironment("0.85.1", "0.2.0", "win32", "x64", {
    node: "22.19.0",
  } as NodeJS.ProcessVersions);
  assert.deepEqual(environment, {
    extensionVersion: "0.2.0",
    piVersion: "0.85.1",
    osType: "windows",
    hostArch: "amd64",
    runtimeName: "node",
    runtimeVersion: "22.19.0",
  });
  const bun = describeEnvironment(undefined, "0.2.0", "darwin", "arm64", {
    node: "22.0.0",
    bun: "1.2.0",
  } as unknown as NodeJS.ProcessVersions);
  assert.equal(bun.runtimeName, "bun");
  assert.equal(bun.runtimeVersion, "1.2.0");
  assert.equal(bun.osType, "darwin");
  assert.equal("piVersion" in bun, false);
});
