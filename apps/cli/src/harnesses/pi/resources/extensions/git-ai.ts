/**
 * Axon adapter for git-ai's Pi checkpoint protocol (v1.7.5).
 * Optional integration: never installs git-ai, changes PATH, or blocks a tool on failure.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;

type CanonicalTool = "edit" | "write" | "replace" | "rename" | "bash";
type ToolPolicy =
  | { kind: "ignore" }
  | { kind: "mutating"; canonical: CanonicalTool; filepath_fields: string[] };

export interface CheckpointPayload {
  hook_event_name: "before_edit" | "after_edit" | "before_command" | "after_command";
  session_id: string;
  session_path: string;
  cwd: string;
  model: string;
  tool_name: CanonicalTool;
  tool_name_raw: string;
  tool_use_id: string;
  will_edit_filepaths?: string[];
  edited_filepaths?: string[];
  dirty_files?: Record<string, string>;
  tool_input?: unknown;
  tool_result?: unknown;
}

/** An explicit override is authoritative; otherwise prefer the official install, then PATH. */
export async function resolveGitAiBinary(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): Promise<string | undefined> {
  const override = environment["PI_AXON_GIT_AI_BIN"]?.trim();
  const candidates = override
    ? [override]
    : [
        join(userHome, ".git-ai", "bin", "git-ai"),
        ...(environment["PATH"] ?? "")
          .split(delimiter)
          // Never discover executables through cwd or relative PATH entries.
          .filter((directory) => isAbsolute(directory))
          .map((directory) => join(directory, "git-ai")),
      ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing or inaccessible integrations are optional.
    }
  }
  return undefined;
}

/** No shell interpolation; bounded even if the child hangs or closes stdin early. */
export async function runGitAiCommand(
  executable: string,
  arguments_: readonly string[],
  input?: string,
  timeoutMs: number = CHECKPOINT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(executable, [...arguments_], { stdio: ["pipe", "ignore", "ignore"] });
      let settled = false;
      const finish = (success: boolean, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.destroy();
        if (kill) child.kill("SIGKILL");
        resolvePromise(success);
      };
      const timer = setTimeout(() => finish(false, true), timeoutMs);
      child.on("error", () => finish(false, true));
      // Do not wait on inherited pipes held open by a descendant after the child exits.
      child.on("exit", (code) => finish(code === 0));
      child.stdin.on("error", () => finish(false, true));
      child.stdin.end(input);
    } catch {
      resolvePromise(false);
    }
  });
}

function normalizePolicy(value: unknown): ToolPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] === "ignore") return { kind: "ignore" };
  const canonical = raw["canonical"];
  const fields = raw["filepath_fields"];
  if (
    raw["kind"] !== "mutating" ||
    !["edit", "write", "replace", "rename", "bash"].includes(String(canonical)) ||
    !Array.isArray(fields) ||
    !fields.every((field) => typeof field === "string" && field.trim().length > 0)
  )
    return undefined;
  return { kind: "mutating", canonical: canonical as CanonicalTool, filepath_fields: fields };
}

async function loadPolicies(agentDirectory: string): Promise<Map<string, ToolPolicy>> {
  const policies = new Map<string, ToolPolicy>([
    ["edit", { kind: "mutating", canonical: "edit", filepath_fields: ["path"] }],
    ["write", { kind: "mutating", canonical: "write", filepath_fields: ["path"] }],
  ]);
  try {
    const path = join(agentDirectory, "git-ai.override.json");
    if (!(await stat(path)).isFile()) return policies;
    const config = JSON.parse(
      await readFile(path, {
        encoding: "utf8",
        signal: AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
      }),
    );
    if (config?.version !== 1 || !config.tools || typeof config.tools !== "object") return policies;
    for (const [name, value] of Object.entries(config.tools)) {
      const policy = normalizePolicy(value);
      if (name.trim() && policy) policies.set(name, policy);
    }
  } catch {
    // Missing or malformed user overrides leave the built-in defaults intact.
  }
  return policies;
}

function filepathsFor(input: Record<string, unknown>, policy: ToolPolicy, cwd: string): string[] {
  if (policy.kind === "ignore") return [];
  const paths = policy.filepath_fields.flatMap((field) => {
    const value = input[field];
    return Array.isArray(value) ? value : [value];
  });
  return [
    ...new Set(
      paths
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => resolve(cwd, value)),
    ),
  ];
}

async function readDirtyFiles(filepaths: readonly string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    filepaths.map(async (filepath) => {
      try {
        // Never open FIFOs/devices: a checkpoint must not wait on an arbitrary stream.
        if (!(await stat(filepath)).isFile()) throw new Error("not a regular file");
        return [
          filepath,
          await readFile(filepath, {
            encoding: "utf8",
            signal: AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
          }),
        ] as const;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return [filepath, ""] as const;
        }
        throw error;
      }
    }),
  );
  return Object.fromEntries(entries);
}

interface Dependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly userHome?: string;
  readonly resolveBinary?: () => Promise<string | undefined>;
  readonly runCommand?: typeof runGitAiCommand;
}

export function createGitAiExtension(dependencies: Dependencies = {}) {
  return (pi: ExtensionAPI): void => {
    const environment = dependencies.environment ?? process.env;
    const userHome = dependencies.userHome ?? homedir();
    const runCommand = dependencies.runCommand ?? runGitAiCommand;
    const pending = new Map<string, { payload: CheckpointPayload; filepaths: string[] }>();
    let initialization: Promise<void> | undefined;
    let executable: string | undefined;
    let policies = new Map<string, ToolPolicy>();
    let disabled = false;
    let warned = false;

    function disable(ctx: ExtensionContext, message: string): void {
      disabled = true;
      pending.clear();
      if (warned) return;
      warned = true;
      const warning = `Axon: git-ai tracking disabled: ${message}. Pi remains usable. Install/fix git-ai and /reload to retry.`;
      try {
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
        else console.error(warning); // Keep JSON/RPC/print stdout clean.
      } catch {
        // Even a broken notification must never prevent a tool from executing.
      }
    }

    async function initialize(ctx: ExtensionContext): Promise<void> {
      initialization ??= (async () => {
        try {
          executable = await (dependencies.resolveBinary?.() ??
            resolveGitAiBinary(environment, userHome));
          if (!executable) {
            disable(ctx, "executable not found");
            return;
          }
          if (!(await runCommand(executable, ["--version"], undefined, PROBE_TIMEOUT_MS))) {
            disable(ctx, "executable unavailable or version check timed out");
            return;
          }
          policies = await loadPolicies(
            environment["PI_CODING_AGENT_DIR"] || join(userHome, ".pi", "agent"),
          );
        } catch {
          disable(ctx, "initialization failed");
        }
      })();
      await initialization;
    }

    async function checkpoint(ctx: ExtensionContext, payload: CheckpointPayload): Promise<boolean> {
      if (disabled || !executable) return false;
      const success = await runCommand(
        executable,
        ["checkpoint", "pi", "--hook-input", "stdin"],
        JSON.stringify(payload),
      );
      if (!success) disable(ctx, "checkpoint failed or exceeded the 5-second timeout");
      return success;
    }

    pi.on("session_start", async (_event, ctx) => {
      pending.clear();
      await initialize(ctx);
    });
    pi.on("session_shutdown", () => {
      pending.clear();
    });

    pi.on("tool_call", async (event, ctx) => {
      try {
        await initialize(ctx);
        if (disabled) return;
        const sessionPath = ctx.sessionManager.getSessionFile();
        if (!sessionPath) return; // Ephemeral sessions have no transcript for git-ai.
        const policy = policies.get(event.toolName);
        const isCommand = event.toolName === "bash";
        if (!isCommand && (!policy || policy.kind === "ignore")) return;
        const filepaths = policy ? filepathsFor(event.input, policy, ctx.cwd) : [];
        if (!isCommand && filepaths.length === 0) return;
        const payload: CheckpointPayload = {
          hook_event_name: isCommand ? "before_command" : "before_edit",
          session_id: ctx.sessionManager.getSessionId(),
          session_path: sessionPath,
          cwd: ctx.cwd,
          model: ctx.model?.id ?? "",
          tool_name: isCommand
            ? "bash"
            : (policy as Extract<ToolPolicy, { kind: "mutating" }>).canonical,
          tool_name_raw: event.toolName,
          tool_use_id: event.toolCallId,
          ...(!isCommand
            ? {
                will_edit_filepaths: filepaths,
                dirty_files: await readDirtyFiles(filepaths),
                tool_input: event.input,
              }
            : {}),
        };
        if ((await checkpoint(ctx, payload)) && !disabled) {
          // Preserve identity/model for the paired result, including nested codemode calls.
          pending.set(event.toolCallId, { payload, filepaths });
        }
      } catch {
        disable(ctx, "could not capture the tool checkpoint");
      }
    });

    pi.on("tool_result", async (event, ctx) => {
      const call = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      if (!call || disabled || event.isError) return;
      try {
        const { will_edit_filepaths: _paths, dirty_files: _dirty, ...base } = call.payload;
        const isCommand = base.hook_event_name === "before_command";
        await checkpoint(ctx, {
          ...base,
          hook_event_name: isCommand ? "after_command" : "after_edit",
          ...(!isCommand
            ? {
                edited_filepaths: call.filepaths,
                dirty_files: await readDirtyFiles(call.filepaths),
                tool_result: { content: event.content, details: event.details },
              }
            : {}),
        });
      } catch {
        disable(ctx, "could not capture the tool result checkpoint");
      }
    });
  };
}

export default createGitAiExtension();
