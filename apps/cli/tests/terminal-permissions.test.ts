import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ExtensionUIDialogOptions,
  ToolCallEvent,
  ToolCallEventResult,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

import terminalPermissions, {
  TERMINAL_HEADER_CHANNEL,
} from "../src/harnesses/pi/resources/extensions/terminal-permissions.ts";

type ToolHandler = (
  event: ToolCallEvent,
  context: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;
type UserBashHandler = (
  event: UserBashEvent,
  context: ExtensionContext,
) => Promise<UserBashEventResult | undefined>;
type SessionHandler = (event: unknown, context: ExtensionContext) => void;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
let savedEnvironment: Record<string, string | undefined>;

function clearTerminalEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("PI_TERMINAL_")) delete process.env[name];
  }
}

beforeEach(() => {
  savedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith("PI_TERMINAL_")),
  );
  clearTerminalEnvironment();
});
afterEach(() => {
  clearTerminalEnvironment();
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value !== undefined) process.env[name] = value;
  }
});

function setup(hasUI = true) {
  const handlers = new Map<string, unknown>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const commands = new Map<string, Command>();
  const settings: ReturnType<ExtensionAPI["getSettings"]> = {};
  const confirm = mock(
    async (_title: string, _message: string, _options?: ExtensionUIDialogOptions) => true,
  );
  const notify = mock((_message: string, _type?: string) => {});
  const setStatus = mock((_key: string, _value?: string) => {});
  const emit = mock((_channel: string, _data: unknown) => {});
  const context = {
    cwd: "/synthetic/project",
    hasUI,
    signal: undefined,
    ui: { confirm, notify, setStatus },
  } as unknown as ExtensionContext;
  terminalPermissions({
    events: { emit },
    getSettings: () => settings,
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  const toolHandler = handlers.get("tool_call") as ToolHandler;
  const userHandler = handlers.get("user_bash") as UserBashHandler;
  function callInput(input: Record<string, unknown>, toolName = "bash", parentToolCallId?: string) {
    return toolHandler(
      {
        type: "tool_call",
        toolName,
        toolCallId: parentToolCallId ? `${parentToolCallId}/1` : "terminal-call",
        input,
        ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      } as ToolCallEvent,
      context,
    );
  }
  return {
    context,
    tools,
    settings,
    confirm,
    notify,
    setStatus,
    emit,
    headerStates: () =>
      emit.mock.calls
        .filter(([channel]) => channel === TERMINAL_HEADER_CHANNEL)
        .map(([, state]) => state),
    callInput,
    call(
      command: string,
      toolName = "bash",
      parentToolCallId?: string,
      requiresApproval: unknown = false,
    ) {
      return callInput(
        { command, requires_approval: requiresApproval },
        toolName,
        parentToolCallId,
      );
    },
    userBash(command: string) {
      return userHandler(
        { type: "user_bash", command, cwd: context.cwd, excludeFromContext: false },
        context,
      );
    },
    start() {
      (handlers.get("session_start") as SessionHandler)({}, context);
    },
    shutdown() {
      (handlers.get("session_shutdown") as SessionHandler)({}, context);
    },
    async command(args = "", name = "yolo") {
      const command = commands.get(name);
      if (!command) throw new Error(`Command ${name} was not registered`);
      await command.handler(args, context as Parameters<Command["handler"]>[1]);
    },
  };
}

function managedPolicy(overrides: Record<string, unknown> = {}): void {
  process.env["PI_TERMINAL_MANAGED_CONFIG"] = JSON.stringify({
    yoloMode: false,
    requireApprovalCommands: [],
    blockedCommands: [],
    approvalTimeoutMs: 60_000,
    ...overrides,
  });
}

describe("Standard mode defaults", () => {
  test("starts in Standard even when backend grants YOLO eligibility", () => {
    managedPolicy({ yoloMode: true });
    const harness = setup();
    harness.start();
    expect(harness.headerStates()).toEqual(["standard"]);
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.emit.mock.calls).toContainEqual([
      "axon:telemetry",
      { category: "terminal", stage: "policy", outcome: "success", yoloMode: false },
    ]);
  });

  test.each([
    "pwd",
    "git status --short",
    "git diff --stat",
    "git diff --output=result",
    "git push",
    "rm file",
    "bun test",
    "npm install",
    "unknown-command",
    "/bin/pwd",
    "git status && bun test | cat",
    "cat /etc/hosts",
  ])("auto-runs supported commands with requires_approval=false: %s", async (command) => {
    const harness = setup(false);
    expect(await harness.call(command)).toBeUndefined();
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("honors model review requests and shows the command and cwd", async () => {
    const harness = setup();
    expect(await harness.call("git push origin main", "bash", undefined, true)).toBeUndefined();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    expect(harness.confirm.mock.calls[0]?.[1]).toContain("model requested approval");
    expect(harness.confirm.mock.calls[0]?.[1]).toContain("git push origin main");
    expect(harness.confirm.mock.calls[0]?.[1]).toContain(harness.context.cwd);
    expect(harness.confirm.mock.calls[0]?.[2]?.timeout).toBeGreaterThan(0);
    expect(harness.confirm.mock.calls[0]?.[2]?.timeout).toBeLessThanOrEqual(60_000);
  });

  test("denies review requests when no UI is available", async () => {
    const harness = setup(false);
    expect(await harness.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test.each(["echo $(pwd)", "echo `pwd`", "pwd > output", "env pwd", "bash -c 'pwd'"])(
    "retains explicit review for complex syntax and wrappers: %s",
    async (command) => {
      const harness = setup();
      harness.confirm.mockResolvedValue(false);
      expect(await harness.call(command)).toMatchObject({ block: true });
      expect(harness.confirm).toHaveBeenCalledTimes(1);
    },
  );

  test("requires review for PowerShell and custom shells", async () => {
    const harness = setup(false);
    expect(await harness.call("Get-ChildItem", "powershell")).toMatchObject({ block: true });
    harness.settings.shellPath = "/custom/bash";
    expect(await harness.call("pwd")).toMatchObject({ block: true });
  });

  test("does not intercept unrelated tools", async () => {
    expect(await setup(false).call("irrelevant", "read")).toBeUndefined();
  });

  test("applies required-approval prefixes to paths, Git options, and every segment", async () => {
    managedPolicy({ requireApprovalCommands: ["git push"] });
    const harness = setup(false);
    for (const command of [
      "git push",
      "/usr/bin/git push",
      "git --no-pager push",
      "pwd && git push",
    ]) {
      expect(await harness.call(command)).toMatchObject({ block: true });
    }
    expect(await harness.call("git push-extra")).toBeUndefined();
    expect(await harness.call("git status")).toBeUndefined();
  });

  test("uses fetched lists instead of inherited local lists", async () => {
    managedPolicy({ requireApprovalCommands: ["git push"], blockedCommands: ["rm"] });
    process.env["PI_TERMINAL_BLOCKED_COMMANDS"] = '["pwd"]';
    process.env["PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS"] = '["pwd"]';
    const harness = setup(false);
    expect(await harness.call("pwd")).toBeUndefined();
    expect(await harness.call("rm file")).toMatchObject({ block: true });
    expect(await harness.call("git push")).toMatchObject({ block: true });
  });

  test("retains conservative blocklist handling in Standard", async () => {
    managedPolicy({ blockedCommands: ["rm"] });
    const harness = setup();
    expect(await harness.call("sudo rm file")).toMatchObject({ block: true });
    expect(await harness.call("echo $(pwd)")).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("checks command prefixes and shows the effective command for review", async () => {
    const harness = setup();
    harness.settings.shellCommandPrefix = "echo setup";
    expect(await harness.call("pwd")).toBeUndefined();
    await harness.call("pwd", "bash", undefined, true);
    expect(harness.confirm.mock.calls[0]?.[1]).toContain("echo setup\npwd");
    managedPolicy({ blockedCommands: ["rm"] });
    const blocked = setup();
    blocked.settings.shellCommandPrefix = "rm file";
    expect(await blocked.call("pwd")).toMatchObject({ block: true });
    expect(blocked.confirm).not.toHaveBeenCalled();
  });
});

describe("backend eligibility and session-local /yolo toggle", () => {
  test.each([true, false, undefined])(
    "never activates from backend or environment: %j",
    async (eligibility) => {
      if (eligibility !== undefined) managedPolicy({ yoloMode: eligibility });
      process.env["PI_TERMINAL_YOLO_MODE"] = "true";
      const harness = setup(false);
      harness.start();
      expect(harness.headerStates()).toEqual(["standard"]);
      expect(await harness.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
    },
  );

  test.each([false, undefined])(
    "refuses /yolo without backend permission: %j",
    async (eligibility) => {
      if (eligibility !== undefined) managedPolicy({ yoloMode: eligibility });
      process.env["PI_TERMINAL_YOLO_MODE"] = "true";
      const harness = setup();
      harness.start();
      await harness.command();
      expect(harness.headerStates()).toEqual(["standard"]);
      expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("backend policy does not permit");
      expect(harness.confirm).not.toHaveBeenCalled();
    },
  );

  test("toggles without a confirmation dialog and resets on session replacement", async () => {
    managedPolicy({ yoloMode: true });
    const harness = setup();
    harness.start();
    await harness.command();
    expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("YOLO on for this session");
    expect(await harness.call("pwd", "bash", undefined, true)).toBeUndefined();
    await harness.command();
    expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("Standard mode restored");
    await harness.command();
    harness.start();
    expect(harness.headerStates()).toEqual(["standard", "yolo", "standard", "yolo", "standard"]);
    expect(harness.confirm).not.toHaveBeenCalled();
    harness.context.hasUI = false;
    expect(await harness.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
  });

  test("activation is independent for each extension instance and cleared on shutdown", async () => {
    managedPolicy({ yoloMode: true });
    const first = setup();
    const second = setup(false);
    await first.command();
    expect(await first.call("pwd", "bash", undefined, true)).toBeUndefined();
    expect(await second.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
    first.shutdown();
    first.context.hasUI = false;
    expect(await first.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
  });

  test("does not activate headlessly or accept on/off arguments", async () => {
    managedPolicy({ yoloMode: true });
    const headless = setup(false);
    await headless.command();
    expect(await headless.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
    const harness = setup();
    harness.start();
    for (const args of ["on", "off", "status"]) await harness.command(args);
    expect(harness.headerStates()).toEqual(["standard"]);
    expect(harness.notify.mock.calls.at(-1)?.[0]).toContain("Usage: /yolo");
  });

  test("does not activate with an aborted command context", async () => {
    managedPolicy({ yoloMode: true });
    const harness = setup();
    harness.start();
    harness.context.signal = AbortSignal.abort();
    await harness.command();
    expect(harness.headerStates()).toEqual(["standard"]);
  });

  test("status distinguishes availability from activation and cannot enable YOLO", async () => {
    managedPolicy({
      yoloMode: true,
      requireApprovalCommands: ["git push"],
      approvalTimeoutMs: 10_000,
    });
    const harness = setup();
    await harness.command("yolo on", "terminal-permissions");
    const status = harness.notify.mock.calls.at(-1)?.[0];
    expect(status).toContain("Mode: Standard");
    expect(status).toContain("YOLO available: yes");
    expect(status).toContain("Require approval (Standard only): git push");
    expect(status).toContain("Approval timeout: 10s");
    expect(harness.headerStates()).toEqual([]);
  });

  test.each([
    ["PI_TERMINAL_BLOCKED_COMMANDS", "[123]"],
    ["PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS", '["pwd && rm"]'],
    ["PI_TERMINAL_APPROVAL_TIMEOUT_MS", "0"],
    ["PI_TERMINAL_MANAGED_CONFIG", "{}"],
    ["PI_TERMINAL_MANAGED_CONFIG", '{"yoloMode":"true"}'],
  ])("fails closed for invalid %s", async (name, value) => {
    process.env[name] = value;
    const harness = setup();
    harness.start();
    await harness.command();
    expect(harness.headerStates()).toEqual(["blocked"]);
    expect(await harness.call("pwd")).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("ignores removed local YOLO and auto-approval settings", async () => {
    process.env["PI_TERMINAL_YOLO_MODE"] = "invalid";
    process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] = "invalid";
    const harness = setup(false);
    harness.start();
    expect(harness.headerStates()).toEqual(["standard"]);
    expect(await harness.call("bun test")).toBeUndefined();
  });
});

describe("fully autonomous execution and best-effort blocklists", () => {
  test.each([
    "git push",
    "rm file",
    "echo $(pwd)",
    "echo `pwd`",
    "pwd > output",
    "env pwd",
    "bash -c 'rm file'",
    "sudo rm file",
    "python script.py",
    "if true; then pwd; fi",
    "pwd &",
    "./script.sh",
  ])("never prompts for model intent, required rules, wrappers, or syntax: %s", async (command) => {
    managedPolicy({
      yoloMode: true,
      requireApprovalCommands: ["git push", "rm", "sudo"],
      blockedCommands: ["rm"],
    });
    const harness = setup();
    await harness.command();
    // Direct blocked commands remain denied; hidden commands are intentionally best-effort.
    const result = await harness.call(command, "bash", undefined, true);
    if (command === "rm file") expect(result).toMatchObject({ block: true });
    else expect(result).toBeUndefined();
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("allows PowerShell, custom shells, command prefixes, and nested/user calls", async () => {
    managedPolicy({ yoloMode: true });
    const harness = setup();
    await harness.command();
    harness.settings.shellPath = "/custom/bash";
    harness.settings.shellCommandPrefix = "export SETUP=1";
    harness.context.hasUI = false;
    expect(await harness.call("Get-ChildItem", "powershell", undefined, true)).toBeUndefined();
    expect(await harness.call("bash -c 'pwd'", "bash", "codemode-parent", true)).toBeUndefined();
    expect(await harness.userBash("echo $(pwd)")).toBeUndefined();
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "blocks recognizable prefixes without prompting in YOLO=%j",
    async (yolo) => {
      managedPolicy({ yoloMode: true, blockedCommands: ["rm", "git push", "Remove-Item"] });
      const harness = setup();
      if (yolo) await harness.command();
      for (const command of [
        "rm file",
        "/bin/rm file",
        "r'm' file",
        "pwd && rm file",
        "git --no-pager push",
      ]) {
        expect(await harness.call(command, "bash", "codemode-parent", true)).toMatchObject({
          block: true,
        });
      }
      expect(await harness.call("Remove-Item file", "powershell")).toMatchObject({ block: true });
      await expect(harness.userBash("rm file")).rejects.toThrow("block list");
      expect(harness.confirm).not.toHaveBeenCalled();
    },
  );

  test("validates command and approval-intent types even in YOLO", async () => {
    managedPolicy({ yoloMode: true });
    const harness = setup();
    await harness.command();
    for (const input of [
      { command: "pwd" },
      { command: "pwd", requires_approval: "false" },
      { command: "pwd", requires_approval: null },
      { command: 12, requires_approval: false },
      { command: "", requires_approval: false },
      { command: "pwd\u0000", requires_approval: false },
    ])
      expect(await harness.callInput(input)).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });
});

describe("terminal approval cancellation and concurrency", () => {
  test("cancellation prevents approval and is passed to the confirmation UI", async () => {
    const controller = new AbortController();
    const harness = setup();
    harness.context.signal = controller.signal;
    harness.confirm.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    expect(await harness.call("git push", "bash", undefined, true)).toMatchObject({ block: true });
    expect(harness.confirm.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
  });

  test("a failed confirmation refuses the command without poisoning the next request", async () => {
    const harness = setup();
    harness.confirm.mockRejectedValueOnce(new Error("UI unavailable"));
    expect(await harness.call("git push", "bash", undefined, true)).toMatchObject({ block: true });
    expect(await harness.call("git push", "bash", undefined, true)).toBeUndefined();
  });

  test("retains a queued call's cancellation when the live context signal changes", async () => {
    const harness = setup();
    const controller = new AbortController();
    let resolveFirst: (value: boolean) => void = () => {};
    harness.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = harness.call("git push", "bash", undefined, true);
    harness.context.signal = controller.signal;
    const second = harness.call("git reset", "bash", undefined, true);
    controller.abort();
    harness.context.signal = undefined;
    await Promise.resolve();
    resolveFirst(true);
    expect(await first).toBeUndefined();
    expect(await second).toMatchObject({ block: true, reason: "Terminal execution cancelled" });
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent approval dialogs", async () => {
    const harness = setup();
    let resolveFirst: (value: boolean) => void = () => {};
    harness.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = harness.call("git push", "bash", undefined, true);
    const second = harness.call("git reset", "bash", undefined, true);
    await Promise.resolve();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    resolveFirst(true);
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(harness.confirm).toHaveBeenCalledTimes(2);
  });
});

describe("native shell tool contract", () => {
  test.each(["bash", "powershell"])(
    "preserves native %s rendering and shortens approval guidance",
    (shell) => {
      const tool = setup().tools.get(shell);
      expect(tool?.parameters).toMatchObject({
        required: expect.arrayContaining(["command", "requires_approval"]),
        properties: { requires_approval: { type: "boolean" } },
      });
      expect(tool?.defaultActive).toBe(false);
      expect(tool?.prepareArguments).toBeUndefined();
      expect(tool?.renderCall).toBeFunction();
      expect(tool?.renderResult).toBeFunction();
      expect(tool?.description).toContain("false for routine local work");
      expect(tool?.description).toContain("Ignored in YOLO mode");
      expect(tool?.description).not.toContain("When uncertain");
      expect(tool?.description).not.toContain("--no-ext-diff");
    },
  );

  test("executes bash in the invocation cwd with configured shell settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axon-terminal-execute-"));
    try {
      const harness = setup();
      harness.settings.shellPath = "/bin/bash";
      harness.settings.shellCommandPrefix = "export AXON_PREFIX=configured";
      const result = await harness.tools
        .get("bash")
        ?.execute(
          "terminal-call",
          { command: 'printf "%s|%s|%s" "$PWD" "$AXON_PREFIX" "$BASH"', requires_approval: false },
          undefined,
          undefined,
          {
            ...harness.context,
            cwd: directory,
            sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined },
          } as unknown as ExtensionToolContext,
        );
      const output = result?.content.map((part) => ("text" in part ? part.text : "")).join("");
      expect(output).toBe(`${await realpath(directory)}|configured|/bin/bash`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("terminal permissions load standalone in the pinned native Pi runtime", async () => {
  const projectRoot = resolve(import.meta.dir, "..");
  const home = await mkdtemp(join(tmpdir(), "axon-terminal-permissions-"));
  try {
    const child = Bun.spawn(
      [
        join(projectRoot, "node_modules", ".bin", "pi"),
        "--offline",
        "--no-extensions",
        "--extension",
        join(projectRoot, "src/harnesses/pi/resources/extensions/terminal-permissions.mjs"),
        "--list-models",
      ],
      {
        cwd: home,
        env: {
          HOME: home,
          PATH: process.env["PATH"] ?? "",
          PI_CODING_AGENT_DIR: join(home, "pi"),
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
