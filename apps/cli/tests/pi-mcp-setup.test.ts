import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isMcpSyncThrottled,
  PI_MCP_SYNC_FAILURE_INTERVAL_MS,
  PI_MCP_SYNC_SUCCESS_INTERVAL_MS,
  synchronizePiMcpConfig,
} from "../src/harnesses/pi/setup/mcp-config.ts";
import {
  resolvePiMcpConfigPath,
  resolvePiMcpConfigSourceUrl,
} from "../src/harnesses/pi/setup/paths.ts";

let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "axon-pi-mcp-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { force: true, recursive: true });
});

function configPath(name: string): string {
  return join(fixtureDirectory, name, ".config", "mcp", "mcp.json");
}

function catalogResponse(mcpServers: Record<string, unknown>): Response {
  return Response.json({
    settings: { ignoredRemoteSetting: true },
    mcpServers,
  });
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
}

describe("Pi MCP setup paths", () => {
  test("uses the macOS user-global MCP path and the pinned service origin", () => {
    expect(resolvePiMcpConfigPath({ HOME: "/Users/example" })).toBe(
      "/Users/example/.config/mcp/mcp.json",
    );
    expect(resolvePiMcpConfigSourceUrl("https://axon.example")).toBe(
      "https://axon.example/v1/cli/pi/mcp.json",
    );
    expect(resolvePiMcpConfigSourceUrl("https://deputydev.ai/axon")).toBe(
      "https://deputydev.ai/axon/v1/cli/pi/mcp.json",
    );
  });
});

describe("Pi MCP config synchronization", () => {
  test("creates a missing config and forces every organization server off", async () => {
    const path = configPath("create");
    const syncResult = await synchronizePiMcpConfig({
      configPath: path,
      sourceUrl: "https://axon.example/v1/cli/pi/mcp.json",
      fetchConfig: async () =>
        catalogResponse({
          github: {
            url: "https://mcp.example/github",
            disabled: false,
          },
          linear: {
            command: "linear-mcp",
            args: ["serve"],
          },
        }),
    });

    expect(syncResult).toMatchObject({
      status: "created",
      addedServers: ["github", "linear"],
    });
    expect(await readConfig(path)).toEqual({
      mcpServers: {
        github: {
          url: "https://mcp.example/github",
          disabled: true,
        },
        linear: {
          command: "linear-mcp",
          args: ["serve"],
          disabled: true,
        },
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("appends only missing names and preserves all existing user values", async () => {
    const path = configPath("append-only");
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(
      path,
      `${JSON.stringify(
        {
          settings: { directTools: true },
          mcpServers: {
            github: {
              url: "https://user.example/github",
              disabled: false,
              userOption: "keep-me",
            },
            retiredOrgServer: {
              url: "https://old.example/mcp",
              disabled: false,
            },
            personal: {
              command: "personal-mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await chmod(path, 0o640);

    const syncResult = await synchronizePiMcpConfig({
      configPath: path,
      sourceUrl: "https://axon.example/v1/cli/pi/mcp.json",
      fetchConfig: async () =>
        catalogResponse({
          github: {
            url: "https://organization.example/github-v2",
            disabled: true,
          },
          newOrgServer: {
            url: "https://organization.example/new",
            disabled: false,
          },
        }),
    });

    expect(syncResult).toMatchObject({
      status: "updated",
      addedServers: ["newOrgServer"],
    });
    expect(await readConfig(path)).toEqual({
      settings: { directTools: true },
      mcpServers: {
        github: {
          url: "https://user.example/github",
          disabled: false,
          userOption: "keep-me",
        },
        retiredOrgServer: {
          url: "https://old.example/mcp",
          disabled: false,
        },
        personal: {
          command: "personal-mcp",
        },
        newOrgServer: {
          url: "https://organization.example/new",
          disabled: true,
        },
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  test("does not rewrite the user file when the remote list only removes or changes servers", async () => {
    const path = configPath("no-rewrite");
    await mkdir(join(path, ".."), { recursive: true });
    const original = `{"mcpServers":{"kept":{"url":"https://user.example"},"removed-upstream":{"disabled":false}}}\n`;
    await Bun.write(path, original);

    const syncResult = await synchronizePiMcpConfig({
      configPath: path,
      sourceUrl: "https://axon.example/v1/cli/pi/mcp.json",
      fetchConfig: async () =>
        catalogResponse({
          kept: { url: "https://organization.example/changed" },
        }),
    });

    expect(syncResult).toMatchObject({ status: "unchanged", addedServers: [] });
    expect(await Bun.file(path).text()).toBe(original);
  });

  test("leaves an invalid user config untouched without fetching", async () => {
    const path = configPath("invalid-local");
    await mkdir(join(path, ".."), { recursive: true });
    const original = "{ not valid json\n";
    await Bun.write(path, original);
    let fetchCalls = 0;

    const syncResult = await synchronizePiMcpConfig({
      configPath: path,
      sourceUrl: "https://axon.example/v1/cli/pi/mcp.json",
      fetchConfig: async () => {
        fetchCalls += 1;
        return catalogResponse({ newServer: { command: "new-server" } });
      },
    });

    expect(syncResult.status).toBe("skipped");
    expect(syncResult.warning).toContain("left");
    expect(fetchCalls).toBe(0);
    expect(await Bun.file(path).text()).toBe(original);
  });

  test("re-reads a config created while the catalog request is in flight", async () => {
    const path = configPath("created-during-fetch");

    const syncResult = await synchronizePiMcpConfig({
      configPath: path,
      sourceUrl: "https://axon.example/v1/cli/pi/mcp.json",
      fetchConfig: async () => {
        await mkdir(join(path, ".."), { recursive: true });
        await Bun.write(
          path,
          JSON.stringify({
            mcpServers: {
              personal: { command: "personal-mcp", disabled: false },
            },
          }),
        );
        return catalogResponse({ organization: { command: "organization-mcp" } });
      },
    });

    expect(syncResult).toMatchObject({ status: "updated", addedServers: ["organization"] });
    expect(await readConfig(path)).toEqual({
      mcpServers: {
        personal: { command: "personal-mcp", disabled: false },
        organization: { command: "organization-mcp", disabled: true },
      },
    });
  });

  test("creates a safe empty scaffold when the catalog is temporarily unavailable", async () => {
    const path = configPath("offline-first-run");

    const syncResult = await synchronizePiMcpConfig({
      configPath: path,
      sourceUrl: "https://axon.example/v1/cli/pi/mcp.json",
      fetchConfig: async () => {
        throw new Error("offline");
      },
    });

    expect(syncResult.status).toBe("created");
    expect(syncResult.warning).toContain("could not be fetched");
    expect(await readConfig(path)).toEqual({ mcpServers: {} });
  });
});

describe("Pi MCP sync throttling", () => {
  const sourceUrl = "https://axon.example/v1/cli/pi/mcp.json";

  test("evaluates the stamp by status, age, and source", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const okStamp = {
      schemaVersion: 1 as const,
      lastAttemptAt: new Date(now.getTime() - 60_000).toISOString(),
      lastStatus: "ok" as const,
      sourceUrl,
    };
    expect(isMcpSyncThrottled(okStamp, sourceUrl, now)).toBe(true);
    expect(isMcpSyncThrottled(okStamp, "https://other.example/mcp.json", now)).toBe(false);
    expect(
      isMcpSyncThrottled(
        {
          ...okStamp,
          lastAttemptAt: new Date(now.getTime() - PI_MCP_SYNC_SUCCESS_INTERVAL_MS).toISOString(),
        },
        sourceUrl,
        now,
      ),
    ).toBe(false);
    expect(isMcpSyncThrottled({ ...okStamp, lastStatus: "failed" }, sourceUrl, now)).toBe(true);
    expect(
      isMcpSyncThrottled(
        {
          ...okStamp,
          lastStatus: "failed",
          lastAttemptAt: new Date(now.getTime() - PI_MCP_SYNC_FAILURE_INTERVAL_MS).toISOString(),
        },
        sourceUrl,
        now,
      ),
    ).toBe(false);
    expect(isMcpSyncThrottled(undefined, sourceUrl, now)).toBe(false);
  });

  test("records attempts, skips within the interval, and honors force", async () => {
    const path = configPath("throttle");
    const stampPath = join(fixtureDirectory, "throttle", "pi-mcp-sync.json");
    let fetchCalls = 0;
    let clock = new Date("2026-09-15T12:00:00Z");
    const options = {
      configPath: path,
      sourceUrl,
      stampPath,
      now: () => clock,
      fetchConfig: async () => {
        fetchCalls += 1;
        return catalogResponse({ organization: { url: "https://mcp.example/mcp" } });
      },
    };

    const first = await synchronizePiMcpConfig(options);
    expect(first.status).toBe("created");
    expect(fetchCalls).toBe(1);
    expect(await readConfig(stampPath)).toMatchObject({
      schemaVersion: 1,
      lastStatus: "ok",
      sourceUrl,
      lastAttemptAt: clock.toISOString(),
    });

    clock = new Date(clock.getTime() + 60_000);
    const second = await synchronizePiMcpConfig(options);
    expect(second.status).toBe("throttled");
    expect(fetchCalls).toBe(1);

    const forced = await synchronizePiMcpConfig({ ...options, force: true });
    expect(forced.status).toBe("unchanged");
    expect(fetchCalls).toBe(2);

    clock = new Date(clock.getTime() + PI_MCP_SYNC_SUCCESS_INTERVAL_MS);
    const third = await synchronizePiMcpConfig(options);
    expect(third.status).toBe("unchanged");
    expect(fetchCalls).toBe(3);
  });

  test("retries a failed attempt sooner than a successful one", async () => {
    const path = configPath("throttle-failure");
    const stampPath = join(fixtureDirectory, "throttle-failure", "pi-mcp-sync.json");
    let fetchCalls = 0;
    let clock = new Date("2026-09-15T12:00:00Z");
    const options = {
      configPath: path,
      sourceUrl,
      stampPath,
      now: () => clock,
      fetchConfig: async () => {
        fetchCalls += 1;
        throw new Error("offline");
      },
    };

    expect((await synchronizePiMcpConfig(options)).status).toBe("created");
    expect(await readConfig(stampPath)).toMatchObject({ lastStatus: "failed" });

    clock = new Date(clock.getTime() + 60_000);
    expect((await synchronizePiMcpConfig(options)).status).toBe("throttled");
    expect(fetchCalls).toBe(1);

    clock = new Date(clock.getTime() + PI_MCP_SYNC_FAILURE_INTERVAL_MS);
    expect((await synchronizePiMcpConfig(options)).status).toBe("unchanged");
    expect(fetchCalls).toBe(2);
  });
});
