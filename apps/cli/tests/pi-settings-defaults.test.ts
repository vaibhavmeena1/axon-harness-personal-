import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPiDefaults } from "../src/harnesses/pi/settings-defaults.ts";
import { withFileLock } from "../src/launcher/file-lock.ts";
import { type AxonPaths, resolveAxonPaths } from "../src/product/paths.ts";

let root: string;
let paths: AxonPaths;
let settingsPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-pi-defaults-"));
  paths = resolveAxonPaths({ AXON_HOME: root });
  settingsPath = join(paths.pi, "settings.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSettings(config: Record<string, unknown>): Promise<void> {
  await mkdir(paths.pi, { recursive: true });
  await Bun.write(settingsPath, JSON.stringify(config));
}

describe("managed Pi startup defaults", () => {
  test("creates additive codemode defaults without configuring inlineBudget", async () => {
    await applyPiDefaults(paths, { codemodeEnabled: true });
    expect(await Bun.file(settingsPath).json()).toEqual({ defaultTools: ["+codemode"] });
    expect((await lstat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  test("preserves other tools, package metadata, and explicit codemode preferences", async () => {
    const settings = {
      packages: ["npm:custom", { source: "npm:other", extensions: ["entry.ts"] }],
      defaultTools: ["read", "grep", "-bash", "-codemode", "+codemode"],
      codemode: { mode: "only", inlineBudget: 0 },
      theme: "custom",
    };
    await writeSettings(settings);
    await applyPiDefaults(paths, { codemodeEnabled: true });
    expect(await Bun.file(settingsPath).json()).toEqual({
      ...settings,
      defaultTools: ["read", "grep", "-bash", "+codemode"],
    });
  });

  test("repeated enable and disable are idempotent and retain other selections", async () => {
    await writeSettings({ defaultTools: ["-bash", "+grep"] });
    for (const codemodeEnabled of [true, false]) {
      await applyPiDefaults(paths, { codemodeEnabled });
      const status = await lstat(settingsPath);
      const content = await Bun.file(settingsPath).text();
      await applyPiDefaults(paths, { codemodeEnabled });
      expect(await Bun.file(settingsPath).text()).toBe(content);
      expect((await lstat(settingsPath)).ino).toBe(status.ino);
      expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([
        "-bash",
        "+grep",
        codemodeEnabled ? "+codemode" : "-codemode",
      ]);
    }
  });

  test("an empty selection does not restore built-in tools when codemode is enabled", async () => {
    await writeSettings({ defaultTools: [] });
    await applyPiDefaults(paths, { codemodeEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([]);
    await applyPiDefaults(paths, { codemodeEnabled: true });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["codemode"]);
    const status = await lstat(settingsPath);
    await applyPiDefaults(paths, { codemodeEnabled: true });
    expect((await lstat(settingsPath)).ino).toBe(status.ino);
    await applyPiDefaults(paths, { codemodeEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["codemode", "-codemode"]);
  });

  test("an explicitly selected codemode keeps the user's replacement selection", async () => {
    await writeSettings({ defaultTools: ["grep", "codemode"] });
    await applyPiDefaults(paths, { codemodeEnabled: true });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["grep", "codemode"]);
    await applyPiDefaults(paths, { codemodeEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([
      "grep",
      "codemode",
      "-codemode",
    ]);
  });

  test("invalid local settings are never overwritten", async () => {
    for (const current of ["{", "[]", '{"defaultTools":true}', '{"defaultTools":[1]}']) {
      await mkdir(paths.pi, { recursive: true });
      await Bun.write(settingsPath, current);
      await expect(applyPiDefaults(paths, { codemodeEnabled: true })).rejects.toThrow();
      expect(await Bun.file(settingsPath).text()).toBe(current);
    }
  });

  test("symlinked settings and their target are left untouched", async () => {
    const target = join(root, "standalone-settings.json");
    await Bun.write(target, "{}");
    await mkdir(paths.pi, { recursive: true });
    await symlink(target, settingsPath);
    await expect(applyPiDefaults(paths, { codemodeEnabled: true })).rejects.toThrow();
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe("{}");
  });

  test("shares the package lock and reads the latest settings after acquiring it", async () => {
    await writeSettings({ packages: ["initial"] });
    let update: Promise<void> | undefined;
    await withFileLock(paths.piPackageLock, async () => {
      update = applyPiDefaults(paths, { codemodeEnabled: true });
      await writeSettings({ packages: ["concurrent-package-update"] });
    });
    await update;
    expect(await Bun.file(settingsPath).json()).toEqual({
      packages: ["concurrent-package-update"],
      defaultTools: ["+codemode"],
    });
  });
});
