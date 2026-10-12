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
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "axon-request-relay-"));
  await saveEncryptedSession(resolveAxonPaths({ AXON_HOME: home }), "initial-session");
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
      if (new URL(request.url).origin === process.env.AXON_SERVICE_ORIGIN) {
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
      AXON_SERVICE_ORIGIN: "http://127.0.0.1:1",
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
        codemodeEnabled: !enabled, litellmMcpEnabled: enabled
      } }, { headers: { "x-session-refresh-token": "rotated-session" } });
    };
    for (enabled of [true, false]) {
      const response = await send("/_axon/pi-defaults/refresh");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { applied: true });
      assert.equal(response.headers.get("x-session-refresh-token"), null);
      const settings = await Bun.file(settingsPath).json();
      assert.deepEqual(settings.defaultTools, ["read", enabled ? "-codemode" : "+codemode"]);
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

test("real Pi reload applies fresh backend defaults before rerunning extension factories", async () => {
  await runRelayScript(
    `
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { default: managedConfig } = await import("./src/harnesses/pi/resources/extensions/managed-config.ts");
    const settingsPath = paths.pi + "/settings.json";
    await Bun.write(settingsPath, JSON.stringify({ litellm: { mcp: { enabled: false } } }));
    process.env.PI_AXON_CONFIG_REFRESH_ENABLED = "true";
    process.env.PI_AXON_AUTH_RELAY_URL = relay.origin;
    process.env.PI_AXON_AUTH_RELAY_KEY = relay.capability;
    const factoryValues = [];
    const settingsManager = sdk.SettingsManager.create(paths.home, paths.pi);
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: paths.home, agentDir: paths.pi, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [managedConfig, async () => {
        const settings = await Bun.file(settingsPath).json();
        factoryValues.push(settings.litellm.mcp.enabled);
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
        pi: { codemodeEnabled: true, litellmMcpEnabled: enabled }
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
