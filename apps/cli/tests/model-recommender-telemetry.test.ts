import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModelRecommender } from "../src/harnesses/pi/resources/extensions/model-recommender.ts";
import { type ProductEvent, sanitizeProductEvent } from "../src/telemetry/product-events.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const original = { provider: "litellm", id: "model-original" } as Model;
const recommended = { provider: "litellm", id: "model-recommended" } as Model;
const another = { provider: "litellm", id: "model-other" } as Model;
type Dependencies = NonNullable<Parameters<typeof createModelRecommender>[0]>;

function setup(overrides: Dependencies = {}, applies = true) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const events: ProductEvent[] = [];
  let switches = 0;
  const ctx = {
    model: original,
    mode: "tui",
    scopedModels: [],
    modelRegistry: { getAvailable: () => [original, recommended, another] },
    sessionManager: { getBranch: () => [] },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
      handlers.set(name, handler),
    events: {
      emit(_channel: string, raw: unknown) {
        const event = sanitizeProductEvent(raw);
        if (event) events.push(event);
      },
    },
    async setModel(model: Model) {
      switches++;
      if (applies) {
        ctx.model = model;
        await handlers.get("model_select")?.(
          { model, previousModel: original, source: "extension" },
          ctx,
        );
      }
      return applies;
    },
  } as unknown as ExtensionAPI;
  createModelRecommender({
    request: async () => ({
      kind: "success",
      ranked: [{ model: recommended, reason: "private recommendation reason" }],
      assessment: { complexity: 2, complexityConfidence: 0.8 },
      policyVersion: "policy-1",
    }),
    select: async () => ({ model: recommended, outcome: "selected" }),
    ...overrides,
  })(pi);
  return {
    events,
    ctx,
    switches: () => switches,
    async input() {
      await handlers.get("input")?.({ text: "secret prompt", source: "interactive" }, ctx);
    },
    async start() {
      await handlers.get("session_start")?.({}, ctx);
    },
    async override() {
      await handlers.get("model_select")?.({ model: another, source: "user" }, ctx);
    },
  };
}

test("recommender explicitly records eligibility, request, assessment, picker, selection, apply and override once", async () => {
  const fixture = setup();
  await fixture.start();
  await fixture.input();
  await fixture.input();
  assert.deepEqual(
    fixture.events.map((event) => event.stage),
    ["eligible", "request", "assessed", "recommended", "shown", "decision", "apply"],
  );
  assert.equal(fixture.switches(), 1);
  assert.equal(fixture.events.find((event) => event.stage === "decision")?.rank, 1);
  assert.equal(fixture.events.find((event) => event.stage === "assessed")?.complexity, 2);
  await fixture.override();
  await fixture.override();
  assert.equal(fixture.events.filter((event) => event.stage === "override").length, 1);
  assert.doesNotMatch(
    JSON.stringify(fixture.events),
    /secret prompt|private recommendation reason/,
  );
});

test("dismiss, keep-current, automatic selection and apply failure have distinct outcomes", async () => {
  for (const outcome of ["dismissed", "kept_current", "auto_selected"] as const) {
    const fixture = setup({
      select: async () => ({
        outcome,
        ...(outcome === "dismissed"
          ? {}
          : { model: outcome === "kept_current" ? original : recommended }),
      }),
    });
    await fixture.start();
    await fixture.input();
    assert.equal(fixture.events.find((event) => event.stage === "decision")?.outcome, outcome);
    assert.equal(fixture.switches(), outcome === "auto_selected" ? 1 : 0);
  }
  const failed = setup({}, false);
  await failed.start();
  await failed.input();
  assert.equal(failed.events.find((event) => event.stage === "apply")?.outcome, "failed");
});

test("request failures, cancellation, disabled policy and missing configuration never create picker/apply events", async () => {
  for (const result of [
    undefined,
    { kind: "cancelled" },
    { kind: "disabled" },
    { kind: "failed", reason: "timeout", message: "private upstream error" },
  ] as const) {
    const fixture = setup({ request: async () => result });
    await fixture.start();
    await fixture.input();
    assert.ok(fixture.events.some((event) => event.stage === "request"));
    assert.ok(!fixture.events.some((event) => event.stage === "shown" || event.stage === "apply"));
    assert.equal(fixture.switches(), 0);
    assert.doesNotMatch(JSON.stringify(fixture.events), /private upstream error/);
  }
});
