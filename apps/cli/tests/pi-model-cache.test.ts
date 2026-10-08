import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import { FileModelsStore } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
import { invalidateStalePiRelayModels } from "../src/harnesses/pi/model-cache.ts";
import { type DeputyDevPaths, resolveDeputyDevPaths } from "../src/product/paths.ts";

let root: string;
let paths: DeputyDevPaths;
let cachePath: string;
const relayOrigin = "http://127.0.0.1:54321";
const staleUrl = "http://127.0.0.1:54320/litellm/v1";
const model = (baseUrl = staleUrl, id = "test-model") => ({
  id,
  provider: "litellm",
  baseUrl,
  litellmDiscoveryVersion: 6,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ddcli-pi-model-cache-"));
  paths = resolveDeputyDevPaths({ DEPUTYDEV_HOME: root });
  cachePath = join(paths.pi, "models-store.json");
  await mkdir(paths.pi);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCache(value: unknown): Promise<void> {
  await writeFile(cachePath, JSON.stringify(value), { mode: 0o640 });
}

async function expectNoArtifacts(): Promise<void> {
  expect(await readdir(paths.pi)).toEqual(["models-store.json"]);
}

describe("managed Pi relay model cache", () => {
  test("removes the previous launch's catalog so it cannot override fresh discovery", async () => {
    const oldRelay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const newRelay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const oldModels = [
        model(`${oldRelay.url.origin}/litellm/v1`, "first"),
        model(`${oldRelay.url.origin}/litellm`, "second"),
      ];
      const otherProvider = { models: [], checkedAt: 9, etag: "keep" };
      await writeCache({
        litellm: { models: oldModels, checkedAt: 10 },
        openrouter: otherProvider,
      });
      // Use Pi's actual reader, including its in-process revision cache.
      const store = new FileModelsStore(cachePath);
      expect((await store.read("litellm"))?.models).toEqual(oldModels);
      expect(await invalidateStalePiRelayModels(paths, newRelay.url.origin)).toBe(2);
      expect(await store.read("litellm")).toBeUndefined();
      expect(await store.read("openrouter")).toEqual(otherProvider);
      expect(await invalidateStalePiRelayModels(paths, newRelay.url.origin)).toBe(0);
      await expectNoArtifacts();
    } finally {
      oldRelay.stop(true);
      newRelay.stop(true);
    }
  });

  test("preserves current relay models, custom endpoints, aliases, and unrelated metadata", async () => {
    const keep = [
      model(`${relayOrigin}/litellm/v1`, "current"),
      model("https://litellm.example.test/v1", "remote"),
      model("http://localhost:4000/litellm/v1", "local-custom"),
      model("http://127.0.0.1:4000/v1", "local-direct"),
      model("http://127.0.0.1:4000/litellm/other", "different-path"),
      model("https://127.0.0.1:4000/litellm/v1", "https"),
      model("http://127.0.0.1/litellm/v1", "no-port"),
      model("http://user@127.0.0.1:4000/litellm/v1", "user-info"),
      model("http://127.0.0.1:4000/litellm/v1?custom=1", "query"),
      model("http://127.0.0.1:4000/litellm/v1#custom", "fragment"),
      model("invalid-url", "invalid-url"),
      { ...model(), provider: "custom-litellm" },
      null,
    ];
    const entry = {
      models: [...keep, model(), model("http://127.0.0.1:54320/litellm/")],
      checkedAt: 123,
      custom: { keep: true },
    };
    const cache = {
      litellm: entry,
      "custom-litellm": { models: [model()] },
      openrouter: { models: [model()] },
      extra: "keep",
    };
    await writeCache(cache);
    expect(await invalidateStalePiRelayModels(paths, relayOrigin)).toBe(2);
    expect(await Bun.file(cachePath).json()).toEqual({
      ...cache,
      litellm: { ...entry, models: keep },
    });
    expect((await lstat(cachePath)).mode & 0o777).toBe(0o640);
    await expectNoArtifacts();
  });

  test("does not rewrite an unchanged file or create a missing cache", async () => {
    expect(await invalidateStalePiRelayModels(paths, relayOrigin)).toBe(0);
    expect(await readdir(paths.pi)).toEqual([]);
    await writeCache({ litellm: { models: [model(`${relayOrigin}/litellm/v1`)] } });
    const before = await lstat(cachePath);
    const content = await Bun.file(cachePath).text();
    expect(await invalidateStalePiRelayModels(paths, relayOrigin)).toBe(0);
    expect(await Bun.file(cachePath).text()).toBe(content);
    expect((await lstat(cachePath)).ino).toBe(before.ino);
    await expectNoArtifacts();
  });

  test("leaves malformed caches unchanged", async () => {
    for (const content of ["{", "[]", "null", '{"litellm":null}', '{"litellm":{"models":false}}']) {
      await writeFile(cachePath, content);
      await expect(invalidateStalePiRelayModels(paths, relayOrigin)).rejects.toThrow();
      expect(await Bun.file(cachePath).text()).toBe(content);
      await expectNoArtifacts();
    }
  });

  test("understands Pi's BOM-prefixed JSON", async () => {
    await writeFile(
      cachePath,
      `\uFEFF{"litellm":{"models":[${JSON.stringify(model())}]},"extra":1}`,
    );
    expect(await invalidateStalePiRelayModels(paths, relayOrigin)).toBe(1);
    expect(await Bun.file(cachePath).json()).toEqual({ extra: 1 });
  });

  test("refuses symlinked cache files and preserves the link target", async () => {
    const target = join(root, "custom-cache.json");
    const content = JSON.stringify({ litellm: { models: [model()] } });
    await writeFile(target, content);
    await symlink(target, cachePath);
    await expect(invalidateStalePiRelayModels(paths, relayOrigin)).rejects.toThrow();
    expect((await lstat(cachePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe(content);
    await expectNoArtifacts();
  });

  test("refuses symlinked Pi directories", async () => {
    await rm(paths.pi, { recursive: true });
    const target = join(root, "standalone-pi");
    await mkdir(target);
    const content = JSON.stringify({ litellm: { models: [model()] } });
    await writeFile(join(target, "models-store.json"), content);
    await symlink(target, paths.pi);
    await expect(invalidateStalePiRelayModels(paths, relayOrigin)).rejects.toThrow();
    expect(await Bun.file(join(target, "models-store.json")).text()).toBe(content);
    expect(await readdir(target)).toEqual(["models-store.json"]);
  });

  test("refuses hardlinked or oversized caches", async () => {
    await writeCache({ litellm: { models: [model()] } });
    const target = join(root, "hardlinked-cache.json");
    await link(cachePath, target);
    await expect(invalidateStalePiRelayModels(paths, relayOrigin)).rejects.toThrow();
    expect(await Bun.file(target).text()).toBe(await Bun.file(cachePath).text());
    await rm(target);
    await writeFile(cachePath, " ".repeat(16 * 1024 * 1024 + 1));
    const before = await lstat(cachePath);
    await expect(invalidateStalePiRelayModels(paths, relayOrigin)).rejects.toThrow();
    expect((await lstat(cachePath)).ino).toBe(before.ino);
    await expectNoArtifacts();
  });

  test("shares Pi's lock, skips contention, and preserves the latest concurrent update", async () => {
    await writeCache({ litellm: { models: [model()] }, openrouter: { models: [], checkedAt: 1 } });
    const release = await lockfile.lock(cachePath, { realpath: false, retries: 0, stale: 30_000 });
    const content = await Bun.file(cachePath).text();
    try {
      await expect(invalidateStalePiRelayModels(paths, relayOrigin)).rejects.toMatchObject({
        code: "ELOCKED",
      });
      expect(await Bun.file(cachePath).text()).toBe(content);
      // Pi's native reader must also wait on precisely this lock.
      await expect(
        new FileModelsStore(cachePath).read("litellm", { signal: AbortSignal.timeout(50) }),
      ).rejects.toThrow();
    } finally {
      await release();
    }
    const store = new FileModelsStore(cachePath);
    await store.write("openrouter", { models: [], checkedAt: 2, etag: "concurrent-update" });
    expect(await invalidateStalePiRelayModels(paths, relayOrigin)).toBe(1);
    expect(await store.read("openrouter")).toEqual({
      models: [],
      checkedAt: 2,
      etag: "concurrent-update",
    });
    await expectNoArtifacts();
  });

  test("rejects invalid active relay URLs without modifying the cache", async () => {
    await writeCache({ litellm: { models: [model()] } });
    const content = await Bun.file(cachePath).text();
    for (const origin of [
      "https://example.test",
      "http://localhost:54321",
      `${relayOrigin}/litellm`,
      `${relayOrigin}?key=private`,
    ]) {
      await expect(invalidateStalePiRelayModels(paths, origin)).rejects.toThrow();
      expect(await Bun.file(cachePath).text()).toBe(content);
    }
    await expectNoArtifacts();
  });
});
