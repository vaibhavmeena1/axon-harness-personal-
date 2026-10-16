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
  const settings: ReturnType<ExtensionAPI["getSettings"]> = {};
  let command: Command | undefined;
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
    registerCommand(name: string, registered: Command) {
      expect(name).toBe("terminal-permissions");
      command = registered;
    },
  } as unknown as ExtensionAPI);
  const toolHandler = handlers.get("tool_call") as ToolHandler;
  const userHandler = handlers.get("user_bash") as UserBashHandler;
  const sessionHandler = handlers.get("session_start") as SessionHandler;
  return {
    context,
    tools,
    settings,
    confirm,
    notify,
    setStatus,
    headerStates: () =>
      emit.mock.calls
        .filter(([channel]) => channel === TERMINAL_HEADER_CHANNEL)
        .map(([, state]) => state),
    call(
      commandText: string,
      toolName = "bash",
      parentToolCallId?: string,
      requiresApproval: unknown = false,
    ) {
      return toolHandler(
        {
          type: "tool_call",
          toolName,
          toolCallId: parentToolCallId ? `${parentToolCallId}/1` : "terminal-call",
          input: { command: commandText, requires_approval: requiresApproval },
          ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
        },
        context,
      );
    },
    userBash(commandText: string) {
      return userHandler(
        {
          type: "user_bash",
          command: commandText,
          cwd: context.cwd,
          excludeFromContext: false,
        },
        context,
      );
    },
    start() {
      sessionHandler({ type: "session_start" }, context);
    },
    async command(args: string) {
      if (!command) throw new Error("Terminal permission command was not registered");
      await command.handler(args, context as Parameters<Command["handler"]>[1]);
    },
  };
}

function managedPolicy(overrides: Record<string, unknown> = {}): void {
  process.env["PI_TERMINAL_MANAGED_CONFIG"] = JSON.stringify({
    yoloMode: false,
    allowYoloMode: true,
    autoApproveCommands: [],
    requireApprovalCommands: [],
    blockedCommands: [],
    approvalTimeoutMs: 60_000,
    ...overrides,
  });
}

describe("terminal approval defaults and command lists", () => {
  test("publishes approval mode for the header without adding footer status", () => {
    const harness = setup();
    harness.start();
    expect(harness.headerStates()).toEqual(["approval"]);
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("publishes configured YOLO mode even without a terminal UI", () => {
    process.env["PI_TERMINAL_YOLO_MODE"] = "true";
    const harness = setup(false);
    harness.start();
    expect(harness.headerStates()).toEqual(["yolo"]);
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("requires confirmation for mutations and shows the exact command and working directory", async () => {
    const harness = setup();
    expect(await harness.call("git push origin main")).toBeUndefined();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    expect(harness.confirm.mock.calls[0]?.[1]).toContain("git push origin main");
    expect(harness.confirm.mock.calls[0]?.[1]).toContain(harness.context.cwd);
    const dialogTimeout = harness.confirm.mock.calls[0]?.[2]?.timeout;
    expect(dialogTimeout).toBeGreaterThan(0);
    expect(dialogTimeout).toBeLessThanOrEqual(60_000);
  });

  test("refuses unapproved commands when no UI is available", async () => {
    const harness = setup(false);
    expect(await harness.call("git push")).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("does not intercept unrelated tools", async () => {
    const harness = setup(false);
    expect(await harness.call("irrelevant", "read")).toBeUndefined();
  });

  test("auto-approves every allowed segment in a chain or pipeline", async () => {
    process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] = '["git status","pwd","cat"]';
    const harness = setup(false);
    expect(await harness.call("git status --short && pwd | cat")).toBeUndefined();
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test.each(["git status-extra", "git reset --hard", "git status && rm file"])(
    "does not extend an auto-approval prefix to %s",
    async (command) => {
      process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] = '["git status"]';
      expect(await setup(false).call(command)).toMatchObject({ block: true });
    },
  );

  test("required approval wins over both the auto-approval list and YOLO", async () => {
    process.env["PI_TERMINAL_YOLO_MODE"] = "true";
    process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] = '["git"]';
    process.env["PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS"] = '["git push"]';
    const harness = setup();
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call("git push origin main")).toMatchObject({ block: true });
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  test.each(["rm file", "/bin/rm file", "r'm' file", "pwd && rm file"])(
    "hard blocks %s without offering approval",
    async (command) => {
      process.env["PI_TERMINAL_YOLO_MODE"] = "true";
      process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] = '["rm","pwd"]';
      process.env["PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS"] = '["rm"]';
      process.env["PI_TERMINAL_BLOCKED_COMMANDS"] = '["rm"]';
      const harness = setup();
      expect(await harness.call(command)).toMatchObject({ block: true });
      expect(harness.confirm).not.toHaveBeenCalled();
    },
  );

  test("allows supported headless commands in YOLO but not required-approval commands", async () => {
    process.env["PI_TERMINAL_YOLO_MODE"] = "true";
    process.env["PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS"] = '["git push"]';
    const harness = setup(false);
    expect(await harness.call("git status")).toBeUndefined();
    expect(await harness.call("git push")).toMatchObject({ block: true });
  });

  test.each(["echo $(pwd)", "echo `pwd`", "pwd > output", "env pwd", "bash -c 'pwd'"])(
    "never silently approves unsupported syntax or a wrapper: %s",
    async (command) => {
      process.env["PI_TERMINAL_YOLO_MODE"] = "true";
      expect(await setup(false).call(command)).toMatchObject({ block: true });
    },
  );

  test("does not let an approval rule bypass block-list uncertainty behind sudo", async () => {
    process.env["PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS"] = '["sudo"]';
    process.env["PI_TERMINAL_BLOCKED_COMMANDS"] = '["rm"]';
    const harness = setup();
    expect(await harness.call("sudo rm file")).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("requires review for PowerShell instead of applying Bash parsing", async () => {
    process.env["PI_TERMINAL_YOLO_MODE"] = "true";
    expect(await setup(false).call("Get-ChildItem", "powershell")).toMatchObject({ block: true });
  });

  test("applies the same restrictions to nested codemode calls and user-bash", async () => {
    process.env["PI_TERMINAL_BLOCKED_COMMANDS"] = '["rm"]';
    const harness = setup();
    expect(await harness.call("rm file", "bash", "codemode-call")).toMatchObject({ block: true });
    await expect(harness.userBash("rm file")).rejects.toThrow("block list");
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("allows approved user-bash commands to fall through to native Pi execution", async () => {
    expect(await setup().userBash("pwd")).toBeUndefined();
  });
});

describe("managed settings and session YOLO controls", () => {
  test("uses fetched lists instead of inherited local lists", async () => {
    managedPolicy({ autoApproveCommands: ["git status"], blockedCommands: ["rm"] });
    process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] = '["rm"]';
    const harness = setup(false);
    expect(await harness.call("git status")).toBeUndefined();
    expect(await harness.call("rm file")).toMatchObject({ block: true });
  });

  test("administrator YOLO prohibition wins over environment and session requests", async () => {
    managedPolicy({ yoloMode: true, allowYoloMode: false });
    process.env["PI_TERMINAL_YOLO_MODE"] = "true";
    const harness = setup();
    await harness.command("yolo on");
    expect(harness.confirm).not.toHaveBeenCalled();
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call("git push")).toMatchObject({ block: true });
  });

  test("local false opts out of a managed YOLO default", async () => {
    managedPolicy({ yoloMode: true });
    process.env["PI_TERMINAL_YOLO_MODE"] = "false";
    expect(await setup(false).call("git push")).toMatchObject({ block: true });
  });

  test("session YOLO requires confirmation, can be disabled, and resets on session start", async () => {
    const harness = setup();
    await harness.command("yolo on");
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    expect(await harness.call("git push")).toBeUndefined();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    await harness.command("yolo off");
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call("git push")).toMatchObject({ block: true });
    harness.confirm.mockResolvedValue(true);
    await harness.command("yolo on");
    harness.start();
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call("git push")).toMatchObject({ block: true });
    expect(harness.headerStates()).toEqual(["yolo", "approval", "yolo", "approval"]);
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("status includes lists and the approval timeout", async () => {
    managedPolicy({ autoApproveCommands: ["pwd"], approvalTimeoutMs: 10_000 });
    const harness = setup();
    await harness.command("status");
    expect(harness.notify.mock.calls[0]?.[0]).toContain("Auto-approve: pwd");
    expect(harness.notify.mock.calls[0]?.[0]).toContain("Approval timeout: 10s");
  });

  test.each([
    ["PI_TERMINAL_YOLO_MODE", "invalid"],
    ["PI_TERMINAL_AUTO_APPROVE_COMMANDS", "not-json"],
    ["PI_TERMINAL_AUTO_APPROVE_COMMANDS", '[" "]'],
    ["PI_TERMINAL_AUTO_APPROVE_COMMANDS", '["pwd && rm"]'],
    ["PI_TERMINAL_BLOCKED_COMMANDS", "[123]"],
    ["PI_TERMINAL_APPROVAL_TIMEOUT_MS", "0"],
    ["PI_TERMINAL_MANAGED_CONFIG", "{}"],
  ])("fails closed for invalid %s", async (name, value) => {
    process.env[name] = value;
    const harness = setup();
    harness.start();
    expect(harness.headerStates()).toEqual(["blocked"]);
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(await harness.call("pwd")).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("cancelled YOLO activation does not change the header mode", async () => {
    const harness = setup();
    harness.start();
    harness.confirm.mockResolvedValue(false);
    await harness.command("yolo on");
    expect(harness.headerStates()).toEqual(["approval"]);
    expect(harness.setStatus).not.toHaveBeenCalled();
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
    expect(await harness.call("git push")).toMatchObject({ block: true });
    expect(harness.confirm.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
  });

  test("a failed confirmation refuses the command and does not poison the next request", async () => {
    const harness = setup();
    harness.confirm.mockRejectedValueOnce(new Error("UI unavailable"));
    expect(await harness.call("git push")).toMatchObject({ block: true });
    expect(await harness.call("git push")).toBeUndefined();
  });

  test("retains a queued call's cancellation even when the live context signal changes", async () => {
    const harness = setup();
    const controller = new AbortController();
    let resolveFirst: (value: boolean) => void = () => {};
    harness.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = harness.call("git push");
    harness.context.signal = controller.signal;
    const second = harness.call("git reset");
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
    const first = harness.call("git push");
    const second = harness.call("git reset");
    await Promise.resolve();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    resolveFirst(true);
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(harness.confirm).toHaveBeenCalledTimes(2);
  });
});

describe("inspection profiles and model approval intent", () => {
  test.each(["bash", "powershell"])(
    "requires model approval intent in the %s schema without activating the tool",
    (shell) => {
      const tool = setup().tools.get(shell);
      expect(tool).toBeDefined();
      expect(tool?.parameters).toMatchObject({
        required: expect.arrayContaining(["command", "requires_approval"]),
        properties: { requires_approval: { type: "boolean" } },
      });
      expect(tool?.defaultActive).toBe(false);
      expect(tool?.renderCall).toBeFunction();
      expect(tool?.renderResult).toBeFunction();
    },
  );

  test("executes bash in the invocation cwd with configured shell settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "axon-terminal-execute-"));
    try {
      const harness = setup();
      harness.settings.shellPath = "/bin/bash";
      harness.settings.shellCommandPrefix = "export AXON_PREFIX=configured";
      const tool = harness.tools.get("bash");
      const result = await tool?.execute(
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

  test.each([
    "pwd",
    "git status --short",
    "git --no-pager log --oneline -n 5",
    "git diff --stat --no-ext-diff --no-textconv",
    "pwd && git status | head -n 20",
  ])(
    "automatically allows verified inspection with requires_approval=false: %s",
    async (command) => {
      const harness = setup(false);
      expect(await harness.call(command)).toBeUndefined();
      expect(harness.confirm).not.toHaveBeenCalled();
    },
  );

  test("honors model-requested approval even for inspection commands in YOLO", async () => {
    process.env["PI_TERMINAL_YOLO_MODE"] = "true";
    const harness = setup();
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call("pwd", "bash", undefined, true)).toMatchObject({ block: true });
    expect(harness.confirm.mock.calls[0]?.[1]).toContain("model requested approval");
  });

  test.each([null, "false", 0, {}])("blocks non-boolean approval intent: %j", async (intent) => {
    const harness = setup();
    expect(await harness.call("pwd", "bash", undefined, intent)).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test.each([
    "rm file",
    "git push",
    "git reset --hard",
    "git diff --output=result",
    "git diff --ext-diff",
    "git diff --stat",
    "git show HEAD",
    "git log --output=result",
    "git log --format --output=result",
    "git -c alias.read=status read",
    "git -C /tmp status",
    "rg --pre=helper pattern",
    "rg -L pattern",
    "find . -exec helper",
    "find . -delete",
    "sed -i 's/a/b/' file",
    "tail -f file",
    "python3 -c 'print(1)'",
    "unknown-command",
    "pwd && git push",
    "/bin/pwd",
    "git status > result",
  ])("false and broad prefix rules cannot waive review: %s", async (command) => {
    process.env["PI_TERMINAL_AUTO_APPROVE_COMMANDS"] =
      '["rm","git","rg","find","sed","tail","python3","unknown-command","pwd"]';
    const harness = setup();
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call(command)).toMatchObject({ block: true });
    expect(harness.confirm).toHaveBeenCalledTimes(1);
  });

  test("managed approval rules still override the built-in inspection profile", async () => {
    managedPolicy({ requireApprovalCommands: ["git status"] });
    expect(await setup(false).call("git status")).toMatchObject({ block: true });
    expect(await setup(false).call("git --no-pager status")).toMatchObject({ block: true });
  });

  test("supported Git global flags cannot bypass a blocked inspection subcommand", async () => {
    managedPolicy({ blockedCommands: ["git status"] });
    const harness = setup();
    expect(await harness.call("git --no-pager status")).toMatchObject({ block: true });
    expect(harness.confirm).not.toHaveBeenCalled();
  });

  test("checks nested inspection requests and user commands with the same profiles", async () => {
    const harness = setup(false);
    expect(await harness.call("git status", "bash", "codemode-parent")).toBeUndefined();
    expect(await harness.userBash("git status")).toBeUndefined();
    await expect(harness.userBash("git push")).rejects.toThrow("approval is unavailable");
  });

  test("checks configured command prefixes and shows the effective command", async () => {
    const harness = setup();
    harness.settings.shellCommandPrefix = "echo setup";
    harness.confirm.mockResolvedValue(false);
    expect(await harness.call("pwd")).toMatchObject({ block: true });
    expect(harness.confirm.mock.calls[0]?.[1]).toContain("echo setup\npwd");
    managedPolicy({ blockedCommands: ["rm"] });
    const blocked = setup();
    blocked.settings.shellCommandPrefix = "rm file";
    expect(await blocked.call("pwd")).toMatchObject({ block: true });
    expect(blocked.confirm).not.toHaveBeenCalled();
  });

  test("does not infer inspection safety for a custom shell", async () => {
    const harness = setup(false);
    harness.settings.shellPath = "/custom/bash";
    expect(await harness.call("pwd")).toMatchObject({ block: true });
  });
});

test("terminal permissions load as a standalone extension in the pinned native Pi runtime", async () => {
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
