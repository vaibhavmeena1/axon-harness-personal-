import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CheckpointPayload,
  createGitAiExtension,
  resolveGitAiBinary,
  runGitAiCommand,
} from "../src/harnesses/pi/resources/extensions/git-ai.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-git-ai-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Dependencies = NonNullable<Parameters<typeof createGitAiExtension>[0]>;
function fixture(overrides: Dependencies = {}) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const warnings: string[] = [];
  const commands: { args: readonly string[]; payload?: CheckpointPayload; timeout?: number }[] = [];
  const context = {
    cwd: root,
    hasUI: true,
    model: { id: "test-model", provider: "litellm" },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => join(root, "session.jsonl"),
    },
    ui: { notify: (message: string) => warnings.push(message) },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    },
  } as unknown as ExtensionAPI;
  createGitAiExtension({
    environment: { PI_CODING_AGENT_DIR: join(root, "managed-pi") },
    userHome: root,
    resolveBinary: async () => "/fake/git-ai",
    runCommand: async (_binary, args, input, timeout) => {
      commands.push({
        args,
        ...(input ? { payload: JSON.parse(input) } : {}),
        ...(timeout === undefined ? {} : { timeout }),
      });
      return true;
    },
    ...overrides,
  })(pi);
  return {
    context,
    warnings,
    commands,
    payloads: () => commands.flatMap((command) => (command.payload ? [command.payload] : [])),
    async emit(name: string, event: Record<string, unknown> = {}) {
      return await handlers.get(name)?.(event, context);
    },
    async call(
      toolName = "edit",
      id = "call-1",
      input: Record<string, unknown> = { path: "file.txt" },
    ) {
      return await handlers.get("tool_call")?.(
        { type: "tool_call", toolName, toolCallId: id, input },
        context,
      );
    },
    async result(id = "call-1", isError = false) {
      return await handlers.get("tool_result")?.(
        {
          type: "tool_result",
          toolName: "edit",
          toolCallId: id,
          input: {},
          content: [{ type: "text", text: "done" }],
          details: undefined,
          isError,
        },
        context,
      );
    },
  };
}

async function executable(path: string, content = "#!/bin/sh\nexit 0\n"): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("optional git-ai availability", () => {
  test("registration is inert; startup probes once even across session starts", async () => {
    const f = fixture();
    expect(f.commands).toHaveLength(0);
    await f.emit("session_start");
    await f.emit("session_start");
    expect(f.commands).toEqual([{ args: ["--version"], timeout: 2_000 }]);
  });

  test("missing binary warns once and never blocks tools or results", async () => {
    let resolutions = 0;
    const f = fixture({
      resolveBinary: async () => {
        resolutions++;
        return undefined;
      },
    });
    await f.emit("session_start");
    await f.call();
    await f.result();
    await f.call("bash", "bash-1", { command: "echo hello" });
    await f.emit("session_start");
    expect(resolutions).toBe(1);
    expect(f.commands).toHaveLength(0);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("Pi remains usable");
  });

  test("non-UI warnings use stderr, not protocol stdout", async () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    const stdout = spyOn(console, "log").mockImplementation(() => {});
    try {
      const f = fixture({ resolveBinary: async () => undefined });
      f.context.hasUI = false;
      await f.emit("session_start");
      await f.call();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  test("failed probe or throwing resolution disables tracking without rejecting", async () => {
    for (const dependencies of [
      { runCommand: async () => false },
      {
        resolveBinary: async () => {
          throw new Error("private diagnostics");
        },
      },
    ]) {
      const f = fixture(dependencies);
      await f.emit("session_start");
      await f.call();
      expect(f.warnings).toHaveLength(1);
      expect(f.payloads()).toHaveLength(0);
      expect(f.warnings[0]).not.toContain("private diagnostics");
    }
  });

  test("notification failures also fail open", async () => {
    const f = fixture({ resolveBinary: async () => undefined });
    f.context.ui.notify = () => {
      throw new Error("broken UI");
    };
    await f.emit("session_start");
    await f.call();
    expect(f.payloads()).toHaveLength(0);
  });

  test("discovers official install before PATH, including symlinks", async () => {
    const official = await executable(join(root, ".git-ai", "bin", "git-ai"));
    const other = await executable(join(root, "other-bin", "git-ai"));
    expect(await resolveGitAiBinary({ PATH: join(root, "other-bin") }, root)).toBe(official);
    await rm(official);
    await symlink(other, official);
    expect(await resolveGitAiBinary({}, root)).toBe(official);
    await rm(official);
    expect(await resolveGitAiBinary({ PATH: join(root, "other-bin") }, root)).toBe(other);
  });

  test("explicit overrides are authoritative; non-executable and relative paths are ignored", async () => {
    await executable(join(root, ".git-ai", "bin", "git-ai"));
    const override = await executable(join(root, "custom binary"));
    expect(await resolveGitAiBinary({ PI_AXON_GIT_AI_BIN: override }, root)).toBe(override);
    await chmod(override, 0o644);
    expect(await resolveGitAiBinary({ PI_AXON_GIT_AI_BIN: override }, root)).toBeUndefined();
    expect(await resolveGitAiBinary({ PI_AXON_GIT_AI_BIN: "git-ai" }, root)).toBeUndefined();
    expect(
      await resolveGitAiBinary({ PI_AXON_GIT_AI_BIN: join(root, "missing") }, root),
    ).toBeUndefined();
    expect(
      await resolveGitAiBinary({ PATH: ".:relative:" }, join(root, "no-install")),
    ).toBeUndefined();
  });
});

describe("Pi checkpoint protocol", () => {
  test("pairs file snapshots with canonical session/model metadata", async () => {
    const f = fixture();
    await writeFile(join(root, "file.txt"), "human text");
    await f.call();
    await writeFile(join(root, "file.txt"), "AI text");
    await f.result();
    const [before, after] = f.payloads();
    expect(before).toMatchObject({
      hook_event_name: "before_edit",
      session_id: "test-session",
      session_path: join(root, "session.jsonl"),
      cwd: root,
      model: "test-model",
      tool_name: "edit",
      tool_name_raw: "edit",
      tool_use_id: "call-1",
      will_edit_filepaths: [join(root, "file.txt")],
      dirty_files: { [join(root, "file.txt")]: "human text" },
      tool_input: { path: "file.txt" },
    });
    expect(after).toMatchObject({
      hook_event_name: "after_edit",
      edited_filepaths: [join(root, "file.txt")],
      dirty_files: { [join(root, "file.txt")]: "AI text" },
      tool_result: { content: [{ type: "text", text: "done" }] },
    });
    expect(after).not.toHaveProperty("will_edit_filepaths");
    expect(f.commands[1]?.args).toEqual(["checkpoint", "pi", "--hook-input", "stdin"]);
  });

  test("new writes snapshot an absent file as empty", async () => {
    const f = fixture();
    await f.call("write");
    expect(f.payloads()[0]?.dirty_files).toEqual({ [join(root, "file.txt")]: "" });
    await writeFile(join(root, "file.txt"), "new file");
    await f.result();
    expect(f.payloads()[1]?.tool_name).toBe("write");
  });

  test("nested codemode calls and reversed concurrent results pair by toolCallId", async () => {
    const f = fixture();
    await f.emit("tool_call", {
      toolName: "bash",
      toolCallId: "codemode/0",
      parentToolCallId: "codemode",
      input: { command: "echo one" },
    });
    await f.emit("tool_call", {
      toolName: "write",
      toolCallId: "codemode/1",
      parentToolCallId: "codemode",
      input: { path: "second.txt" },
    });
    await f.result("codemode/1");
    await f.result("codemode/0");
    expect(f.payloads().map((payload) => [payload.hook_event_name, payload.tool_use_id])).toEqual([
      ["before_command", "codemode/0"],
      ["before_edit", "codemode/1"],
      ["after_edit", "codemode/1"],
      ["after_command", "codemode/0"],
    ]);
    expect(f.payloads()[0]).not.toHaveProperty("dirty_files");
    expect(f.payloads()[3]).not.toHaveProperty("tool_input");
  });

  test("read-only tools, unknown tools, missing paths and ephemeral sessions are skipped", async () => {
    const f = fixture();
    await f.call("read");
    await f.call("custom_edit");
    await f.call("edit", "missing-path", {});
    f.context.sessionManager.getSessionFile = () => undefined;
    await f.call();
    await f.call("bash", "bash-1", { command: "echo hello" });
    expect(f.payloads()).toHaveLength(0);
  });

  test("failed tools and shutdown discard pending results", async () => {
    const f = fixture();
    await f.call();
    await f.result("call-1", true);
    await f.result();
    await f.call("write", "call-2");
    await f.emit("session_shutdown");
    await f.result("call-2");
    expect(f.payloads().map((payload) => payload.hook_event_name)).toEqual([
      "before_edit",
      "before_edit",
    ]);
  });

  test("a checkpoint failure or exception warns once and disables further calls", async () => {
    for (const throws of [false, true]) {
      let attempts = 0;
      const f = fixture({
        runCommand: async (_binary, args) => {
          if (args[0] === "--version") return true;
          attempts++;
          if (throws) throw new Error("private failure");
          return false;
        },
      });
      await f.call();
      await f.result();
      await f.call("bash");
      expect(attempts).toBe(1);
      expect(f.warnings).toHaveLength(1);
    }
  });

  test("managed override policies support custom paths, deduplication, and ignored tools", async () => {
    const directory = join(root, "managed-pi");
    await mkdir(directory);
    await writeFile(
      join(directory, "git-ai.override.json"),
      JSON.stringify({
        version: 1,
        tools: {
          custom_edit: { kind: "mutating", canonical: "replace", filepath_fields: ["files"] },
          write: { kind: "ignore" },
          malformed: { kind: "mutating", canonical: "bad", filepath_fields: ["path"] },
        },
      }),
    );
    const f = fixture();
    await f.call("custom_edit", "custom", { files: ["a.txt", "a.txt", "b.txt", null] });
    await f.result("custom");
    await f.call("write");
    await f.call("malformed");
    expect(f.payloads()).toHaveLength(2);
    expect(f.payloads()[0]).toMatchObject({
      tool_name: "replace",
      tool_name_raw: "custom_edit",
      will_edit_filepaths: [join(root, "a.txt"), join(root, "b.txt")],
    });
  });

  test("snapshot failures never block tools or produce unmatched after checkpoints", async () => {
    await mkdir(join(root, "file.txt"));
    const f = fixture();
    await f.call();
    await f.result();
    expect(f.warnings).toHaveLength(1);
    expect(f.payloads()).toHaveLength(0);
  });

  test("malformed override JSON leaves defaults intact", async () => {
    await mkdir(join(root, "managed-pi"));
    await writeFile(join(root, "managed-pi", "git-ai.override.json"), "not JSON");
    const f = fixture();
    await f.call();
    expect(f.payloads()).toHaveLength(1);
    expect(f.warnings).toHaveLength(0);
  });

  test("uses the real subprocess stdin protocol without invoking installed git-ai", async () => {
    const log = join(root, "payloads.jsonl");
    const script = join(root, "fake.js");
    await writeFile(
      script,
      `const fs = require('node:fs'); if (process.argv[2] !== '--version') fs.appendFileSync(${JSON.stringify(log)}, fs.readFileSync(0, 'utf8') + '\\n');`,
    );
    const binary = await executable(
      join(root, "fake-git-ai"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
    );
    const f = fixture({ resolveBinary: async () => binary, runCommand: runGitAiCommand });
    await f.call("write");
    await f.result();
    const payloads = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(payloads.map((payload) => payload.hook_event_name)).toEqual([
      "before_edit",
      "after_edit",
    ]);
    expect(f.warnings).toHaveLength(0);
  });
});

describe("native Pi loading", () => {
  test("loads the bundled TypeScript extension and starts RPC without git-ai", async () => {
    const cliRoot = join(import.meta.dir, "..");
    const child = Bun.spawn(
      [
        join(cliRoot, "node_modules", ".bin", "pi"),
        "--offline",
        "--no-extensions",
        "--extension",
        join(cliRoot, "src", "harnesses", "pi", "resources", "extensions", "git-ai.ts"),
        "--mode",
        "rpc",
        "--no-session",
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: process.env["PATH"] ?? "",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_SKIP_VERSION_CHECK: "1",
          PI_OFFLINE: "1",
          PI_AXON_GIT_AI_BIN: join(root, "missing-git-ai"),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    child.stdin.write(`${JSON.stringify({ type: "get_state", id: "state" })}\n`);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    // RPC has UI support: warnings must be valid protocol notifications, never raw text.
    const records = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.find((record) => record.type === "response")).toMatchObject({
      id: "state",
      success: true,
      command: "get_state",
    });
    const notification = records.find((record) => record.type === "extension_ui_request");
    expect(notification).toMatchObject({ method: "notify", notifyType: "warning" });
    expect(notification.message).toContain("git-ai tracking disabled: executable not found");
    expect(notification.message).toContain("Pi remains usable");
  });
});

describe("bounded subprocess execution", () => {
  test("missing executable and nonzero exits resolve false", async () => {
    expect(await runGitAiCommand(join(root, "missing"), [], "{}", 200)).toBe(false);
    expect(await runGitAiCommand("/bin/sh", ["-c", "exit 1"], undefined, 200)).toBe(false);
  });

  test("a hung process is killed and returns without waiting indefinitely", async () => {
    const start = performance.now();
    expect(
      await runGitAiCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        undefined,
        100,
      ),
    ).toBe(false);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  test("closed stdin cannot produce an unhandled EPIPE or hang", async () => {
    expect(
      await runGitAiCommand(
        "/bin/sh",
        ["-c", "exec 0<&-; exec sleep 10"],
        "x".repeat(1024 * 1024),
        200,
      ),
    ).toBe(false);
  });
});
