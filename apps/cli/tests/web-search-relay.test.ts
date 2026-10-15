import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

// A child process isolates BUILD_INFO's service origin and the extension's environment.
test("search uses the authenticated relay, persists rotation, and retains citations/session/cost", async () => {
  const home = await mkdtemp(join(tmpdir(), "axon-search-relay-"));
  const paths = resolveAxonPaths({ AXON_HOME: home, HOME: home });
  await mkdir(paths.home, { recursive: true });
  await saveEncryptedSession(paths, "initial-session");
  const seen: {
    path: string;
    authorization: string | null;
    session: string | null;
    payload: Record<string, unknown>;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        session: request.headers.get("x-litellm-session-id"),
        payload: (await request.json()) as Record<string, unknown>,
      });
      return Response.json(
        {
          model: "gemini-3.8-flash",
          choices: [{ message: { content: "Verified answer" } }],
          vertex_ai_grounding_metadata: [
            {
              groundingChunks: [{ web: { uri: "https://docs.test", title: "Docs" } }],
              webSearchQueries: ["docs"],
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        {
          headers: {
            "x-session-refresh-token": "rotated-session",
            "x-litellm-response-cost": "0.001",
          },
        },
      );
    },
  });
  const script = `
    import { startAuthenticatedRequestRelay } from "./src/cli/auth/request-relay.ts";
    import { loadEncryptedSession } from "./src/cli/auth/session.ts";
    import { resolveAxonPaths } from "./src/product/paths.ts";
    import { createWebSearchOverrides } from "./src/harnesses/pi/web-search-environment.ts";
    import webSearch from "./src/harnesses/pi/resources/extensions/web-search.ts";
    const paths = resolveAxonPaths();
    const relay = startAuthenticatedRequestRelay(paths);
    try {
      for (const [name,value] of Object.entries(createWebSearchOverrides({}, relay))) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      let tool;
      webSearch({ registerTool(t) { tool=t; } });
      const ctx = { sessionManager: { getSessionId: () => "canonical-pi-session" } };
      const result = await tool.execute("search-1", {query:"Official docs"}, undefined, undefined, ctx);
      await tool.execute("search-2", {query:"More official docs"}, undefined, undefined, ctx);
      const removed = await fetch(relay.origin+"/api/v1/web-search", {
        method:"POST", headers:{authorization:"Bearer "+relay.capability}, body:"{}"
      });
      console.log(JSON.stringify({result, savedSession:await loadEncryptedSession(paths), removedStatus:removed.status}));
    } finally { relay.dispose(); }
  `;
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        // Do not inherit web-search settings changed by another test or the caller's shell.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith("PI_WEB_SEARCH_")),
        ),
        AXON_HOME: home,
        HOME: home,
        AXON_SERVICE_ORIGIN: server.url.origin,
        PI_WEB_SEARCH_ENABLED: "true",
        PI_WEB_SEARCH_MODEL: "gemini-3.8-flash",
        PI_WEB_SEARCH_REQUIRE_GROUNDING: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(status).toBe(0);
    expect(stderr).not.toContain("session");
    const report = JSON.parse(stdout);
    expect(report.result.details).toMatchObject({
      answer: "Verified answer",
      grounded: true,
      searchQueries: ["docs"],
      sources: [{ title: "Docs", url: "https://docs.test" }],
    });
    expect(report.result.usage).toMatchObject({
      input: 10,
      output: 5,
      totalTokens: 15,
      cost: { total: 0.001 },
    });
    expect(report.savedSession).toBe("rotated-session");
    expect(report.removedStatus).toBe(404);
    expect(seen).toHaveLength(2);
    expect(seen.map(({ path }) => path)).toEqual([
      "/litellm/v1/chat/completions",
      "/litellm/v1/chat/completions",
    ]);
    expect(seen.map(({ authorization }) => authorization)).toEqual([
      "Bearer initial-session",
      "Bearer rotated-session",
    ]);
    expect(seen.every(({ session }) => session === "canonical-pi-session")).toBe(true);
    expect(seen[0]?.payload).toMatchObject({
      web_search_options: {},
      stream: false,
      metadata: { tool: "web_search", tool_call_id: "search-1" },
    });
    expect(seen[0]?.payload).not.toHaveProperty("tools");
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
