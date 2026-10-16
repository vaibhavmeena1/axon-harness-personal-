import { describe, expect, test } from "bun:test";

import { parseClientConfig } from "../src/cli/client-config.ts";
import { createTerminalPermissionsOverrides } from "../src/harnesses/pi/terminal-permissions-environment.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";

const policy = {
  yoloMode: false,
  allowYoloMode: true,
  autoApproveCommands: ["pwd", "git status"],
  requireApprovalCommands: ["git push"],
  blockedCommands: ["rm"],
  approvalTimeoutMs: 60_000,
};

describe("managed terminal permissions configuration", () => {
  test("validates and forwards the complete public policy through the launcher environment", () => {
    const config = parseClientConfig({ schemaVersion: 1, terminalPermissions: policy });
    expect(config.terminalPermissions).toEqual(policy);
    const inherited = { PI_TERMINAL_MANAGED_CONFIG: "untrusted-marker" };
    const environment = createHarnessEnvironment(
      inherited,
      createTerminalPermissionsOverrides(config.terminalPermissions),
    );
    expect(JSON.parse(environment["PI_TERMINAL_MANAGED_CONFIG"] ?? "null")).toEqual(policy);
    expect(inherited.PI_TERMINAL_MANAGED_CONFIG).toBe("untrusted-marker");
  });

  test("clears an inherited managed marker when no policy was fetched", () => {
    const environment = createHarnessEnvironment(
      {
        PI_TERMINAL_MANAGED_CONFIG: "untrusted-marker",
        PI_TERMINAL_YOLO_MODE: "false",
        PI_TERMINAL_AUTO_APPROVE_COMMANDS: '["pwd"]',
      },
      createTerminalPermissionsOverrides(),
    );
    expect(environment["PI_TERMINAL_MANAGED_CONFIG"]).toBeUndefined();
    expect(environment["PI_TERMINAL_AUTO_APPROVE_COMMANDS"]).toBe('["pwd"]');
    expect(environment["PI_TERMINAL_YOLO_MODE"]).toBe("false");
  });

  test.each([
    { yoloMode: "true" },
    { allowYoloMode: 1 },
    { autoApproveCommands: [""] },
    { autoApproveCommands: [" "] },
    { requireApprovalCommands: ["rm\n"] },
    { blockedCommands: ["rm\u001b"] },
    { blockedCommands: Array(33).fill("rm") },
    { blockedCommands: ["x".repeat(97)] },
    { approvalTimeoutMs: 999 },
    { approvalTimeoutMs: 300_001 },
    { approvalTimeoutMs: 1_000.5 },
    { apiKey: "private" },
  ])("rejects invalid or private terminal settings: %j", (patch) => {
    const config = parseClientConfig({
      schemaVersion: 1,
      terminalPermissions: { ...policy, ...patch },
      telemetry: { enabled: false },
    });
    expect(config.terminalPermissions).toBeUndefined();
    expect(config.telemetry?.enabled).toBe(false);
  });
});
