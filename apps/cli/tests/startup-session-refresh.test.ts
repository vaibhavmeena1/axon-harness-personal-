import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

// Isolate fetch and TTY/login behavior from other tests, using the real shared-file writer.
async function runStartupScript(script: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "axon-startup-refresh-"));
  await saveEncryptedSession(resolveAxonPaths({ AXON_HOME: home, HOME: home }), "initial-session");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
      import assert from "node:assert/strict";
      import { mkdir, rm } from "node:fs/promises";
      import * as sessions from "./src/cli/auth/session.ts";
      import { verifyEncryptedSession } from "./src/cli/auth/verification.ts";
      import { ensureAuthenticatedSession } from "./src/cli/auth/ensure-session.ts";
      import { runAuthStatus } from "./src/cli/commands/auth.ts";
      import { resolveAxonPaths } from "./src/product/paths.ts";
      import { takeProductEvents } from "./src/telemetry/product-events.ts";
      const paths = resolveAxonPaths();
      const calls = [];
      let upstream = async () => { throw new Error("Unexpected auth request"); };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        assert.equal(url.pathname, "/axon/api/v1/auth/verify-auth-token");
        assert.equal(request.method, "POST");
        calls.push(request.headers.get("authorization"));
        return upstream(request, url);
      }, { preconnect: originalFetch.preconnect });
      ${script}
      `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        AXON_HOME: home,
        HOME: home,
        AXON_SERVICE_ORIGIN: "http://127.0.0.1:1/axon",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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

test("startup refreshes and saves a usable session without interactive login", async () => {
  await runStartupScript(`
    upstream = async (_request, url) => {
      assert.equal(url.searchParams.get("refresh_expired"), "true");
      return Response.json({ status: "VERIFIED" }, {
        headers: { "x-session-refresh-token": "refreshed-session" },
      });
    };
    assert.equal(await ensureAuthenticatedSession(paths, { interactive: false }), true);
    assert.equal(await sessions.loadEncryptedSession(paths), "refreshed-session");
    assert.deepEqual(calls, ["Bearer initial-session"]);
    assert.equal(takeProductEvents().find(event => event.stage === "refresh")?.outcome, "success");
  `);
});

test("valid access tokens are accepted without changing the saved session", async () => {
  await runStartupScript(`
    upstream = async (_request, url) => {
      assert.equal(url.searchParams.get("refresh_expired"), "true");
      return Response.json({ status: "VERIFIED" });
    };
    assert.equal(await ensureAuthenticatedSession(paths, { interactive: false }), true);
    assert.equal(await sessions.loadEncryptedSession(paths), "initial-session");
    assert.equal(calls.length, 1);
  `);
});

for (const status of ["EXPIRED", "NOT_VERIFIED"]) {
  test(`startup requires login when auth returns ${status} without a usable refresh`, async () => {
    await runStartupScript(`
      console.error = () => {};
      upstream = async () => Response.json({ status: ${JSON.stringify(status)} });
      await assert.rejects(ensureAuthenticatedSession(paths, { interactive: false }), /Axon login is required/);
      assert.equal(await sessions.loadEncryptedSession(paths), "initial-session");
      assert.equal(calls.length, 1);
    `);
  });
}

test("temporary auth outages do not turn into another login", async () => {
  await runStartupScript(`
    upstream = async () => new Response(null, { status: 503 });
    await assert.rejects(ensureAuthenticatedSession(paths, { interactive: false }), /Could not verify your Axon session/);
    assert.equal(await sessions.loadEncryptedSession(paths), "initial-session");
    assert.equal(calls.length, 1);
  `);
});

test("startup never accepts a rotation it cannot save safely", async () => {
  await runStartupScript(`
    upstream = async () => {
      await rm(paths.sharedAuthFile);
      await mkdir(paths.sharedAuthFile);
      return Response.json({ status: "VERIFIED" }, {
        headers: { "x-session-refresh-token": "private-refreshed-session" },
      });
    };
    await assert.rejects(ensureAuthenticatedSession(paths, { interactive: false }), error => {
      assert.match(error.message, /refreshed Axon session could not be saved safely/);
      assert.doesNotMatch(error.message, /private-refreshed-session/);
      return true;
    });
    assert.equal(takeProductEvents().find(event => event.stage === "refresh")?.reason, "rotation_failed");
  `);
});

for (const status of ["VERIFIED", "NOT_VERIFIED"]) {
  test(`a concurrent login wins over a late ${status} startup response`, async () => {
    await runStartupScript(`
      upstream = async (request) => {
        if (request.headers.get("authorization") === "Bearer initial-session") {
          await sessions.saveEncryptedSession(paths, "new-login-session");
          return Response.json({ status: ${JSON.stringify(status)} }, {
            headers: ${status === "VERIFIED" ? '{ "x-session-refresh-token": "stale-rotation" }' : "{}"},
          });
        }
        return Response.json({ status: "VERIFIED" });
      };
      assert.equal(await ensureAuthenticatedSession(paths, { interactive: false }), true);
      assert.equal(await sessions.loadEncryptedSession(paths), "new-login-session");
      assert.deepEqual(calls, ["Bearer initial-session", "Bearer new-login-session"]);
    `);
  });
}

for (const [status, rotation] of [
  ["VERIFIED", "invalid session"],
  ["NOT_VERIFIED", "unexpected-rotation"],
]) {
  test(`startup rejects an unsafe ${status} rotation response`, async () => {
    await runStartupScript(`
      upstream = async () => Response.json({ status: ${JSON.stringify(status)} }, {
        headers: { "x-session-refresh-token": ${JSON.stringify(rotation)} },
      });
      await assert.rejects(ensureAuthenticatedSession(paths, { interactive: false }), /Could not verify/);
      assert.equal(await sessions.loadEncryptedSession(paths), "initial-session");
    `);
  });
}

test("read-only identity probes do not opt into token rotation", async () => {
  await runStartupScript(`
    upstream = async (_request, url) => {
      assert.equal(url.searchParams.has("refresh_expired"), false);
      return Response.json({ status: "EXPIRED" });
    };
    assert.equal(await verifyEncryptedSession("initial-session"), "EXPIRED");
    assert.equal(await sessions.loadEncryptedSession(paths), "initial-session");
  `);
});

test("auth status also refreshes a usable expired access token", async () => {
  await runStartupScript(`
    upstream = async (_request, url) => {
      assert.equal(url.searchParams.get("refresh_expired"), "true");
      return Response.json({ status: "VERIFIED" }, {
        headers: { "x-session-refresh-token": "status-refreshed-session" },
      });
    };
    const messages = [];
    console.log = message => messages.push(message);
    await runAuthStatus(paths);
    assert.deepEqual(messages, ["Axon session is valid."]);
    assert.equal(await sessions.loadEncryptedSession(paths), "status-refreshed-session");
  `);
});
