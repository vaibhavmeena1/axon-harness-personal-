import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSessionRecovery } from "../src/cli/auth/session-recovery.ts";
import { verifyEncryptedSession } from "../src/cli/auth/verification.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import { takeProductEvents } from "../src/telemetry/product-events.ts";

const origin = "http://127.0.0.1";
function fetchResponse(response: Response): typeof fetch {
  return Object.assign(async () => response, { preconnect: globalThis.fetch.preconnect });
}
function controlRequest(action: string, id?: string): Request {
  const query = id ? `?id=${id}` : "";
  return new Request(`${origin}/_axon/auth/${action}${query}`, {
    method: action === "status" ? "GET" : "POST",
  });
}

for (const action of ["cancel", "login"] as const) {
  test(`auth recovery distinguishes ${action === "cancel" ? "user cancellation" : "login failure"} from success`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchResponse(new Response(null, { status: 503 }));
    const recovery = createSessionRecovery(resolveAxonPaths());
    try {
      takeProductEvents();
      const heartbeat = controlRequest("status");
      await recovery.handle(heartbeat, new URL(heartbeat.url));
      const result = recovery.recover(new AbortController().signal);
      const status = await recovery.handle(heartbeat, new URL(heartbeat.url));
      assert.ok(status);
      const payload = (await status.json()) as { recovery: { id: string } };
      const request = controlRequest(action, payload.recovery.id);
      await recovery.handle(request, new URL(request.url));
      assert.equal(await result, false);
      const observations = takeProductEvents().filter((event) => event.stage === "recovery");
      assert.equal(observations.length, 2);
      assert.equal(observations[0]?.outcome, "pending");
      assert.equal(observations[1]?.outcome, action === "cancel" ? "cancelled" : "failed");
      assert.equal(observations[1]?.reason, action === "cancel" ? "cancelled" : "unavailable");
    } finally {
      recovery.dispose();
      globalThis.fetch = originalFetch;
      takeProductEvents();
    }
  });
}

for (const cancelledIndex of [0, 1]) {
  test(`cancelling recovery waiter ${cancelledIndex + 1} leaves the shared login active`, async () => {
    const recovery = createSessionRecovery(resolveAxonPaths());
    try {
      takeProductEvents();
      const heartbeat = controlRequest("status");
      await recovery.handle(heartbeat, new URL(heartbeat.url));
      const controllers = [new AbortController(), new AbortController()];
      const results = controllers.map((controller) => recovery.recover(controller.signal));
      const before = await recovery.handle(heartbeat, new URL(heartbeat.url));
      assert.ok(before);
      const beforePayload = (await before.json()) as { recovery: { id: string } };

      controllers[cancelledIndex]?.abort();
      assert.equal(await results[cancelledIndex], false);
      const after = await recovery.handle(heartbeat, new URL(heartbeat.url));
      assert.ok(after);
      const afterPayload = (await after.json()) as { recovery: { id: string } };
      assert.equal(afterPayload.recovery.id, beforePayload.recovery.id);
      assert.equal(takeProductEvents().filter((event) => event.stage === "recovery").length, 1);

      const cancel = controlRequest("cancel", afterPayload.recovery.id);
      await recovery.handle(cancel, new URL(cancel.url));
      assert.equal(await results[1 - cancelledIndex], false);
      const [event] = takeProductEvents().filter((event) => event.stage === "recovery");
      assert.equal(event?.outcome, "cancelled");
    } finally {
      recovery.dispose();
      takeProductEvents();
    }
  });
}

test("recovery is cancelled when its last waiting request aborts", async () => {
  const recovery = createSessionRecovery(resolveAxonPaths());
  try {
    const heartbeat = controlRequest("status");
    await recovery.handle(heartbeat, new URL(heartbeat.url));
    const controllers = [new AbortController(), new AbortController()];
    const results = controllers.map((controller) => recovery.recover(controller.signal));
    for (const controller of controllers) controller.abort();
    assert.deepEqual(await Promise.all(results), [false, false]);
    const status = await recovery.handle(heartbeat, new URL(heartbeat.url));
    assert.ok(status);
    assert.deepEqual(await status.json(), { recovery: null });
  } finally {
    recovery.dispose();
    takeProductEvents();
  }
});

test("auth verification preserves expired/invalid identity outcomes and never treats an outage as invalid credentials", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, expected, reason] of [
      ["VERIFIED", "success", undefined],
      ["EXPIRED", "failed", "expired"],
      ["NOT_VERIFIED", "failed", "invalid_session"],
    ] as const) {
      takeProductEvents();
      globalThis.fetch = fetchResponse(
        Response.json({ status, user_email: "private@example.com" }),
      );
      assert.equal(await verifyEncryptedSession("private-session"), status);
      const [event] = takeProductEvents();
      assert.equal(event?.outcome, expected);
      assert.equal(event?.reason, reason);
      assert.doesNotMatch(JSON.stringify(event), /private-session|private@example/);
    }
    globalThis.fetch = fetchResponse(new Response(null, { status: 503 }));
    await assert.rejects(verifyEncryptedSession("private-session"), /Could not verify/);
    assert.equal(takeProductEvents()[0]?.reason, "unavailable");
    globalThis.fetch = fetchResponse(new Response(null, { status: 401 }));
    assert.equal(await verifyEncryptedSession("private-session"), "NOT_VERIFIED");
    assert.equal(takeProductEvents()[0]?.reason, "invalid_session");
  } finally {
    globalThis.fetch = originalFetch;
    takeProductEvents();
  }
});
