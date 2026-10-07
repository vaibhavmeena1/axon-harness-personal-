import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  emitProductEvent,
  measureProductOperation,
  sanitizeProductEvent,
  subscribeProductEvents,
  takeProductEvents,
} from "../../../../telemetry/product-events.ts";
import { recordProductEvent } from "../src/product.ts";
import { createTestRuntime } from "./helpers.ts";

const event = {
  category: "recommender",
  stage: "decision",
  outcome: "selected",
  rank: 1,
  model: "litellm/model-a",
  durationMs: 1250,
} as const;

test("product events allowlist metadata and reject feedback, unknown stages, content and invalid numbers", () => {
  assert.equal(
    sanitizeProductEvent({ category: "feedback", stage: "request", outcome: "success" }),
    undefined,
  );
  assert.equal(sanitizeProductEvent({ ...event, stage: "user-prompt-text" }), undefined);
  assert.deepEqual(
    sanitizeProductEvent({
      ...event,
      prompt: "private prompt",
      reason: "secret",
      "user.email": "spoofed@example.com",
      url: "https://secret",
      confidence: NaN,
      bytes: -1,
    }),
    event,
  );
  assert.equal(
    sanitizeProductEvent({ ...event, model: "Bearer secret", rank: 99 })?.model,
    undefined,
  );
  assert.equal(
    sanitizeProductEvent({ ...event, model: "Bearer secret", rank: 99 })?.rank,
    undefined,
  );
});

test("product metrics use verified runtime identity and keep IDs, numeric scores and repo off labels", async () => {
  const fixture = createTestRuntime();
  const id = "01234567-0123-4123-8123-0123456789ab";
  recordProductEvent(
    fixture.runtime,
    { ...event, recommendationId: id, confidence: 0.9, complexity: 2.5 },
    { "session.id": "session-1", "pi.repo.slug": "private/repo" },
  );
  const count = fixture.metrics.find((metric) => metric.name === "deputydev.recommender.events");
  assert.equal(count?.attributes["user.email"], "developer@example.com");
  assert.equal(count?.attributes["component"], "cli");
  assert.equal(count?.attributes["selected_rank"], 1);
  for (const metric of fixture.metrics) {
    for (const key of [
      "session.id",
      "pi.repo.slug",
      "deputydev.recommendation.id",
      "confidence",
      "complexity",
    ])
      assert.equal(metric.attributes[key], undefined);
  }
  assert.equal(
    fixture.metrics.find((metric) => metric.name === "deputydev.recommender.duration")?.value,
    1.25,
  );
  assert.equal(
    fixture.metrics.find((metric) => metric.name === "deputydev.recommender.complexity")?.value,
    2.5,
  );
  assert.equal(fixture.spans()[0]?.attributes["deputydev.recommendation.id"], id);
  assert.equal(fixture.logs[0]?.attributes["session.id"], "session-1");
  await fixture.runtime.shutdown();
});

test("launcher event buffering is bounded and observer failures cannot change business outcomes", async () => {
  takeProductEvents();
  for (let i = 0; i < 200; i++) emitProductEvent(event);
  assert.equal(takeProductEvents().length, 128);
  emitProductEvent(event);
  const seen: unknown[] = [];
  const stop = subscribeProductEvents((value) => {
    seen.push(value);
    throw new Error("observer failed");
  });
  emitProductEvent(event);
  assert.equal(seen.length, 2);
  assert.equal(
    await measureProductOperation({ category: "restore", stage: "verify" }, async () => 42),
    42,
  );
  await assert.rejects(
    measureProductOperation({ category: "restore", stage: "verify" }, async () => {
      throw new Error("original operation error");
    }),
    /original operation error/,
  );
  stop();
  takeProductEvents();
});
