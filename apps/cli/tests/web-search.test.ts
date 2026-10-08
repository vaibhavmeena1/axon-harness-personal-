import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import webSearchExtension from "../src/harnesses/pi/resources/extensions/web-search.ts";

type Tool = Parameters<Parameters<typeof webSearchExtension>[0]["registerTool"]>[0];
type Context = NonNullable<Parameters<Tool["execute"]>[4]>;
let savedEnvironment: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

function searchEnvironment(name: string): boolean {
  return (
    name.startsWith("PI_WEB_SEARCH_") || ["LITELLM_BASE_URL", "LITELLM_API_KEY"].includes(name)
  );
}
function clearSearchEnvironment(): void {
  for (const name of Object.keys(process.env))
    if (searchEnvironment(name)) delete process.env[name];
}
function groundedResponse(
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    {
      choices: [
        {
          message: {
            content: "Grounded answer",
            annotations: [
              {
                type: "url_citation",
                url_citation: { title: "Docs", url: "https://docs.example.test" },
              },
            ],
          },
        },
      ],
      ...extra,
    },
    { headers },
  );
}

beforeEach(() => {
  savedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => searchEnvironment(name)),
  );
  clearSearchEnvironment();
  process.env["PI_WEB_SEARCH_BASE_URL"] = "https://search.example.test/v1";
  process.env["PI_WEB_SEARCH_API_KEY"] = "test-key";
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(groundedResponse());
});
afterEach(() => {
  fetchSpy.mockRestore();
  clearSearchEnvironment();
  for (const [name, value] of Object.entries(savedEnvironment))
    if (value !== undefined) process.env[name] = value;
});

function registerTool(): Tool {
  let tool: Tool | undefined;
  webSearchExtension({
    registerTool(registered) {
      tool = registered;
    },
  });
  if (!tool) throw new Error("Web search was not registered");
  return tool;
}
function sentPayload(): Record<string, unknown> {
  return JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
}
function requestHeaders(): Headers {
  return new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
}
function execute(ctx?: Context, signal?: AbortSignal) {
  return registerTool().execute("call-1", { query: "Current docs" }, signal, undefined, ctx);
}

describe("standalone LiteLLM web search", () => {
  test("uses unified search options with a dedicated completion and extension-owned prompt", async () => {
    const result = await execute({
      sessionManager: { getSessionId: () => "canonical-session-id" },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://search.example.test/v1/chat/completions");
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(result.details.model).toBe("gemini-3.8-flash");
    expect(sentPayload()).toMatchObject({
      model: "gemini-3.8-flash",
      max_tokens: 8192,
      stream: false,
      web_search_options: {},
    });
    expect(sentPayload()).not.toHaveProperty("tools");
    expect(sentPayload()).not.toHaveProperty("reasoning_effort");
    const messages = sentPayload()["messages"] as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("Current UTC date:");
    expect(messages[1]).toEqual({ role: "user", content: "Current docs" });
    const metadata = sentPayload()["metadata"] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      tool: "web_search",
      harness_id: "pi",
      tool_call_id: "call-1",
    });
    expect(metadata["spend_logs_metadata"]).toMatchObject({
      request_id: metadata["request_id"],
      tool: "web_search",
    });
    expect(metadata).not.toHaveProperty("user_id");
    expect(requestHeaders().get("x-request-id")).toBe(metadata["request_id"] as string);
    expect(requestHeaders().get("x-litellm-session-id")).toBe("canonical-session-id");
    expect(requestHeaders().get("authorization")).toBe("Bearer test-key");
  });

  for (const level of ["low", "medium", "high"]) {
    test(`passes ${level} reasoning and search context preferences`, async () => {
      process.env["PI_WEB_SEARCH_THINKING_LEVEL"] = level;
      process.env["PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE"] = level;
      await execute();
      expect(sentPayload()["reasoning_effort"]).toBe(level);
      expect(sentPayload()["web_search_options"]).toEqual({ search_context_size: level });
      expect(sentPayload()).not.toHaveProperty("thinking");
    });
  }
  for (const name of ["THINKING_LEVEL", "SEARCH_CONTEXT_SIZE"]) {
    for (const value of ["minimal", "auto", "HIGH", "1024"]) {
      test(`rejects invalid ${name} ${value} before fetching`, async () => {
        process.env[`PI_WEB_SEARCH_${name}`] = value;
        await expect(execute()).rejects.toThrow(
          `PI_WEB_SEARCH_${name} must be low, medium, or high`,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }
  }
  test("URL context is optional without duplicating the search tool", async () => {
    process.env["PI_WEB_SEARCH_USE_URL_CONTEXT"] = "true";
    process.env["PI_WEB_SEARCH_TEMPERATURE"] = "0.5";
    await execute();
    expect(sentPayload()).toMatchObject({
      tools: [{ urlContext: {} }],
      temperature: 0.5,
      web_search_options: {},
    });
  });
  test("disabled search registers no tool", () => {
    process.env["PI_WEB_SEARCH_ENABLED"] = "false";
    const register = mock();
    webSearchExtension({ registerTool: register });
    expect(register).not.toHaveBeenCalled();
  });
  test("rejects query and generation limits before a request", async () => {
    process.env["PI_WEB_SEARCH_MAX_QUERY_CHARACTERS"] = "2";
    await expect(execute()).rejects.toThrow("query is empty or exceeds");
    process.env["PI_WEB_SEARCH_MAX_QUERY_CHARACTERS"] = "100";
    process.env["PI_WEB_SEARCH_TEMPERATURE"] = "Infinity";
    await expect(execute()).rejects.toThrow("TEMPERATURE must be between");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("request-time auth and credential root safety", () => {
  function providerContext(auth: Record<string, unknown>): Context {
    return {
      modelRegistry: {
        getProviderAuth: mock(
          async () =>
            auth as Awaited<ReturnType<NonNullable<Context["modelRegistry"]>["getProviderAuth"]>>,
        ),
        getProvider: () => ({ baseUrl: "https://wrong.example.test/v1" }),
      },
    };
  }
  test("managed relay credentials beat saved provider auth and never expose the real session", async () => {
    process.env["PI_WEB_SEARCH_URL"] = "http://127.0.0.1:12345/litellm/v1/chat/completions";
    process.env["PI_WEB_SEARCH_API_KEY"] = "local-capability";
    const ctx = providerContext({
      auth: { apiKey: "saved-secret", baseUrl: "https://other.test" },
    });
    await execute(ctx);
    expect(ctx.modelRegistry?.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:12345/litellm/v1/chat/completions");
    expect(requestHeaders().get("authorization")).toBe("Bearer local-capability");
  });
  test("plain Pi resolves refreshed credentials, root, and headers on every call", async () => {
    delete process.env["PI_WEB_SEARCH_API_KEY"];
    delete process.env["PI_WEB_SEARCH_BASE_URL"];
    process.env["LITELLM_API_KEY"] = "stale-env-key";
    process.env["LITELLM_BASE_URL"] = "https://stale-env.test";
    process.env["PI_WEB_SEARCH_PROVIDER"] = "litellm-search";
    const getAuth = mock(async () => ({
      auth: {
        apiKey: "fresh-token",
        baseUrl: "https://fresh.test/tenant",
        headers: { "x-tenant": "test" },
      },
    }));
    const ctx: Context = {
      modelRegistry: { getProviderAuth: getAuth, getProvider: () => undefined },
    };
    await execute(ctx);
    expect(getAuth).toHaveBeenCalledWith("litellm-search");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://fresh.test/tenant/v1/chat/completions");
    expect(requestHeaders().get("authorization")).toBe("Bearer fresh-token");
    expect(requestHeaders().get("x-tenant")).toBe("test");
    getAuth.mockResolvedValueOnce({
      auth: {
        apiKey: "rotated-token",
        baseUrl: "https://fresh.test/tenant",
        headers: { "x-tenant": "test" },
      },
    });
    fetchSpy.mockResolvedValueOnce(groundedResponse());
    await execute(ctx);
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer rotated-token",
    );
  });
  test("refuses to borrow provider credentials for a foreign destination", async () => {
    delete process.env["PI_WEB_SEARCH_API_KEY"];
    const ctx = providerContext({
      auth: { apiKey: "secret", baseUrl: "https://credential.test/tenant" },
    });
    await expect(execute(ctx)).rejects.toThrow("does not match the LiteLLM credential root");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test("provider auth errors never fall back to an ambient key", async () => {
    delete process.env["PI_WEB_SEARCH_API_KEY"];
    process.env["LITELLM_API_KEY"] = "ambient-secret";
    const ctx: Context = {
      modelRegistry: {
        getProviderAuth: async () => {
          throw new Error("private auth detail");
        },
        getProvider: () => undefined,
      },
    };
    await expect(execute(ctx)).rejects.toThrow("credentials are unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test("environment-only direct auth stays on its configured root", async () => {
    delete process.env["PI_WEB_SEARCH_API_KEY"];
    delete process.env["PI_WEB_SEARCH_BASE_URL"];
    process.env["LITELLM_BASE_URL"] = "https://env.test/prefix/v1";
    process.env["LITELLM_API_KEY"] = "env-key";
    await execute();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://env.test/prefix/v1/chat/completions");
    expect(requestHeaders().get("authorization")).toBe("Bearer env-key");
  });
  for (const url of [
    "file:///tmp/sink",
    "https://user:secret@host.test",
    "https://host.test?secret=1",
    "https://host.test#secret",
  ]) {
    test(`rejects unsafe endpoint ${url}`, async () => {
      process.env["PI_WEB_SEARCH_URL"] = url;
      await expect(execute()).rejects.toThrow("Web search URL must use HTTP(S)");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

describe("grounding and accounting", () => {
  for (const container of ["top", "message", "provider", "hidden"]) {
    test(`normalizes Gemini ${container} grounding with source filtering and Unicode limits`, async () => {
      const metadata = {
        grounding_chunks: [
          { web: { uri: "https://docs.test", title: "Docs" } },
          { web: { uri: "javascript:alert(1)" } },
          { web: { uri: "https://secret@docs.test" } },
        ],
        web_search_queries: ["query", "query", 12],
        search_entry_point: { rendered_content: "<div>Attribution</div>" },
      };
      const message: Record<string, unknown> = { content: [{ text: "😀answer" }] };
      const payload: Record<string, unknown> = { choices: [{ message }] };
      const fields = { grounding_metadata: [metadata] };
      if (container === "top") Object.assign(payload, fields);
      else if (container === "message") Object.assign(message, fields);
      else if (container === "provider") payload["provider_specific_fields"] = fields;
      else message["_hidden_params"] = fields;
      process.env["PI_WEB_SEARCH_MAX_RESULT_CHARACTERS"] = "2";
      fetchSpy.mockResolvedValueOnce(Response.json(payload));
      const { details } = await execute();
      expect(details).toMatchObject({
        answer: "😀a",
        truncated: true,
        grounded: true,
        searchQueries: ["query"],
        searchEntryPoint: "<div>Attribution</div>",
      });
      expect(details.sources).toEqual([{ title: "Docs", url: "https://docs.test" }]);
    });
  }
  test("requires evidence unless grounding is explicitly optional", async () => {
    const ungrounded = { choices: [{ message: { content: "No citations" } }] };
    fetchSpy.mockResolvedValueOnce(Response.json(ungrounded));
    await expect(execute()).rejects.toThrow("no grounding evidence");
    process.env["PI_WEB_SEARCH_REQUIRE_GROUNDING"] = "false";
    fetchSpy.mockResolvedValueOnce(Response.json(ungrounded));
    expect((await execute()).details.grounded).toBe(false);
  });
  test("reports token usage and authoritative LiteLLM cost in the tool result", async () => {
    fetchSpy.mockResolvedValueOnce(
      groundedResponse(
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 40,
            total_tokens: 140,
            prompt_tokens_details: { cached_tokens: 20 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
        { "x-litellm-response-cost": "0.014" },
      ),
    );
    const { usage } = await execute();
    expect(usage).toMatchObject({
      input: 80,
      output: 40,
      cacheRead: 20,
      cacheWrite: 0,
      totalTokens: 140,
      reasoning: 5,
    });
    expect(usage?.cost.total).toBe(0.014);
    expect(usage?.cost.input).toBeCloseTo(0.008);
    expect(usage?.cost.output).toBeCloseTo(0.004);
    expect(usage?.cost.cacheRead).toBeCloseTo(0.002);
  });
  for (const cost of ["Infinity", "NaN", "-1", "not-a-cost"]) {
    test(`does not report invalid response cost ${cost}`, async () => {
      fetchSpy.mockResolvedValueOnce(
        groundedResponse(
          { usage: { prompt_tokens: 10, completion_tokens: 5 } },
          { "x-litellm-response-cost": cost },
        ),
      );
      expect((await execute()).usage?.cost.total).toBe(0);
    });
  }
});

describe("sanitized failures, limits and cancellation", () => {
  for (const status of [401, 403, 429, 500]) {
    test(`never exposes upstream error bodies for HTTP ${status}`, async () => {
      fetchSpy.mockResolvedValueOnce(new Response("private-key and reflected query", { status }));
      await expect(execute()).rejects.toThrow(`Web search failed (HTTP ${status})`);
    });
  }
  test("rejects oversized and malformed JSON responses", async () => {
    fetchSpy.mockResolvedValueOnce(
      groundedResponse({}, { "content-length": String(5 * 1024 * 1024) }),
    );
    await expect(execute()).rejects.toThrow("response size");
    fetchSpy.mockResolvedValueOnce(new Response("not JSON"));
    await expect(execute()).rejects.toThrow("Invalid JSON");
  });
  test("deadline includes a stalled response body and releases the reader", async () => {
    process.env["PI_WEB_SEARCH_TIMEOUT_MS"] = "20";
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"choices":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    fetchSpy.mockResolvedValueOnce(response);
    await expect(execute()).rejects.toThrow("timed out after 20ms");
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
  test("deadline includes provider credential resolution and never sends a late request", async () => {
    delete process.env["PI_WEB_SEARCH_API_KEY"];
    delete process.env["PI_WEB_SEARCH_BASE_URL"];
    process.env["PI_WEB_SEARCH_TIMEOUT_MS"] = "20";
    const ctx: Context = {
      modelRegistry: {
        getProviderAuth: () => new Promise(() => {}),
        getProvider: () => undefined,
      },
    };
    await expect(execute(ctx)).rejects.toThrow("timed out after 20ms");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  test("already cancelled calls do not resolve auth or fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(execute(undefined, controller.signal)).rejects.toThrow("Web search cancelled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
