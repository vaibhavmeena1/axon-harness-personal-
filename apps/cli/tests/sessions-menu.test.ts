import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type autocomplete, CANCEL_SYMBOL, isCancel } from "@clack/prompts";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import type { SessionOperation, SessionOptions } from "../src/cli/commands/sessions.ts";
import { runSessionMenu, type SessionMenuUI } from "../src/cli/commands/sessions-menu.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";
import type { RemoteSession } from "../src/sessions/contracts.ts";
import { formatLocalBackupTime } from "../src/sessions/display.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "axon-session-menu-"));
  await mkdir(join(directory, "checkout"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const sessionId = "8ea530c5-d5c4-4d13-9628-72d5adfe1c48";
function remote(id = sessionId, title = 'Fix "login" flow'): RemoteSession {
  return {
    id,
    display_name: title,
    harness: "pi",
    harness_session_id: "native-session",
    session_format: "pi-jsonl",
    device_id: "3c302aa4-39dc-4f52-9564-d08cf05f52d3",
    client_session_key: "d7d38526-1a6f-4365-8964-cbfe0369e242",
    update_token: sessionId,
    last_backup_at: "2026-10-08T21:05:04Z",
    updated_at: "2026-10-08T21:05:04Z",
    snapshot: null,
  };
}

type StringPicker = Parameters<typeof autocomplete<string>>[0];

function harness(answers: readonly (string | boolean | symbol)[], sessions = [remote()]) {
  const remaining = [...answers];
  const events: string[] = [];
  const commands: {
    operation: SessionOperation;
    id: string | undefined;
    options: SessionOptions;
  }[] = [];
  const mutations: string[] = [];
  const validationErrors: (string | Error)[] = [];
  let picker: StringPicker | undefined;
  let checkout: Parameters<SessionMenuUI["text"]>[0] | undefined;
  let listCalls = 0;
  function answer() {
    const next = remaining.shift();
    if (next === undefined) throw new Error("Unexpected prompt");
    return next;
  }
  const ui: SessionMenuUI = {
    select: (async (settings) => {
      events.push(`menu:${settings.message}`);
      return answer();
    }) as SessionMenuUI["select"],
    autocomplete: (async (settings: StringPicker) => {
      events.push(`picker:${settings.message}`);
      picker = settings;
      return answer();
    }) as SessionMenuUI["autocomplete"],
    text: async (settings) => {
      events.push(`checkout:${settings.message}`);
      checkout = settings;
      while (true) {
        const value = answer();
        if (isCancel(value)) return value;
        if (typeof value !== "string") throw new Error("Expected checkout path");
        const error =
          typeof settings.validate === "function" ? await settings.validate(value) : undefined;
        if (!error) return value;
        validationErrors.push(error);
      }
    },
    confirm: async (settings) => {
      events.push(`confirm:${settings.message}`);
      expect(settings.initialValue).toBe(false);
      const value = answer();
      if (typeof value !== "boolean" && !isCancel(value)) throw new Error("Expected confirmation");
      return value;
    },
    intro: (message) => {
      events.push(`intro:${message}`);
    },
    outro: (message) => {
      events.push(`outro:${message}`);
    },
    cancel: (message) => {
      events.push(`cancel:${message}`);
    },
    note: (message, title) => {
      events.push(`note:${title}:${message}`);
    },
    spinner: (() => ({
      start() {},
      stop() {},
      cancel() {},
      error() {},
      message() {},
      clear() {},
      isCancelled: false,
    })) as SessionMenuUI["spinner"],
  };
  const services = {
    list: async () => {
      listCalls++;
      return sessions;
    },
    run: async (operation: SessionOperation, id?: string, options: SessionOptions = {}) => {
      events.push(`run:${operation}`);
      commands.push({ operation, id, options });
      if (operation === "restore" || operation === "delete") {
        if (!options.ui) throw new Error("Missing shared confirmation");
        const accepted = await options.ui.confirm({
          message: `${operation} latest backup?`,
          initialValue: false,
        });
        if (isCancel(accepted) || !accepted) return;
        mutations.push(operation);
      }
    },
  };
  return {
    ui,
    services,
    events,
    commands,
    mutations,
    validationErrors,
    get picker() {
      return picker;
    },
    get checkout() {
      return checkout;
    },
    get listCalls() {
      return listCalls;
    },
  };
}

async function run(menu: ReturnType<typeof harness>) {
  await runSessionMenu(menu.services, { ui: menu.ui, cwd: directory, columns: 80 });
}

describe("interactive session management", () => {
  test("guides restore through session selection, an existing checkout, and latest-snapshot confirmation", async () => {
    const checkout = join(directory, "checkout");
    const menu = harness(["restore", sessionId, checkout, true, "exit"]);
    await run(menu);
    expect(menu.commands).toHaveLength(1);
    expect(menu.commands[0]?.operation).toBe("restore");
    expect(menu.commands[0]?.id).toBe(sessionId);
    expect(menu.commands[0]?.options.cwd).toBe(checkout);
    expect(menu.commands[0]?.options.yes).toBeUndefined();
    expect(menu.mutations).toEqual(["restore"]);
    expect(menu.checkout?.defaultValue).toBe(directory);
    expect(menu.events.at(-1)).toBe("outro:Done.");
  });

  test("rejects nonexistent and file paths inline, resolves relative paths, and permits the default cwd", async () => {
    await writeFile(join(directory, "file"), "synthetic");
    const menu = harness([
      "restore",
      sessionId,
      "missing",
      "file",
      "checkout",
      true,
      "restore",
      sessionId,
      "",
      false,
      "exit",
    ]);
    await run(menu);
    expect(menu.validationErrors).toHaveLength(2);
    expect(menu.commands[0]?.options.cwd).toBe(join(directory, "checkout"));
    expect(menu.commands[1]?.options.cwd).toBe(directory);
    expect(menu.mutations).toEqual(["restore"]);
  });

  test("deletes only the picked backup after explicit confirmation and does not ask for a checkout", async () => {
    const menu = harness(["delete", sessionId, true, "exit"]);
    await run(menu);
    expect(menu.commands[0]?.operation).toBe("delete");
    expect(menu.commands[0]?.id).toBe(sessionId);
    expect(menu.commands[0]?.options.cwd).toBeUndefined();
    expect(menu.commands[0]?.options.yes).toBeUndefined();
    expect(menu.checkout).toBeUndefined();
    expect(menu.mutations).toEqual(["delete"]);
  });

  test("declining a destructive action returns to the menu without mutation", async () => {
    const menu = harness(["delete", sessionId, false, "exit"]);
    await run(menu);
    expect(menu.mutations).toEqual([]);
    expect(menu.events.at(-1)).toBe("outro:Done.");
  });

  test("status and retry reuse existing commands without fetching a remote list", async () => {
    const menu = harness(["status", "retry", "exit"]);
    await run(menu);
    expect(menu.commands.map(({ operation }) => operation)).toEqual(["status", "retry"]);
    expect(menu.listCalls).toBe(0);
    expect(menu.mutations).toEqual([]);
  });

  test("an empty list has guidance and returns to the menu", async () => {
    const menu = harness(["restore", "exit"], []);
    await run(menu);
    expect(menu.picker).toBeUndefined();
    expect(menu.commands).toEqual([]);
    expect(menu.events.some((event) => event.includes("No backups yet"))).toBe(true);
  });

  test("the picker can return to the main menu without starting an operation", async () => {
    const menu = harness(["restore", "back", "exit"]);
    await run(menu);
    expect(menu.commands).toEqual([]);
    expect(menu.checkout).toBeUndefined();
  });

  test("the searchable picker distinguishes duplicate titles and searches full, untruncated titles and IDs", async () => {
    const secondId = "3c302aa4-39dc-4f52-9564-d08cf05f52d3";
    const title = `${"long title ".repeat(15)}needle`;
    const menu = harness(
      ["restore", "back", "exit"],
      [remote(sessionId, title), remote(secondId, title)],
    );
    await run(menu);
    const options = menu.picker?.options;
    if (!Array.isArray(options) || !menu.picker?.filter)
      throw new Error("Missing searchable picker");
    expect(options).toHaveLength(3);
    expect(options[0]?.label).toEndWith("…");
    expect(options[0]?.hint).toContain(sessionId.slice(0, 8));
    expect(options[1]?.hint).toContain(secondId.slice(0, 8));
    expect(options[0]?.hint).toContain(formatLocalBackupTime(remote().last_backup_at));
    expect(options[0]?.hint).not.toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const first = options[0];
    const second = options[1];
    const back = options[2];
    if (!first || !second || !back) throw new Error("Missing options");
    expect(menu.picker.filter("NEEDLE", first)).toBe(true);
    expect(menu.picker.filter(secondId, second)).toBe(true);
    expect(menu.picker.filter(secondId, first)).toBe(false);
    expect(menu.picker.filter("no match", back)).toBe(true);
  });

  test.each([
    { stage: "main menu", answers: [CANCEL_SYMBOL] },
    { stage: "session picker", answers: ["restore", CANCEL_SYMBOL] },
    { stage: "checkout prompt", answers: ["restore", sessionId, CANCEL_SYMBOL] },
    { stage: "restore confirmation", answers: ["restore", sessionId, "", CANCEL_SYMBOL] },
    { stage: "delete confirmation", answers: ["delete", sessionId, CANCEL_SYMBOL] },
  ])("cancelling at $stage exits safely", async ({ answers }) => {
    const menu = harness(answers);
    await run(menu);
    expect(menu.mutations).toEqual([]);
    expect(menu.events.at(-1)).toBe("cancel:Session management cancelled.");
    expect(menu.events.some((event) => event.startsWith("outro:"))).toBe(false);
  });

  test("backend errors propagate without claiming success or starting a mutation", async () => {
    const menu = harness(["restore"]);
    menu.services.list = async () => {
      throw new Error("synthetic backend failure");
    };
    await expect(run(menu)).rejects.toThrow("synthetic backend failure");
    expect(menu.commands).toEqual([]);
    expect(menu.events.some((event) => event.startsWith("outro:"))).toBe(false);
  });
});

async function cli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "../src/index.ts"), ...args],
    {
      env: {
        ...process.env,
        AXON_HOME: join(directory, "home"),
        HOME: directory,
        AXON_SERVICE_ORIGIN: "http://127.0.0.1:1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, status };
}

test("bare sessions rejects a non-TTY before login or filesystem work, while help remains available", async () => {
  const result = await cli(["sessions"]);
  expect(result.status).toBe(120);
  expect(result.stderr).toContain("Interactive session management requires a terminal");
  expect(result.stderr).toContain("sessions list/status/retry/restore/delete");
  expect(await Bun.file(join(directory, "home")).exists()).toBe(false);
  const help = await cli(["sessions", "--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("interactively");
  expect(help.stdout).toContain("restore");
  expect(help.stderr).toBe("");
});

test("bare sessions is wired to the guided menu in an interactive terminal", async () => {
  await saveEncryptedSession(
    resolveAxonPaths({ AXON_HOME: directory, HOME: directory }),
    "synthetic-token",
  );
  const script = `
    import { mock } from "bun:test";
    const clack = await import("@clack/prompts");
    const events = [];
    mock.module("@clack/prompts", () => ({ ...clack,
      intro: (message) => events.push(message),
      select: async ({ message }) => { events.push(message); return "exit"; },
      outro: (message) => events.push(message),
    }));
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    const { runLauncherProgram } = await import("./src/cli/launcher-program.ts");
    await runLauncherProgram(["sessions"]);
    console.log(JSON.stringify(events));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, AXON_HOME: directory, HOME: directory, CI: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual(["Axon sessions", "What would you like to do?", "Done."]);
});

test.each([false, true])(
  "guided deletion uses the real owned-session API and respects confirmation: %s",
  async (accepted) => {
    await saveEncryptedSession(
      resolveAxonPaths({ AXON_HOME: directory, HOME: directory }),
      "synthetic-token",
    );
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path.endsWith("/status"))
          return Response.json({ enabled: true, owner_user_team_id: "1" });
        if (path === "/api/v1/sessions") return Response.json({ sessions: [remote()], next: null });
        if (request.method === "DELETE" && path === `/api/v1/sessions/${sessionId}`)
          return new Response(null, { status: 204 });
        return new Response(null, { status: 404 });
      },
    });
    try {
      const script = `
      import { mock } from "bun:test";
      const clack = await import("@clack/prompts");
      const answers = ${JSON.stringify(["delete", sessionId, accepted, "exit"])};
      const events = [];
      const progress = { start() {}, stop() {}, error() {} };
      mock.module("@clack/prompts", () => ({ ...clack,
        intro() {}, outro() {}, note() {}, spinner: () => progress,
        select: async () => answers.shift(),
        autocomplete: async () => answers.shift(),
        confirm: async (settings) => { events.push({ kind: "confirm", default: settings.initialValue }); return answers.shift(); },
      }));
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      const { runLauncherProgram } = await import("./src/cli/launcher-program.ts");
      await runLauncherProgram(["sessions"]);
      console.log("EVENTS:" + JSON.stringify(events));
    `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          AXON_HOME: directory,
          HOME: directory,
          AXON_SERVICE_ORIGIN: server.url.origin,
          CI: "false",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(status).toBe(0);
      expect(stderr).toBe("");
      const eventLine = stdout.split("\n").find((line) => line.startsWith("EVENTS:"));
      expect(JSON.parse(eventLine?.slice(7) ?? "null")).toEqual([
        { kind: "confirm", default: false },
      ]);
      expect(requests).toEqual([
        "GET /api/v1/sessions/status",
        "GET /api/v1/sessions",
        "GET /api/v1/sessions/status",
        ...(accepted ? [`DELETE /api/v1/sessions/${sessionId}`] : []),
      ]);
    } finally {
      server.stop(true);
    }
  },
);
