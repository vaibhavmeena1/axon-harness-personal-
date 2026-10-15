import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPiDefaults, applyPiProviderDefaults } from "../src/harnesses/pi/settings-defaults.ts";
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
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect(await Bun.file(settingsPath).json()).toEqual({
      defaultTools: ["+codemode"],
      litellm: { mcp: { enabled: false } },
    });
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
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect(await Bun.file(settingsPath).json()).toEqual({
      ...settings,
      defaultTools: ["read", "grep", "-bash", "+codemode"],
      litellm: { mcp: { enabled: false } },
    });
  });

  test("repeated enable and disable are idempotent and retain other selections", async () => {
    await writeSettings({ defaultTools: ["-bash", "+grep"] });
    for (const codemodeEnabled of [true, false]) {
      await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled: false });
      const status = await lstat(settingsPath);
      const content = await Bun.file(settingsPath).text();
      await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled: false });
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
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([]);
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["codemode"]);
    const status = await lstat(settingsPath);
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect((await lstat(settingsPath)).ino).toBe(status.ino);
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["codemode", "-codemode"]);
  });

  test("an explicitly selected codemode keeps the user's replacement selection", async () => {
    await writeSettings({ defaultTools: ["grep", "codemode"] });
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual(["grep", "codemode"]);
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: false });
    expect((await Bun.file(settingsPath).json()).defaultTools).toEqual([
      "grep",
      "codemode",
      "-codemode",
    ]);
  });

  test("codemode and LiteLLM MCP toggle independently without replacing other MCP preferences", async () => {
    const litellm = {
      skills: { enabled: false },
      mcp: { enabled: false, exposure: "deferred", toolExposure: { "*delete*": "hidden" } },
    };
    await writeSettings({ defaultTools: ["read"], litellm, theme: "custom" });
    for (const codemodeEnabled of [true, false]) {
      for (const litellmMcpEnabled of [true, false]) {
        await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled });
        expect(await Bun.file(settingsPath).json()).toEqual({
          defaultTools: ["read", codemodeEnabled ? "+codemode" : "-codemode"],
          litellm: { ...litellm, mcp: { ...litellm.mcp, enabled: litellmMcpEnabled } },
          theme: "custom",
        });
        const content = await Bun.file(settingsPath).text();
        const status = await lstat(settingsPath);
        await applyPiDefaults(paths, { codemodeEnabled, litellmMcpEnabled });
        expect(await Bun.file(settingsPath).text()).toBe(content);
        expect((await lstat(settingsPath)).ino).toBe(status.ino);
      }
    }
  });

  test("writes the default model only when managed and otherwise keeps the user's choice", async () => {
    const saved = { defaultProvider: "litellm", defaultModel: "anthropic/claude-local-pick" };
    await writeSettings({ ...saved, theme: "custom" });
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
    expect(await Bun.file(settingsPath).json()).toMatchObject(saved);

    const managed = { defaultProvider: "litellm", defaultModel: "openai/gpt-6.1-sol" };
    await applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false, ...managed });
    expect(await Bun.file(settingsPath).json()).toEqual({
      ...managed,
      theme: "custom",
      defaultTools: ["+codemode"],
      litellm: { mcp: { enabled: false } },
    });
  });

  test("provider fallback defaults off but preserves the last managed MCP preference", async () => {
    await applyPiProviderDefaults(paths);
    expect((await Bun.file(settingsPath).json()).litellm.mcp.enabled).toBe(false);
    await applyPiDefaults(paths, { codemodeEnabled: false, litellmMcpEnabled: true });
    await applyPiProviderDefaults(paths);
    expect((await Bun.file(settingsPath).json()).litellm.mcp.enabled).toBe(true);
  });

  test("invalid local settings are never overwritten", async () => {
    for (const current of [
      "{",
      "[]",
      '{"defaultTools":true}',
      '{"defaultTools":[1]}',
      '{"litellm":true}',
      '{"litellm":{"mcp":[]}}',
    ]) {
      await mkdir(paths.pi, { recursive: true });
      await Bun.write(settingsPath, current);
      await expect(
        applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false }),
      ).rejects.toThrow();
      expect(await Bun.file(settingsPath).text()).toBe(current);
    }
  });

  test("symlinked settings and their target are left untouched", async () => {
    const target = join(root, "standalone-settings.json");
    await Bun.write(target, "{}");
    await mkdir(paths.pi, { recursive: true });
    await symlink(target, settingsPath);
    await expect(
      applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false }),
    ).rejects.toThrow();
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe("{}");
  });

  test("shares the package lock and reads the latest settings after acquiring it", async () => {
    await writeSettings({ packages: ["initial"] });
    let update: Promise<void> | undefined;
    await withFileLock(paths.piPackageLock, async () => {
      update = applyPiDefaults(paths, { codemodeEnabled: true, litellmMcpEnabled: false });
      await writeSettings({ packages: ["concurrent-package-update"] });
    });
    await update;
    expect(await Bun.file(settingsPath).json()).toEqual({
      packages: ["concurrent-package-update"],
      defaultTools: ["+codemode"],
      litellm: { mcp: { enabled: false } },
    });
  });
});
