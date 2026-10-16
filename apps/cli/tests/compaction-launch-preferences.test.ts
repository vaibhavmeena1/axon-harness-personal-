import { afterEach, expect, test } from "bun:test";
import type { compact, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseClientConfig } from "../src/cli/client-config.ts";
import { createCompactionOverrides } from "../src/harnesses/pi/launch-preferences-environment.ts";
import compactionExtension from "../src/harnesses/pi/resources/extensions/compaction.ts";

type Preparation = Parameters<typeof compact>[0];
type Model = NonNullable<ExtensionContext["model"]>;
const environmentKeys = [
  "ENABLED",
  "MODEL",
  "THRESHOLD_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "TIMEOUT_MS",
].map((key) => `PI_COMPACTION_${key}`);
const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(policy: unknown, failure?: "auth" | "missing" | "empty" | "timeout") {
  for (const key of environmentKeys) delete process.env[key];
  const config = parseClientConfig({ schemaVersion: 1, compaction: policy });
  Object.assign(process.env, createCompactionOverrides(config.compaction));
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const model = {
    provider: "litellm",
    id: "team/summary",
    api: "openai-completions",
    reasoning: false,
    maxTokens: 10000,
    contextWindow: 128000,
  } as Model;
  const requests: { model: Model; maxTokens?: number; signal: AbortSignal }[] = [];
  const finds: string[][] = [];
  const nativeSettings = {
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    retry: { enabled: false },
  };
  let compactions = 0;
  let idle = true;
  const ctx = {
    model,
    hasUI: true,
    thinkingLevel: "off",
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [], getLeafId: () => "leaf" },
    modelRegistry: {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        return failure === "missing" ? undefined : model;
      },
      hasConfiguredAuth: () => failure !== "auth",
      streamSimple(
        requestModel: Model,
        _context: unknown,
        options: { maxTokens?: number; signal: AbortSignal },
      ) {
        requests.push({ model: requestModel, ...options });
        return {
          result: async () => {
            if (failure === "timeout")
              await new Promise((_, reject) => {
                options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                  once: true,
                });
              });
            return {
              role: "assistant",
              content: [{ type: "text", text: failure === "empty" ? "" : "safe summary" }],
              stopReason: "stop",
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: 1,
            };
          },
        };
      },
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 90000 }),
    compact(options: { onComplete: () => void }) {
      compactions++;
      options.onComplete();
    },
  } as unknown as ExtensionContext;
  compactionExtension({
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    registerCommand: () => {},
    getSettings: () => nativeSettings,
    events: { emit: () => {} },
  } as unknown as ExtensionAPI);
  const preparation: Preparation = {
    firstKeptEntryId: "kept",
    messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 90000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: nativeSettings.compaction,
  };
  return {
    requests,
    finds,
    model,
    nativeSettings,
    compactions: () => compactions,
    setIdle: (value: boolean) => {
      idle = value;
    },
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    compact: (reason: "manual" | "threshold" | "overflow", tokensBefore = 90000) =>
      handlers.get("session_before_compact")?.(
        {
          reason,
          preparation: { ...preparation, tokensBefore },
          signal: new AbortController().signal,
        },
        ctx,
      ),
  };
}

test("managed model/output/timeout environment is consumed by the pinned Pi compaction implementation", async () => {
  const fixture = setup({
    enabled: true,
    model: "litellm/team/summary",
    maxOutputTokens: 1234,
    timeoutMs: 30000,
  });
  const result = (await fixture.compact("manual")) as { compaction?: { summary: string } };
  expect(result.compaction?.summary).toContain("safe summary");
  expect(fixture.finds).toEqual([["litellm", "team/summary"]]);
  expect(fixture.requests[0]?.model).toBe(fixture.model);
  expect(fixture.requests[0]?.maxTokens).toBe(1234);
  expect(fixture.requests[0]?.signal.aborted).toBe(false);
  expect(fixture.nativeSettings.compaction.enabled).toBe(true);
});

test("false bypasses overrides without disabling native compaction; true alone invents no overrides", async () => {
  for (const policy of [{ enabled: false, model: "litellm/team/summary" }, { enabled: true }]) {
    const fixture = setup(policy);
    expect(await fixture.compact("manual")).toBeUndefined();
    expect(fixture.requests).toEqual([]);
    expect(fixture.nativeSettings.compaction.enabled).toBe(true);
  }
});

test("custom threshold schedules only while idle and respects native disabled settings", async () => {
  const fixture = setup({ thresholdTokens: 80000 });
  await fixture.emit("session_start");
  await fixture.emit("turn_end", { outcome: "completed" });
  fixture.setIdle(false);
  await fixture.emit("agent_settled");
  expect(fixture.compactions()).toBe(0);
  fixture.setIdle(true);
  fixture.nativeSettings.compaction.enabled = false;
  await fixture.emit("agent_settled");
  expect(fixture.compactions()).toBe(0);
  fixture.nativeSettings.compaction.enabled = true;
  await fixture.emit("agent_settled");
  await fixture.emit("agent_settled");
  expect(fixture.compactions()).toBe(1);
});

test("threshold can defer native threshold summaries, never manual or overflow recovery", async () => {
  const fixture = setup({ thresholdTokens: 80000, maxOutputTokens: 1234 });
  expect(await fixture.compact("threshold", 1000)).toEqual({ cancel: true });
  for (const reason of ["manual", "overflow"] as const) {
    const result = (await fixture.compact(reason, 1000)) as { compaction?: unknown };
    expect(result.compaction).toBeDefined();
  }
});

test.each(["auth", "missing", "empty", "timeout"] as const)(
  "configured summary failure cancels, without falling back: %s",
  async (failure) => {
    const fixture = setup(
      { model: "litellm/team/summary", timeoutMs: failure === "timeout" ? 5 : 30000 },
      failure,
    );
    expect(await fixture.compact("manual")).toEqual({ cancel: true });
    expect(fixture.requests.length).toBe(failure === "auth" || failure === "missing" ? 0 : 1);
  },
);
