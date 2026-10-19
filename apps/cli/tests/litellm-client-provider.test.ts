import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import providerPackage from "pi-provider-litellm/package.json";
import { parseClientConfig } from "../src/cli/client-config.ts";
import { createLiteLLMClientOverrides } from "../src/harnesses/pi/launch-preferences-environment.ts";

// Load published TS at runtime: it does not use Axon's stricter tsconfig flags.
// Keep the checked projection narrow without typechecking/forking third-party source.
type MetadataModel = {
  id: string;
  contextWindow: number;
  maxTokens: number;
  litellmBackendFamily?: string;
  compat?: { maxTokensField?: string; supportsStrictMode?: boolean };
  litellmPolicy?: { normalizeStrictToolMessages?: boolean };
};
const { discoverModels, enrichCachedModel } = (await import(
  Bun.resolveSync("pi-provider-litellm/src/discover.ts", import.meta.dir)
)) as {
  discoverModels: (
    base: string,
    key: string,
    options: { modelsDev: boolean; timeoutMs: number },
  ) => Promise<{ models: MetadataModel[] }>;
  enrichCachedModel: (model: MetadataModel) => MetadataModel;
};
const { toNativeModels } = (await import(
  Bun.resolveSync("pi-provider-litellm/src/provider.ts", import.meta.dir)
)) as {
  toNativeModels: (provider: string, base: string, models: MetadataModel[]) => MetadataModel[];
};

// Exercise the exact installed provider, not a reimplementation of its fallback rules.
test("pinned LiteLLM fallback respects authoritative metadata and does not promise to rewrite arbitrary cached windows", async () => {
  expect(providerPackage.version).toBe("4.3.1");
  let modelInfoAvailable = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      if (new URL(request.url).pathname === "/v1/models")
        return Response.json({ data: [{ id: "axon-opaque-missing" }] });
      if (modelInfoAvailable && new URL(request.url).pathname === "/model/info")
        return Response.json({
          data: [
            {
              model_name: "axon-opaque-known",
              model_info: { max_input_tokens: 64000, max_output_tokens: 4096 },
            },
            { model_name: "axon-opaque-missing", model_info: {} },
          ],
        });
      return new Response(null, { status: 404 });
    },
  });
  const previous = process.env["LITELLM_DEFAULT_CONTEXT_WINDOW"];
  try {
    const config = parseClientConfig({
      schemaVersion: 1,
      litellmClient: { defaultContextWindow: 256000 },
    });
    Object.assign(process.env, createLiteLLMClientOverrides(config.litellmClient));
    const discovered = await discoverModels(server.url.origin, "test-key", {
      modelsDev: false,
      timeoutMs: 1000,
    });
    const known = discovered.models.find((model) => model.id === "axon-opaque-known");
    const missing = discovered.models.find((model) => model.id === "axon-opaque-missing");
    assert.ok(known && missing);
    expect(known.contextWindow).toBe(64000);
    expect(known?.maxTokens).toBe(4096);
    expect(missing?.contextWindow).toBe(256000);
    modelInfoAvailable = false;
    const listOnly = await discoverModels(server.url.origin, "test-key", {
      modelsDev: false,
      timeoutMs: 1000,
    });
    const [cached] = toNativeModels("litellm", server.url.origin, listOnly.models);
    assert.ok(cached);
    // Offline cache enrichment recognizes the built-in sentinel and current fallback.
    expect(enrichCachedModel({ ...cached, contextWindow: 128000 }).contextWindow).toBe(256000);
    // Reduced /model/info groups do not carry that evidence-free sentinel.
    const [incompleteGroup] = toNativeModels("litellm", server.url.origin, [missing]);
    assert.ok(incompleteGroup);
    expect(enrichCachedModel({ ...incompleteGroup, contextWindow: 128000 }).contextWindow).toBe(
      128000,
    );
    // An older custom fallback is indistinguishable from measured evidence without discovery.
    expect(enrichCachedModel({ ...cached, contextWindow: 96000 }).contextWindow).toBe(96000);
    const [authoritative] = toNativeModels("litellm", server.url.origin, [known]);
    assert.ok(authoritative);
    expect(enrichCachedModel(authoritative).contextWindow).toBe(64000);
    expect(enrichCachedModel(authoritative).maxTokens).toBe(4096);
  } finally {
    if (previous === undefined) delete process.env["LITELLM_DEFAULT_CONTEXT_WINDOW"];
    else process.env["LITELLM_DEFAULT_CONTEXT_WINDOW"] = previous;
    server.stop(true);
  }
});

test.each(["openai", "openai_like", "custom_openai", "azure"])(
  "generic %s routing preserves vendor family compatibility",
  async (adapter) => {
    const families = [
      { family: "kimi", model: "kimi-k3" },
      { family: "deepseek", model: "deepseek-v4.1-flash" },
      { family: "claude", model: "claude-sonnet-4-6" },
      { family: "gemini", model: "gemini-2.5-flash" },
    ];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        if (new URL(request.url).pathname !== "/model/info")
          return new Response(null, { status: 404 });
        return Response.json({
          data: families.map(({ family, model }) => ({
            model_name: `axon-${family}`,
            litellm_params: { model: `openai/${model}`, custom_llm_provider: adapter },
            model_info: { id: family, mode: "chat" },
          })),
        });
      },
    });
    try {
      const result = await discoverModels(server.url.origin, "test-key", {
        modelsDev: false,
        timeoutMs: 1000,
      });
      expect(result.models).toHaveLength(families.length);
      for (const { family } of families) {
        expect(
          result.models.find((model) => model.id === `axon-${family}`)?.litellmBackendFamily,
        ).toBe(family);
      }
      const kimi = result.models.find((model) => model.id === "axon-kimi");
      expect(kimi?.compat).toMatchObject({
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
      });
      expect(kimi?.litellmPolicy?.normalizeStrictToolMessages).toBe(true);
    } finally {
      server.stop(true);
    }
  },
);

test("empty model info falls back to the virtual key's model list", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/model/info") return Response.json({ data: [] });
      if (path === "/v1/models") return Response.json({ data: [{ id: "axon-opaque-key-model" }] });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const result = await discoverModels(server.url.origin, "test-key", {
      modelsDev: false,
      timeoutMs: 1000,
    });
    expect(result.models.map((model) => model.id)).toEqual(["axon-opaque-key-model"]);
    expect(requests).toContain("/v1/models");
    expect(requests.indexOf("/model/info")).toBeLessThan(requests.indexOf("/v1/models"));
  } finally {
    server.stop(true);
  }
});
