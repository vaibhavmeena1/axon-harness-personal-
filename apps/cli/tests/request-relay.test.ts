import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

// Isolate the service origin, upstream fetch, and optional persistence mocks in a child.
// Local requests still use real HTTP through Bun's authenticated relay.
async function runRelayScript(
  script: string,
  setup = "",
  allowPiConfigRefresh = false,
  serviceBasePath = "",
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "axon-request-relay-"));
  await saveEncryptedSession(resolveAxonPaths({ AXON_HOME: home, HOME: home }), "initial-session");
  const childScript = `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import * as sessions from "./src/cli/auth/session.ts";
    import { resolveAxonPaths } from "./src/product/paths.ts";
    const paths = resolveAxonPaths();
    const actualFetch = globalThis.fetch;
    let upstream = async () => { throw new Error("Unexpected upstream request"); };
    globalThis.fetch = Object.assign(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin === new URL(process.env.AXON_SERVICE_ORIGIN).origin) {
        return upstream(request);
      }
      return actualFetch(input, init);
    }, { preconnect: actualFetch.preconnect });
    async function bounded(work) {
      let timer;
      try {
        return await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Relay operation did not finish concurrently")), 2000);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }
    ${setup}
    const { startAuthenticatedRequestRelay } = await import("./src/cli/auth/request-relay.ts");
    const relay = startAuthenticatedRequestRelay(paths, {
      allowPiConfigRefresh: ${allowPiConfigRefresh},
    });
    function send(path, signal) {
      return actualFetch(relay.origin + path, {
        method: "POST",
        headers: { authorization: "Bearer " + relay.capability, "content-type": "application/json" },
        body: "{}",
        signal,
      });
    }
    try {
      ${script}
    } finally { relay.dispose(); }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", childScript], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      AXON_HOME: home,
      HOME: home,
      AXON_SERVICE_ORIGIN: `http://127.0.0.1:1${serviceBasePath}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  } finally {
    child.kill();
    await child.exited;
    await rm(home, { recursive: true, force: true });
  }
}

test("deployment base paths reach auth, config, backups and upstream relay requests without changing local URLs", async () => {
  await runRelayScript(
    `
    const base = process.env.AXON_SERVICE_ORIGIN;
    const calls = [];
    upstream = async (request) => {
      const url = new URL(request.url);
      assert.ok(url.pathname.startsWith("/axon/"), url.pathname);
      assert.equal(request.headers.get("authorization"), "Bearer initial-session");
      calls.push(url.pathname + url.search);
      if (url.pathname === "/axon/api/v1/auth/verify-auth-token")
        return Response.json({ status: "VERIFIED" });
      if (url.pathname === "/axon/api/v1/cli/config")
        return Response.json({ schemaVersion: 1 });
      if (url.pathname === "/axon/api/v1/sessions/status")
        return Response.json({ enabled: true, owner_user_id: "1" });
      return Response.json({ path: url.pathname + url.search });
    };
    const { BUILD_INFO } = await import("./src/build-info.ts");
    assert.equal(BUILD_INFO.serviceOrigin, base);
    const { verifyEncryptedSession } = await import("./src/cli/auth/verification.ts");
    assert.equal(await verifyEncryptedSession("initial-session"), "VERIFIED");
    const { BackupApi } = await import("./src/sessions/api.ts");
    const api = new BackupApi(paths, base);
    assert.equal(await api.owner(), "1");
    await api.request(api.endpoint("download", "fixture-session"), "POST");
    const { createPiEnvironment } = await import("./src/harnesses/pi/environment.ts");
    const environment = createPiEnvironment({}, paths);
    assert.equal(environment.PI_AXON_BACKUP_SERVICE_ORIGIN, base);
    assert.equal(environment.PI_MODEL_RECOMMENDER_URL, base + "/api/v1/model-recommendations");
    const { createTelemetryOverrides } = await import("./src/harnesses/pi/telemetry-environment.ts");
    const telemetry = createTelemetryOverrides({}, {
      enabled: true, endpoint: "/api/v1/otel", protocol: "http/protobuf",
      traceSampleRatio: 1, metricExportIntervalMs: 10000,
    }, false, { home: paths.home });
    assert.equal(telemetry.PI_ORG_OTEL_MANAGED_ENDPOINT, base + "/api/v1/otel");
    for (const path of ["/litellm/v1/chat/completions?tag=a&tag=b", "/api/v1/model-recommendations"]) {
      const response = await send(path);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { path: "/axon" + path });
    }
    assert.equal((await send("/_axon/pi-defaults/refresh")).status, 200);
    assert.equal((await send("/axon/litellm/v1/models")).status, 404);
    assert.deepEqual(calls, [
      "/axon/api/v1/auth/verify-auth-token",
      "/axon/api/v1/sessions/status",
      "/axon/api/v1/sessions/fixture-session/backup-download",
      "/axon/litellm/v1/chat/completions?tag=a&tag=b",
      "/axon/api/v1/model-recommendations",
      "/axon/api/v1/cli/config",
    ]);
  `,
    "",
    true,
    "/axon",
  );
});

test("pinned LiteLLM image discovery and generation use the authenticated relay and preserve cost", async () => {
  await runRelayScript(
    `
    const { discoverModels } = await import("pi-provider-litellm/src/discover.ts");
    const { createLiteLLMProvider, toNativeImageModels } = await import("pi-provider-litellm/src/provider.ts");
    const root = relay.origin + "/litellm";
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=";
    const calls = [];
    upstream = async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      assert.equal(request.headers.get("authorization"), "Bearer initial-session");
      assert.equal(request.headers.get("x-harness-id"), "pi");
      if (path === "/axon/litellm/model/info") return Response.json({
        data: [{
          model_name: "axon-image",
          litellm_params: { model: "openai/gpt-image-1" },
          model_info: { id: "image", mode: "image_generation" },
        }],
      });
      if (path !== "/axon/litellm/v1/images/generations")
        return new Response(null, { status: 404 });
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), { model: "axon-image", prompt: "A red fox", n: 1 });
      return Response.json({ data: [{ b64_json: imageData }] }, {
        headers: { "x-litellm-response-cost": "0.04", "x-session-refresh-token": "image-rotation" },
      });
    };
    const discovered = await discoverModels(root, relay.capability, {
      modelsDev: false, timeoutMs: 1000,
    });
    assert.deepEqual(discovered.models, []);
    const images = toNativeImageModels("litellm", root, discovered.imageModels);
    assert.equal(images.length, 1);
    const model = images[0];
    assert.equal(model.baseUrl, root + "/v1");
    const provider = createLiteLLMProvider({
      id: "litellm", name: "Axon AI Gateway", baseUrl: root, models: images,
      auth: { apiKey: { name: "API key", resolve: async () => ({ auth: { apiKey: relay.capability } }) } },
      resolveCredentialRoot: () => root,
      discover: async () => discovered,
    });
    const context = { input: [{ type: "text", text: "A red fox" }] };
    const result = await provider.generateImages(model, context, { apiKey: relay.capability });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.output, [{ type: "image", data: imageData, mimeType: "image/png" }]);
    assert.equal(result.usage.cost.total, 0.04);
    assert.equal(await sessions.loadEncryptedSession(paths), "image-rotation");
    const beforeStaleRequest = calls.length;
    const rejected = await provider.generateImages({
      ...model, baseUrl: "http://127.0.0.1:1/litellm/v1",
    }, context, { apiKey: relay.capability });
    assert.equal(rejected.stopReason, "error");
    assert.match(rejected.errorMessage, /stale LiteLLM model root/);
    assert.equal(calls.length, beforeStaleRequest);
    assert.ok(calls.includes("/axon/litellm/model/info"));
    assert.ok(calls.includes("/axon/litellm/v1/images/generations"));
    `,
    "",
    false,
    "/axon",
  );
});

test("relay forwards request bodies up to 50 MiB and rejects larger bodies before upstream", async () => {
  await runRelayScript(`
    const limit = 50 * 1024 * 1024;
    // A valid JSON object padded with whitespace to exercise the exact byte boundary.
    const payload = new Uint8Array(limit + 1).fill(32);
    payload[0] = 123;
    payload[1] = 125;
    let calls = 0;
    upstream = async (request) => {
      calls += 1;
      assert.equal(new URL(request.url).pathname, "/litellm/v1/chat/completions");
      assert.equal(request.headers.get("authorization"), "Bearer initial-session");
      const body = new Uint8Array(await request.arrayBuffer());
      assert.equal(body.byteLength, limit);
      assert.deepEqual(body, payload.subarray(0, limit));
      return Response.json({ forwarded: true });
    };
    const sendPayload = (body) => actualFetch(relay.origin + "/litellm/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + relay.capability, "content-type": "application/json" },
      body,
    });
    const accepted = await sendPayload(payload.subarray(0, limit));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { forwarded: true });
    const rejected = await sendPayload(payload);
    assert.equal(rejected.status, 413);
    await rejected.arrayBuffer();
    assert.equal(calls, 1);
  `);
});

test("browser login starts and polls under the deployment base path", async () => {
  await runRelayScript(
    `
    const sessionId = "12345678-1234-4123-8123-123456789abc";
    const browserUrl = "https://deputydev.ai/axon/external-auth?unique_session_id=" + sessionId + "&is_external_auth_request=CLI";
    const calls = [];
    upstream = async (request) => {
      const path = new URL(request.url).pathname;
      calls.push([request.method, path]);
      if (path === "/axon/api/v1/auth/browser-login")
        return Response.json({ session_id: sessionId, browser_url: browserUrl });
      assert.equal(path, "/axon/api/v1/auth/browser-login/" + sessionId);
      return Response.json({ status: "AUTHENTICATED", encrypted_session_data: "login-session" });
    };
    const { runAuthLogin } = await import("./src/cli/commands/auth.ts");
    assert.equal(await runAuthLogin(paths, { browser: true, quiet: true }), true);
    assert.deepEqual(opened, [browserUrl]);
    assert.equal(await sessions.loadEncryptedSession(paths), "login-session");
    assert.deepEqual(calls, [
      ["POST", "/axon/api/v1/auth/browser-login"],
      ["GET", "/axon/api/v1/auth/browser-login/" + sessionId],
    ]);
    `,
    `
    const childProcess = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const opened = [];
    mock.module("node:child_process", () => ({
      ...childProcess,
      spawn: (_command, args) => {
        opened.push(args.at(-1));
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    }));
    `,
    false,
    "/axon",
  );
});

test("slow non-streaming search does not block parallel main-agent and subagent requests", async () => {
  await runRelayScript(`
    const searchStarted = Promise.withResolvers();
    const releaseSearch = Promise.withResolvers();
    const calls = [];
    upstream = async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      assert.equal(request.headers.get("authorization"), "Bearer initial-session");
      if (path === "/litellm/search") {
        searchStarted.resolve();
        await releaseSearch.promise;
      }
      return Response.json({ path });
    };
    const search = send("/litellm/search");
    try {
      await bounded(searchStarted.promise);
      const models = await bounded(Promise.all([
        send("/litellm/main-model"),
        send("/litellm/subagent-model"),
      ]));
      assert.deepEqual(await Promise.all(models.map(response => response.json())), [
        { path: "/litellm/main-model" },
        { path: "/litellm/subagent-model" },
      ]);
      assert.equal(calls.length, 3);
    } finally { releaseSearch.resolve(); await search; }
  `);
});

test("relay uses the live DeputyDev extension token and persists refresh to the same shared file", async () => {
  await runRelayScript(`
    const { join } = await import("node:path");
    assert.equal(paths.sharedAuthFile, join(process.env.HOME, ".deputydev", "264325ba-cbd0-47d5-9269-ac4bd19067c2.json"));
    await Bun.write(paths.sharedAuthFile, JSON.stringify({
      extension_auth_token: "deputydev-rotation",
      cli_auth_token: "unrelated-cli-token",
    }));
    upstream = async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer deputydev-rotation");
      return Response.json({ ok: true }, { headers: { "x-session-refresh-token": "axon-rotation" } });
    };
    assert.equal((await send("/litellm/v1/chat/completions")).status, 200);
    assert.deepEqual(await Bun.file(paths.sharedAuthFile).json(), {
      extension_auth_token: "axon-rotation",
      cli_auth_token: "unrelated-cli-token",
    });
    // An external refresh during a request wins over the old response.
    upstream = async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer axon-rotation");
      await Bun.write(paths.sharedAuthFile, JSON.stringify({ extension_auth_token: "new-deputydev-rotation" }));
      return Response.json({ ok: true }, { headers: { "x-session-refresh-token": "stale-axon-rotation" } });
    };
    await send("/litellm/v1/chat/completions");
    assert.equal(await sessions.loadEncryptedSession(paths), "new-deputydev-rotation");
    upstream = async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer new-deputydev-rotation");
      return Response.json({ ok: true });
    };
    assert.equal((await send("/litellm/v1/chat/completions")).status, 200);
  `);
});

test("a late concurrent rotation cannot overwrite a newer session", async () => {
  await runRelayScript(`
    const lateStarted = Promise.withResolvers();
    const releaseLate = Promise.withResolvers();
    const seen = [];
    upstream = async (request) => {
      const path = new URL(request.url).pathname;
      seen.push([path, request.headers.get("authorization")]);
      if (path === "/litellm/late") {
        lateStarted.resolve();
        await releaseLate.promise;
        return Response.json({}, { headers: { "x-session-refresh-token": "stale-session" } });
      }
      if (path === "/litellm/rotate") {
        return Response.json({}, { headers: { "x-session-refresh-token": "new-session" } });
      }
      return Response.json({});
    };
    const late = send("/litellm/late");
    try {
      await bounded(lateStarted.promise);
      const rotated = await bounded(send("/litellm/rotate"));
      assert.equal(rotated.headers.get("x-session-refresh-token"), null);
      assert.equal(await sessions.loadEncryptedSession(paths), "new-session");
    } finally { releaseLate.resolve(); await late; }
    assert.equal(await sessions.loadEncryptedSession(paths), "new-session");
    await send("/litellm/next");
    assert.deepEqual(seen, [
      ["/litellm/late", "Bearer initial-session"],
      ["/litellm/rotate", "Bearer initial-session"],
      ["/litellm/next", "Bearer new-session"],
    ]);
  `);
});

test("an in-flight request rejected with 401 retries once using a concurrent rotation", async () => {
  await runRelayScript(`
    const rejectedStarted = Promise.withResolvers();
    const releaseRejected = Promise.withResolvers();
    const seen = [];
    upstream = async (request) => {
      const path = new URL(request.url).pathname;
      const token = request.headers.get("authorization");
      seen.push([path, token]);
      if (path === "/litellm/rejected" && token === "Bearer initial-session") {
        rejectedStarted.resolve();
        await releaseRejected.promise;
        return new Response(null, { status: 401 });
      }
      if (path === "/litellm/rotate") {
        return Response.json({}, { headers: { "x-session-refresh-token": "new-session" } });
      }
      assert.equal(path, "/litellm/rejected");
      assert.equal(token, "Bearer new-session");
      return Response.json({ ok: true });
    };
    const rejected = send("/litellm/rejected");
    try {
      await bounded(rejectedStarted.promise);
      assert.equal((await bounded(send("/litellm/rotate"))).status, 200);
    } finally { releaseRejected.resolve(); }
    const response = await bounded(rejected);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(seen, [
      ["/litellm/rejected", "Bearer initial-session"],
      ["/litellm/rotate", "Bearer initial-session"],
      ["/litellm/rejected", "Bearer new-session"],
    ]);
  `);
});

test("requests wait only during persistence and a cancelled waiter does not cancel the refresh", async () => {
  await runRelayScript(
    `
      const seen = [];
      upstream = async (request) => {
        const path = new URL(request.url).pathname;
        seen.push([path, request.headers.get("authorization")]);
        return Response.json({}, path === "/litellm/rotate"
          ? { headers: { "x-session-refresh-token": "new-session" } }
          : {});
      };
      const rotating = send("/litellm/rotate");
      const controller = new AbortController();
      let next;
      try {
        await bounded(refreshStarted.promise);
        next = send("/litellm/next");
        const cancelled = send("/litellm/cancelled", controller.signal).catch(error => error);
        // A control round trip lets Bun process both requests while persistence is blocked.
        const status = await actualFetch(relay.origin + "/_axon/auth/status", {
          headers: { authorization: "Bearer " + relay.capability },
        });
        assert.equal(status.status, 200);
        controller.abort();
        assert.ok((await bounded(cancelled)) instanceof Error);
        assert.deepEqual(seen, [["/litellm/rotate", "Bearer initial-session"]]);
      } finally { releaseRefresh.resolve(); }
      assert.equal((await bounded(rotating)).status, 200);
      assert.equal((await bounded(next)).status, 200);
      assert.equal(await sessions.loadEncryptedSession(paths), "new-session");
      assert.deepEqual(seen, [
        ["/litellm/rotate", "Bearer initial-session"],
        ["/litellm/next", "Bearer new-session"],
      ]);
    `,
    `
      const refreshStarted = Promise.withResolvers();
      const releaseRefresh = Promise.withResolvers();
      const originalRefresh = sessions.refreshEncryptedSession;
      mock.module("./src/cli/auth/session.ts", () => ({
        ...sessions,
        refreshEncryptedSession: async (...args) => {
          refreshStarted.resolve();
          await releaseRefresh.promise;
          return originalRefresh(...args);
        },
      }));
    `,
  );
});

test("failed persistence fails its request without poisoning subsequent requests", async () => {
  await runRelayScript(
    `
      upstream = async (request) => {
        assert.equal(request.headers.get("authorization"), "Bearer initial-session");
        return Response.json({}, { headers: { "x-session-refresh-token": "new-session" } });
      };
      assert.equal((await send("/litellm/first")).status, 503);
      assert.equal(await sessions.loadEncryptedSession(paths), "initial-session");
      assert.equal((await bounded(send("/litellm/second"))).status, 200);
      assert.equal(await sessions.loadEncryptedSession(paths), "new-session");
    `,
    `
      let attempts = 0;
      const originalRefresh = sessions.refreshEncryptedSession;
      mock.module("./src/cli/auth/session.ts", () => ({
        ...sessions,
        refreshEncryptedSession: async (...args) => {
          if (attempts++ === 0) throw new Error("Save failed");
          return originalRefresh(...args);
        },
      }));
    `,
  );
});

test("a saved rotation rejected in favour of a concurrent sibling adopts the sibling", async () => {
  await runRelayScript(
    `
      const slowStarted = Promise.withResolvers();
      const releaseSlow = Promise.withResolvers();
      const seen = [];
      upstream = async (request) => {
        const path = new URL(request.url).pathname;
        const token = request.headers.get("authorization");
        seen.push([path, token]);
        if (path === "/api/v1/auth/verify-auth-token") {
          // The auth service kept only the later rotation of initial-session.
          return token === "Bearer lost-rotation"
            ? Response.json({ status: "VERIFIED" })
            : new Response(null, { status: 401 });
        }
        if (path === "/litellm/slow") {
          slowStarted.resolve();
          await releaseSlow.promise;
          return Response.json({}, { headers: { "x-session-refresh-token": "lost-rotation" } });
        }
        if (path === "/litellm/fast") {
          return Response.json({}, { headers: { "x-session-refresh-token": "saved-rotation" } });
        }
        if (token === "Bearer saved-rotation") return new Response(null, { status: 401 });
        return Response.json({ ok: true });
      };
      const slow = send("/litellm/slow");
      try {
        await bounded(slowStarted.promise);
        assert.equal((await bounded(send("/litellm/fast"))).status, 200);
      } finally { releaseSlow.resolve(); }
      assert.equal((await bounded(slow)).status, 200);
      assert.equal(await sessions.loadEncryptedSession(paths), "saved-rotation");

      const next = await bounded(send("/litellm/next"));
      assert.equal(next.status, 200);
      assert.deepEqual(await next.json(), { ok: true });
      assert.equal(await sessions.loadEncryptedSession(paths), "lost-rotation");
      assert.deepEqual(seen.slice(2), [
        ["/litellm/next", "Bearer saved-rotation"],
        ["/api/v1/auth/verify-auth-token", "Bearer saved-rotation"],
        ["/api/v1/auth/verify-auth-token", "Bearer lost-rotation"],
        ["/litellm/next", "Bearer lost-rotation"],
      ]);
      // Losing the save race is reported as a conflict, not an account switch.
      assert.deepEqual(
        events.filter(event => event.stage === "refresh").map(event => [event.outcome, event.reason]),
        [["success", undefined], ["skipped", "conflict"]],
      );
    `,
    `
      const events = [];
      const productEvents = await import("./src/telemetry/product-events.ts");
      mock.module("./src/telemetry/product-events.ts", () => ({
        ...productEvents,
        emitProductEvent: (event) => { events.push(event); },
      }));
    `,
  );
});

test("concurrent rejections of one credential share a single verification", async () => {
  await runRelayScript(`
    const arrived = [];
    const bothArrived = Promise.withResolvers();
    let verifications = 0;
    upstream = async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/auth/verify-auth-token") {
        verifications += 1;
        await new Promise(resolve => setTimeout(resolve, 100));
        return Response.json({ status: "VERIFIED" });
      }
      arrived.push(path);
      if (arrived.length === 2) bothArrived.resolve();
      await bothArrived.promise;
      return new Response(null, { status: 401 });
    };
    const responses = await bounded(Promise.all([send("/litellm/main"), send("/litellm/subagent")]));
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.match(await response.text(), /session is still valid/);
    }
    assert.equal(verifications, 1);
  `);
});

test("refreshes Pi defaults through the pinned config API and safely rotates the session", async () => {
  await runRelayScript(
    `
    const settingsPath = paths.pi + "/settings.json";
    const initial = { theme: "custom", defaultTools: ["read"], litellm: {
      skills: { enabled: false }, mcp: { enabled: false, exposure: "deferred" }
    } };
    await Bun.write(settingsPath, JSON.stringify(initial));
    let enabled = true;
    let calls = 0;
    upstream = async (request) => {
      assert.equal(new URL(request.url).pathname, "/api/v1/cli/config");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), calls++ === 0
        ? "Bearer initial-session" : "Bearer rotated-session");
      return Response.json({ schemaVersion: 1, pi: {
        codemodeEnabled: !enabled, litellmMcpEnabled: enabled, showCacheMissNotices: enabled
      } }, { headers: { "x-session-refresh-token": "rotated-session" } });
    };
    for (enabled of [true, false]) {
      const response = await send("/_axon/pi-defaults/refresh");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { applied: true });
      assert.equal(response.headers.get("x-session-refresh-token"), null);
      const settings = await Bun.file(settingsPath).json();
      assert.deepEqual(settings.defaultTools, ["read", enabled ? "-codemode" : "+codemode"]);
      assert.equal(settings.showCacheMissNotices, enabled);
      assert.deepEqual(settings.litellm, {
        ...initial.litellm, mcp: { ...initial.litellm.mcp, enabled }
      });
      assert.equal(settings.theme, "custom");
      assert.equal(await sessions.loadEncryptedSession(paths), "rotated-session");
    }
  `,
    "",
    true,
  );
});

test("config outages, invalid policies, and omitted defaults preserve local settings", async () => {
  await runRelayScript(
    `
    const settingsPath = paths.pi + "/settings.json";
    const content = JSON.stringify({ defaultTools: ["read"], litellm: { mcp: { enabled: false } } });
    await Bun.write(settingsPath, content);
    const diagnostics = [];
    const originalError = console.error;
    console.error = message => diagnostics.push(message);
    for (const [response, status] of [
      [new Response("private-secret", { status: 503 }), 503],
      [Response.json({ schemaVersion: 1, pi: { codemodeEnabled: true, litellmMcpEnabled: "true" } }), 503],
      [new Response("<html>private-secret</html>"), 503],
      [Response.json({ schemaVersion: 1 }), 200],
    ]) {
      upstream = async () => response;
      const result = await send("/_axon/pi-defaults/refresh");
      assert.equal(result.status, status);
      assert.equal(await Bun.file(settingsPath).text(), content);
      assert.ok(!(await result.text()).includes("private-secret"));
    }
    console.error = originalError;
    // Pi owns the terminal during reload: invalid sections must not be printed over its TUI.
    assert.deepEqual(diagnostics, []);
  `,
    "",
    true,
  );
});

test("refresh is capability-protected, POST-only, local-only, and disabled on offline relays", async () => {
  await runRelayScript(`
    assert.equal((await send("/_axon/pi-defaults/refresh")).status, 404);
  `);
  await runRelayScript(
    `
    assert.equal((await actualFetch(relay.origin + "/_axon/pi-defaults/refresh", { method: "POST" })).status, 401);
    assert.equal((await actualFetch(relay.origin + "/_axon/pi-defaults/refresh", {
      headers: { authorization: "Bearer " + relay.capability }
    })).status, 404);
    assert.equal((await send("/_axon/pi-defaults/refresh?url=http://evil.test")).status, 404);
    assert.equal((await send("/api/v1/cli/config")).status, 404);
  `,
    "",
    true,
  );
});

test("a config response from an account changed during refresh is not applied", async () => {
  await runRelayScript(
    `
    const settingsPath = paths.pi + "/settings.json";
    const content = JSON.stringify({ defaultTools: ["read"], litellm: { mcp: { enabled: false } } });
    await Bun.write(settingsPath, content);
    upstream = async () => {
      await sessions.saveEncryptedSession(paths, "different-account");
      return Response.json({ schemaVersion: 1, pi: { codemodeEnabled: true, litellmMcpEnabled: true } },
        { headers: { "x-session-refresh-token": "old-account-rotation" } });
    };
    assert.equal((await send("/_axon/pi-defaults/refresh")).status, 409);
    assert.equal(await sessions.loadEncryptedSession(paths), "different-account");
    assert.equal(await Bun.file(settingsPath).text(), content);
  `,
    "",
    true,
  );
});

test("a config refresh rechecks the account after waiting for the settings lock", async () => {
  await runRelayScript(
    `
    const { withFileLock } = await import("./src/launcher/file-lock.ts");
    const settingsPath = paths.pi + "/settings.json";
    const content = JSON.stringify({ defaultTools: ["read"], litellm: { mcp: { enabled: false } } });
    await Bun.write(settingsPath, content);
    const fetched = Promise.withResolvers();
    upstream = async () => {
      fetched.resolve();
      return Response.json({ schemaVersion: 1, pi: { codemodeEnabled: true, litellmMcpEnabled: true } });
    };
    let response;
    await withFileLock(paths.piPackageLock, async () => {
      response = send("/_axon/pi-defaults/refresh");
      await fetched.promise;
      await new Promise(resolve => setTimeout(resolve, 50));
      await sessions.saveEncryptedSession(paths, "different-account");
    });
    assert.equal((await response).status, 503);
    assert.equal(await Bun.file(settingsPath).text(), content);
  `,
    "",
    true,
  );
});

test("refresh deadlines and unsafe settings never overwrite the current settings", async () => {
  await runRelayScript(
    `
    const settingsPath = paths.pi + "/settings.json";
    const content = JSON.stringify({ litellm: { mcp: { enabled: false } } });
    await Bun.write(settingsPath, content);
    upstream = async (request) => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("private-secret")), { once: true });
    });
    const started = Date.now();
    assert.equal((await bounded(send("/_axon/pi-defaults/refresh"))).status, 503);
    assert.ok(Date.now() - started < 1500);
    assert.equal(await Bun.file(settingsPath).text(), content);
    upstream = async () => Response.json({ schemaVersion: 1,
      pi: { codemodeEnabled: true, litellmMcpEnabled: true }
    });
    await Bun.write(settingsPath, "{malformed");
    assert.equal((await send("/_axon/pi-defaults/refresh")).status, 503);
    assert.equal(await Bun.file(settingsPath).text(), "{malformed");
    `,
    "",
    true,
  );
});

test("invalid config still persists a safe auth rotation without applying defaults", async () => {
  await runRelayScript(
    `
    const settingsPath = paths.pi + "/settings.json";
    const content = JSON.stringify({ litellm: { mcp: { enabled: false } } });
    await Bun.write(settingsPath, content);
    upstream = async () => Response.json({ schemaVersion: 999 }, {
      headers: { "x-session-refresh-token": "rotated-session" }
    });
    assert.equal((await send("/_axon/pi-defaults/refresh")).status, 503);
    assert.equal(await sessions.loadEncryptedSession(paths), "rotated-session");
    assert.equal(await Bun.file(settingsPath).text(), content);
    `,
    "",
    true,
  );
});

test("real Pi reload refreshes disk defaults but retains all launch-time environment preferences", async () => {
  await runRelayScript(
    `
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { default: managedConfig } = await import("./src/harnesses/pi/resources/extensions/managed-config.ts");
    const settingsPath = paths.pi + "/settings.json";
    await Bun.write(settingsPath, JSON.stringify({ litellm: { mcp: { enabled: false } } }));
    process.env.PI_AXON_CONFIG_REFRESH_ENABLED = "true";
    process.env.PI_AXON_AUTH_RELAY_URL = relay.origin;
    process.env.PI_AXON_AUTH_RELAY_KEY = relay.capability;
    const launchValues = {
      PI_COMPACTION_ENABLED: "true", PI_COMPACTION_MODEL: "litellm/launch-summary", PI_COMPACTION_THRESHOLD_TOKENS: "80000", PI_COMPACTION_MAX_OUTPUT_TOKENS: "8192", PI_COMPACTION_TIMEOUT_MS: "120000",
      PI_MODEL_RECOMMENDER_DISABLED: "false", PI_MODEL_RECOMMENDER_TIMEOUT_MS: "15000", PI_MODEL_RECOMMENDER_AUTO_SELECT_MS: "10000",
      LITELLM_DISCOVERY_TIMEOUT_MS: "5000", LITELLM_DEFAULT_CONTEXT_WINDOW: "128000",
      PI_WEB_SEARCH_ENABLED: "true", PI_WEB_SEARCH_TIMEOUT_MS: "60000", PI_ORG_OTEL_ENABLED: "true", OTEL_TRACES_SAMPLER_ARG: "0.5",
    };
    Object.assign(process.env, launchValues);
    const factoryValues = [];
    const settingsManager = sdk.SettingsManager.create(paths.home, paths.pi);
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: paths.home, agentDir: paths.pi, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [managedConfig, async () => {
        const settings = await Bun.file(settingsPath).json();
        factoryValues.push(settings.litellm.mcp.enabled);
        for (const [name, value] of Object.entries(launchValues)) assert.equal(process.env[name], value);
      }],
    });
    await resourceLoader.reload();
    const { session: piSession } = await sdk.createAgentSession({
      cwd: paths.home, agentDir: paths.pi, settingsManager, resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(paths.home),
    });
    try {
      await piSession.bindExtensions({});
      assert.equal(factoryValues.at(-1), false);
      let enabled = true;
      upstream = async () => Response.json({ schemaVersion: 1,
        pi: { codemodeEnabled: true, litellmMcpEnabled: enabled },
        compaction: { enabled: false, model: "litellm/new-summary", thresholdTokens: 1000, maxOutputTokens: 2000, timeoutMs: 3000 },
        modelRecommender: { enabled: false, timeoutMs: 2000, autoSelectMs: 3000 },
        litellmClient: { discoveryTimeoutMs: 0, defaultContextWindow: 256000 },
        telemetry: { enabled: false, traceSampleRatio: 0 },
        webSearch: { enabled: false, model: "changed", allowedModels: ["changed"], timeoutMs: 1000, maxQueryCharacters: 1, maxResultCharacters: 1, maxOutputTokens: 1, maxSources: 1, temperature: 0, useUrlContext: false, requireGrounding: true },
      });
      await piSession.reload();
      assert.equal(factoryValues.at(-1), true);
      // A manual local edit cannot bypass the next successful managed reload.
      const settings = await Bun.file(settingsPath).json();
      settings.litellm.mcp.enabled = false;
      await Bun.write(settingsPath, JSON.stringify(settings));
      await piSession.reload();
      assert.equal(factoryValues.at(-1), true);
      enabled = false;
      await piSession.reload();
      assert.equal(factoryValues.at(-1), false);
    } finally { piSession.dispose(); }
  `,
    "",
    true,
  );
});
