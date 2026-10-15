import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadEncryptedSession,
  refreshEncryptedSession,
  SESSION_FILE_NAME,
  saveEncryptedSession,
} from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const roots: string[] = [];
async function fixture() {
  const userHome = await mkdtemp(join(tmpdir(), "axon-shared-auth-"));
  roots.push(userHome);
  const first = resolveAxonPaths({ AXON_HOME: join(userHome, "first-axon") }, userHome);
  const second = resolveAxonPaths({ AXON_HOME: join(userHome, "second-axon") }, userHome);
  return { userHome, first, second };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("authentication is shared per OS user, independent of AXON_HOME", async () => {
  const { userHome, first, second } = await fixture();
  expect(first.sharedAuthFile).toBe(join(userHome, ".deputydev", SESSION_FILE_NAME));
  expect(second.sharedAuthFile).toBe(first.sharedAuthFile);
  expect(second.sharedAuthLock).toBe(first.sharedAuthLock);
  expect(first.sharedAuthLock).toBe(join(userHome, ".deputydev", "locks", "session.lock"));
  await saveEncryptedSession(first, "one-shared-token");
  expect(await loadEncryptedSession(second)).toBe("one-shared-token");
  expect(await Bun.file(first.home).exists()).toBe(false);
  expect(await Bun.file(second.home).exists()).toBe(false);
});

test("reads DeputyDev's exact extension token, never the separate CLI token", async () => {
  const { first } = await fixture();
  await mkdir(first.sharedAuthDirectory);
  await Bun.write(
    first.sharedAuthFile,
    JSON.stringify({
      extension_auth_token: "existing-deputydev-token",
      cli_auth_token: "different-cli-token",
    }),
  );
  expect(await loadEncryptedSession(first)).toBe("existing-deputydev-token");
  await Bun.write(first.sharedAuthFile, JSON.stringify({ cli_auth_token: "different-cli-token" }));
  expect(await loadEncryptedSession(first)).toBeUndefined();
});

test("login and rotation update the same DeputyDev file while preserving unrelated keys", async () => {
  const { first, second } = await fixture();
  await mkdir(first.sharedAuthDirectory);
  await Bun.write(
    first.sharedAuthFile,
    JSON.stringify({
      extension_auth_token: "deputydev-token",
      cli_auth_token: "keep-cli-token",
      other: { keep: true },
    }),
  );
  await saveEncryptedSession(first, "axon-login-token");
  expect(await refreshEncryptedSession(second, "axon-login-token", "rotated-token")).toBe(true);
  expect(await Bun.file(first.sharedAuthFile).json()).toEqual({
    extension_auth_token: "rotated-token",
    cli_auth_token: "keep-cli-token",
    other: { keep: true },
  });
  expect((await stat(first.sharedAuthFile)).mode & 0o777).toBe(0o600);
});

test("external token rotations are reloaded and stale Axon responses cannot overwrite them", async () => {
  const { first, second } = await fixture();
  await saveEncryptedSession(first, "original-token");
  // DeputyDev writes this JSON directly, without using Axon's session API.
  await Bun.write(
    first.sharedAuthFile,
    JSON.stringify({
      extension_auth_token: "externally-rotated-token",
      cli_auth_token: "keep-cli-token",
    }),
  );
  expect(await loadEncryptedSession(second)).toBe("externally-rotated-token");
  expect(await refreshEncryptedSession(first, "original-token", "stale-response")).toBe(false);
  expect(await loadEncryptedSession(first)).toBe("externally-rotated-token");
});

test("different AXON_HOME instances serialize refreshes against one shared credential", async () => {
  const { first, second } = await fixture();
  await saveEncryptedSession(first, "original-token");
  const results = await Promise.all([
    refreshEncryptedSession(first, "original-token", "first-rotation"),
    refreshEncryptedSession(second, "original-token", "second-rotation"),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await loadEncryptedSession(second)).toBe(
    results[0] ? "first-rotation" : "second-rotation",
  );
});

test("does not fall back to or migrate an old .axon authentication file", async () => {
  const { first } = await fixture();
  await mkdir(first.home);
  const oldFile = join(first.home, SESSION_FILE_NAME);
  await Bun.write(oldFile, JSON.stringify({ extension_auth_token: "obsolete-axon-token" }));
  expect(await loadEncryptedSession(first)).toBeUndefined();
  await saveEncryptedSession(first, "shared-token");
  expect(await Bun.file(oldFile).json()).toEqual({ extension_auth_token: "obsolete-axon-token" });
  expect((await Bun.file(first.sharedAuthFile).json()).extension_auth_token).toBe("shared-token");
});
