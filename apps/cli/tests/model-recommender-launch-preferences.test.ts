import { expect, test } from "bun:test";
import {
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { parseClientConfig } from "../src/cli/client-config.ts";
import { createModelRecommenderOverrides } from "../src/harnesses/pi/launch-preferences-environment.ts";
import { createModelRecommender } from "../src/harnesses/pi/resources/extensions/model-recommender.ts";

test("managed recommender preferences reach the consumer, but the server's real 204 still prevents selection", async () => {
  initTheme("dark");
  let calls = 0;
  let selections = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response(null, { status: 204 });
    },
  });
  const overrides = {
    ...createModelRecommenderOverrides(
      parseClientConfig({
        schemaVersion: 1,
        modelRecommender: { enabled: true, timeoutMs: 15000, autoSelectMs: 10000 },
      }).modelRecommender,
    ),
    PI_MODEL_RECOMMENDER_URL: server.url.origin,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const events: Record<string, unknown>[] = [];
  const model = {
    provider: "litellm",
    id: "current",
    name: "Current",
    input: ["text"],
    contextWindow: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const ctx = {
    mode: "tui",
    model,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [model] },
    sessionManager: { getBranch: () => [] },
    ui: {
      notify() {},
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          bindings: unknown,
          done: (value: unknown) => void,
        ) => { dispose(): void },
      ) =>
        new Promise((resolve) => {
          const loader = factory(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text },
            {},
            (result) => {
              loader.dispose();
              resolve(result);
            },
          );
        }),
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    events: { emit: (_name: string, event: Record<string, unknown>) => events.push(event) },
  } as unknown as ExtensionAPI;
  try {
    process.env["PI_MODEL_RECOMMENDER_DISABLED"] = "true";
    Object.assign(process.env, overrides);
    let observed: unknown;
    // First verify timeout/countdown consumption using the normal extension input path.
    createModelRecommender({
      request: async (_ctx, config) => {
        observed = config;
        return { kind: "disabled" };
      },
    })(pi);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.({ text: "task", source: "interactive" }, ctx);
    expect(observed).toMatchObject({ enabled: true, timeoutMs: 15000, autoSelectMs: 10000 });
    // Then use the built-in network consumer against an actual policy-disabled response.
    createModelRecommender({
      select: async () => {
        selections++;
        return { outcome: "dismissed" };
      },
    })(pi);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("input")?.({ text: "task", source: "interactive" }, ctx);
    expect(calls).toBe(1);
    expect(selections).toBe(0);
    expect(events.some((event) => event["reason"] === "policy_disabled")).toBe(true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.stop(true);
  }
});
