import { describe, expect, test } from "bun:test";

import {
  createServiceUrlResolver,
  fillEndpointTemplate,
  listServiceEndpoints,
  resolveServiceUrl,
  SERVICE_ENDPOINTS,
} from "../src/product/endpoints.ts";

describe("service endpoints registry", () => {
  test("every endpoint is a rooted versioned API path", () => {
    for (const { path } of listServiceEndpoints()) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.startsWith("/v1/") || path.startsWith("/api/v1/")).toBe(true);
    }
  });

  test("registry entries are unique", () => {
    const paths = listServiceEndpoints().map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("pi MCP catalog and release paths stay pinned", () => {
    expect(SERVICE_ENDPOINTS.pi.mcpConfig).toBe("/v1/cli/pi/mcp.json");
    expect(SERVICE_ENDPOINTS.release.base).toBe("/api/v1/cli/releases");
    expect(SERVICE_ENDPOINTS.auth.browserLogin).toBe("/api/v1/auth/browser-login");
    expect(SERVICE_ENDPOINTS.cli.config).toBe("/api/v1/cli/config");
  });
});

describe("resolveServiceUrl", () => {
  test("joins origin and endpoint without double slashes", () => {
    expect(resolveServiceUrl("https://example.test", SERVICE_ENDPOINTS.pi.mcpConfig)).toBe(
      "https://example.test/v1/cli/pi/mcp.json",
    );
    expect(resolveServiceUrl("https://example.test/", SERVICE_ENDPOINTS.pi.mcpConfig)).toBe(
      "https://example.test/v1/cli/pi/mcp.json",
    );
  });

  test("appends an optional query string", () => {
    expect(
      resolveServiceUrl("https://example.test", SERVICE_ENDPOINTS.pi.mcpConfig, {
        profile: "default",
      }),
    ).toBe("https://example.test/v1/cli/pi/mcp.json?profile=default");
  });

  test("bound resolver reuses one origin", () => {
    const toUrl = createServiceUrlResolver("https://example.test");
    expect(toUrl(SERVICE_ENDPOINTS.pi.mcpConfig)).toBe("https://example.test/v1/cli/pi/mcp.json");
  });
});

describe("fillEndpointTemplate", () => {
  test("encodes path parameters", () => {
    expect(fillEndpointTemplate("/v1/items/:id", { id: "a/b" })).toBe("/v1/items/a%2Fb");
  });

  test("throws on missing parameters", () => {
    expect(() => fillEndpointTemplate("/v1/items/:id", {})).toThrow("missing endpoint parameter");
  });
});
