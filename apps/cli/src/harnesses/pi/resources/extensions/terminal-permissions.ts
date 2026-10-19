import { homedir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { type CommandWords, parseCommands } from "../../terminal-permissions/command-parser.ts";

/**
 * Standard auto-runs supported commands unless the model or policy requests review.
 * YOLO skips review, including for wrappers and complex shell syntax. Backend
 * yoloMode only grants eligibility; /yolo explicitly toggles it for this session.
 * Literal-prefix blocklists are best-effort, not an OS sandbox: scripts, wrappers,
 * and other extensions can perform arbitrary work.
 *
 * PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS='["rm","sudo"]'
 * PI_TERMINAL_BLOCKED_COMMANDS='["git reset --hard"]'
 * PI_TERMINAL_APPROVAL_TIMEOUT_MS=60000
 * PI_TERMINAL_MANAGED_CONFIG is reserved for the Axon launcher's backend policy.
 * Environment variables cannot grant eligibility or activate YOLO.
 */
// Keep this bus contract in sync with axon.ts; both extensions ship standalone.
export const TERMINAL_HEADER_CHANNEL = "axon:terminal-status";
type TerminalHeaderState = "standard" | "yolo" | "blocked";

interface CommandPrefix {
  readonly text: string;
  readonly words: CommandWords;
}

interface TerminalConfig {
  readonly yoloAvailable: boolean;
  readonly requireApprovalCommands: readonly CommandPrefix[];
  readonly blockedCommands: readonly CommandPrefix[];
  readonly approvalTimeoutMs: number;
}

const DECISION_REASONS = {
  invalid_command: "Invalid terminal command",
  blocked_command: "Command is on the terminal block list",
  unverified_syntax: "Cannot verify the block list for this shell syntax",
  shell_syntax: "Shell syntax requires explicit review",
  unverified_wrapper: "Cannot verify the block list behind a shell or command wrapper",
  shell_wrapper: "Shell or command wrapper requires explicit review",
  required_approval: "Command is on the required-approval list",
  model_requested_approval: "The model requested approval for this command",
  invalid_approval_intent: "Terminal tool calls must include a boolean requires_approval",
  shell_configuration: "A custom shell requires explicit review",
  standard_mode: "Standard mode",
  yolo_mode: "YOLO mode",
} as const;
type Decision = {
  readonly action: "allow" | "approve" | "block";
  readonly reason: keyof typeof DECISION_REASONS;
};
type TerminalShell = "bash" | "powershell";
type TerminalSource = "tool" | "nested_tool" | "user_bash";

const AUTO_SELECTED_DECISION_SAMPLE_INTERVAL = 100;
const MAX_QUEUED_APPROVALS = 32;
// These commands can execute other commands or callbacks that this grammar cannot verify.
const SHELL_WRAPPERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "sudo",
  "doas",
  "su",
  "runuser",
  "env",
  "command",
  "builtin",
  "exec",
  "eval",
  "source",
  ".",
  "trap",
  "bind",
  "fc",
  "mapfile",
  "readarray",
  "xargs",
  "nohup",
  "nice",
  "timeout",
  "setsid",
  "stdbuf",
  "ionice",
  "chrt",
  "taskset",
  "time",
]);

function hasControlCharacters(value: string, allowWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowWhitespace && (code === 9 || code === 10)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function commandList(value: unknown, name: string): readonly CommandPrefix[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${name} must be a list of at most 32 commands`);
  }
  return value.map((rule: unknown) => {
    if (
      typeof rule !== "string" ||
      !rule.trim() ||
      rule.length > 96 ||
      hasControlCharacters(rule)
    ) {
      throw new Error(`${name} must contain non-empty command prefixes of at most 96 characters`);
    }
    const parsed = parseCommands(rule);
    const words = parsed?.[0];
    if (parsed?.length !== 1 || words === undefined) {
      throw new Error(`${name} contains unsupported shell syntax`);
    }
    return { text: rule.trim(), words };
  });
}

function booleanSetting(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function readConfig(): TerminalConfig {
  const managed = process.env["PI_TERMINAL_MANAGED_CONFIG"];
  const value: unknown = managed === undefined ? {} : JSON.parse(managed);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid managed terminal config");
  }
  const policy = value as Record<string, unknown>;
  const supportedKeys = [
    "yoloMode",
    "requireApprovalCommands",
    "blockedCommands",
    "approvalTimeoutMs",
  ];
  if (Object.keys(policy).some((key) => !supportedKeys.includes(key))) {
    throw new Error("Unknown managed terminal config setting");
  }
  const list = (key: string, environmentName: string): readonly CommandPrefix[] => {
    const local = process.env[environmentName];
    const configured =
      managed === undefined ? (local === undefined ? [] : JSON.parse(local)) : policy[key];
    return commandList(configured, key);
  };
  const yoloAvailable =
    managed === undefined ? false : booleanSetting(policy["yoloMode"], "yoloMode");
  const timeout =
    managed === undefined
      ? Number(process.env["PI_TERMINAL_APPROVAL_TIMEOUT_MS"] ?? 60_000)
      : policy["approvalTimeoutMs"];
  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    timeout > 300_000
  ) {
    throw new Error(
      "Terminal approval timeout must be an integer between 1000 and 300000 milliseconds",
    );
  }
  return {
    yoloAvailable,
    requireApprovalCommands: list(
      "requireApprovalCommands",
      "PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS",
    ),
    blockedCommands: list("blockedCommands", "PI_TERMINAL_BLOCKED_COMMANDS"),
    approvalTimeoutMs: timeout,
  };
}

function matchesPrefix(words: CommandWords, rule: CommandPrefix): boolean {
  const matches = (candidate: CommandWords): boolean =>
    rule.words.every((word, index) => {
      const actual = candidate[index];
      // Restrictions catch executable paths without granting those paths implicitly.
      return actual === word || (index === 0 && actual?.split("/").at(-1) === word);
    });
  if (matches(words)) return true;
  if (words[0]?.split("/").at(-1) !== "git") return false;
  // Harmless Git global options must not hide a required/blocked subcommand.
  let subcommandIndex = 1;
  while (
    ["--no-pager", "--literal-pathspecs", "--no-optional-locks"].includes(
      words[subcommandIndex] ?? "",
    )
  ) {
    subcommandIndex += 1;
  }
  return matches([words[0], ...words.slice(subcommandIndex)]);
}

function decide(
  command: string,
  shell: TerminalShell,
  config: TerminalConfig,
  yoloMode: boolean,
  requiresApproval: boolean,
  customShell: boolean,
): Decision {
  if (!command.trim() || hasControlCharacters(command, true)) {
    return { action: "block", reason: "invalid_command" };
  }
  // Attempt literal matching for simple PowerShell commands too, but do not use
  // this Bash grammar to infer PowerShell safety in Standard mode.
  const commands = parseCommands(command);
  if (
    commands?.some((words) => config.blockedCommands.some((rule) => matchesPrefix(words, rule)))
  ) {
    return { action: "block", reason: "blocked_command" };
  }
  // YOLO deliberately allows unknown syntax and wrappers, even when blocked
  // work could be hidden behind them. This check is best-effort, not a sandbox.
  if (yoloMode) return { action: "allow", reason: "yolo_mode" };
  if (shell !== "bash" || commands === undefined) {
    return config.blockedCommands.length > 0
      ? { action: "block", reason: "unverified_syntax" }
      : { action: "approve", reason: "shell_syntax" };
  }
  if (commands.some((words) => SHELL_WRAPPERS.has(words[0]?.split("/").at(-1) ?? ""))) {
    return config.blockedCommands.length > 0
      ? { action: "block", reason: "unverified_wrapper" }
      : { action: "approve", reason: "shell_wrapper" };
  }
  if (
    commands.some((words) =>
      config.requireApprovalCommands.some((rule) => matchesPrefix(words, rule)),
    )
  ) {
    return { action: "approve", reason: "required_approval" };
  }
  if (requiresApproval) return { action: "approve", reason: "model_requested_approval" };
  if (customShell) return { action: "approve", reason: "shell_configuration" };
  return { action: "allow", reason: "standard_mode" };
}

/** Extend the native schema without replacing native rendering or execution semantics. */
function registerShellTools(pi: ExtensionAPI): void {
  for (const shell of ["bash", "powershell"] as const) {
    // Do not inherit a compatibility shim that could synthesize missing approval intent.
    const { prepareArguments: _nativePrepareArguments, ...nativeTool } =
      shell === "bash"
        ? createBashToolDefinition(process.cwd())
        : createPowerShellToolDefinition(process.cwd());
    const approvalGuideline =
      "Set requires_approval=true for destructive, privileged, or externally impactful commands; " +
      "false for routine local work, including reads, edits, builds, and tests. Ignored in YOLO mode.";
    pi.registerTool({
      ...nativeTool,
      // Preserve --tools/defaultTools choices, and never activate PowerShell on macOS.
      defaultActive: false,
      description: `${nativeTool.description}\n${approvalGuideline}`,
      promptGuidelines: [...(nativeTool.promptGuidelines ?? []), approvalGuideline],
      parameters: {
        ...nativeTool.parameters,
        properties: {
          ...nativeTool.parameters.properties,
          requires_approval: {
            type: "boolean" as const,
            description:
              "Request review in Standard mode; false for routine local work. Ignored in YOLO mode.",
          },
        },
        required: ["command", "requires_approval"] as const,
      },
      execute(toolCallId, parameters, signal, onUpdate, ctx) {
        const settings = pi.getSettings();
        const configuredPath = settings.shellPath;
        const shellPath = configuredPath?.startsWith("~/")
          ? join(homedir(), configuredPath.slice(2))
          : configuredPath;
        const executionTool =
          shell === "bash"
            ? createBashToolDefinition(ctx.cwd, {
                ...(shellPath ? { shellPath } : {}),
                ...(settings.shellCommandPrefix
                  ? { commandPrefix: settings.shellCommandPrefix }
                  : {}),
              })
            : nativeTool;
        return executionTool.execute(toolCallId, parameters, signal, onUpdate, ctx);
      },
    });
  }
}

export default function terminalPermissions(pi: ExtensionAPI): void {
  registerShellTools(pi);
  let yoloEnabled = false;
  let autoSelectedDecisionSampleIndex = 0;
  // Bound retained requests and serialize confirmation dialogs for concurrent codemode calls.
  const approvalQueue: (() => Promise<void>)[] = [];
  let approvalInProgress = false;
  const startNextApproval = (): void => {
    if (approvalInProgress) return;
    const nextApproval = approvalQueue.shift();
    if (nextApproval === undefined) return;
    approvalInProgress = true;
    const releaseApproval = (): void => {
      approvalInProgress = false;
      startNextApproval();
    };
    // Keep the dialog slot until confirm settles, even if its caller has already timed out.
    void nextApproval().then(releaseApproval, releaseApproval);
  };
  let configResult: { readonly config: TerminalConfig } | { readonly error: unknown } | undefined;
  const getConfig = (): TerminalConfig => {
    // Environment policy is fixed for this launch; session changes do not reload it.
    // Cache failures too so an invalid policy stays fail-closed without repeated parsing.
    if (configResult === undefined) {
      try {
        configResult = { config: readConfig() };
      } catch (error) {
        configResult = { error };
      }
    }
    if ("error" in configResult) throw configResult.error;
    return configResult.config;
  };
  // Standalone extensions use the shared bus, not launcher imports or another SDK.
  // Never include commands, cwd, policy lists, tool-call IDs, or exception text.
  const emit = (
    stage: "policy" | "decision" | "approval" | "yolo",
    outcome: string,
    details: Record<string, unknown> = {},
  ): void => {
    try {
      pi.events.emit("axon:telemetry", { category: "terminal", stage, outcome, ...details });
    } catch {
      /* Telemetry must never grant permission, prevent a denial, or fail execution. */
    }
  };
  const publishStatus = (state: TerminalHeaderState): void => {
    try {
      pi.events.emit(TERMINAL_HEADER_CHANNEL, state);
    } catch {
      /* Header rendering must never affect terminal permissions. */
    }
  };
  const updateStatus = (): void => {
    publishStatus(yoloEnabled ? "yolo" : "standard");
  };
  const authorize = async (
    command: unknown,
    shell: TerminalShell,
    cwd: string,
    ctx: ExtensionContext,
    source: TerminalSource,
    requiresApproval?: unknown,
  ): Promise<string | undefined> => {
    // Pi context getters are live; retain this call's signal while waiting in the queue.
    const signal = ctx.signal;
    const metadata = { terminalShell: shell, terminalSource: source };
    if (typeof command !== "string") {
      emit("decision", "blocked", { ...metadata, reason: "invalid_command" });
      return "Invalid terminal command";
    }
    let config: TerminalConfig;
    try {
      config = getConfig();
    } catch {
      emit("decision", "blocked", { ...metadata, reason: "invalid_config" });
      return "Terminal execution blocked: invalid permission configuration";
    }
    if (source !== "user_bash" && typeof requiresApproval !== "boolean") {
      emit("decision", "blocked", { ...metadata, reason: "invalid_approval_intent" });
      return DECISION_REASONS.invalid_approval_intent;
    }
    const settings = pi.getSettings();
    const prefix = shell === "bash" ? settings.shellCommandPrefix : undefined;
    const effectiveCommand = prefix ? `${prefix}\n${command}` : command;
    const customShell =
      shell === "bash" &&
      !!settings.shellPath &&
      !["/bin/bash", "/bin/sh"].includes(settings.shellPath);
    const yoloMode = config.yoloAvailable && yoloEnabled;
    const decision = decide(
      effectiveCommand,
      shell,
      config,
      yoloMode,
      requiresApproval === true,
      customShell,
    );
    if (decision.action === "allow") {
      // Keep the first auto-allowed decision, then one per 100 commands in this session.
      // Sample before the bus to avoid per-command sanitization, spans, and logs.
      if (autoSelectedDecisionSampleIndex === 0) {
        emit("decision", "auto_selected", { ...metadata, yoloMode, reason: decision.reason });
      }
      autoSelectedDecisionSampleIndex =
        (autoSelectedDecisionSampleIndex + 1) % AUTO_SELECTED_DECISION_SAMPLE_INTERVAL;
      return undefined;
    }
    const details = { ...metadata, yoloMode };
    const reason = DECISION_REASONS[decision.reason];
    emit("decision", decision.action === "block" ? "blocked" : "pending", {
      ...details,
      reason: decision.reason,
    });
    if (decision.action === "block") return reason;
    if (!ctx.hasUI) {
      emit("approval", "blocked", { ...details, reason: "approval_unavailable" });
      return `${reason}; explicit approval is unavailable in this mode`;
    }
    const queuedAt = Date.now();
    if (signal?.aborted) {
      emit("approval", "cancelled", { ...details, reason: "cancelled", durationMs: 0 });
      return "Terminal execution cancelled";
    }
    if (approvalQueue.length >= MAX_QUEUED_APPROVALS) {
      emit("approval", "blocked", { ...details, reason: "approval_unavailable", durationMs: 0 });
      return "Terminal approval queue is full; command was not executed";
    }
    const deadline = queuedAt + config.approvalTimeoutMs;
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (
        outcome: string,
        approvalReason: string,
        result: string | undefined,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        // Remove expired/cancelled waiters instead of retaining them behind the active dialog.
        const queueIndex = approvalQueue.indexOf(startApproval);
        if (queueIndex !== -1) approvalQueue.splice(queueIndex, 1);
        emit("approval", outcome, {
          ...details,
          reason: approvalReason,
          durationMs: Date.now() - queuedAt,
        });
        resolve(result);
      };
      const cancel = (): void => {
        finish("cancelled", "cancelled", "Terminal execution cancelled");
      };
      const expire = (): void => {
        finish(
          "dismissed",
          "not_approved",
          "Terminal approval timed out; command was not executed",
        );
      };
      // This timer covers queue wait as well as dialog time and settles the caller promptly.
      const timeout = setTimeout(expire, Math.max(0, deadline - Date.now()));
      const startApproval = async (): Promise<void> => {
        if (settled) return;
        if (signal?.aborted) {
          cancel();
          return;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          expire();
          return;
        }
        emit("approval", "pending", { ...details, reason: decision.reason });
        try {
          const approved = await ctx.ui.confirm(
            "Allow terminal command?",
            `${reason}\nWorking directory: ${cwd}\nShell: ${shell}\n\n${effectiveCommand}`,
            {
              timeout: remainingMs,
              ...(signal === undefined ? {} : { signal }),
            },
          );
          if (settled) return;
          if (signal?.aborted) {
            cancel();
          } else if (Date.now() >= deadline) {
            // A delayed timer or late UI response must never grant permission after expiry.
            expire();
          } else {
            // Pi returns false for denial, dismissal, and timeout; do not invent a specific cause.
            finish(
              approved === true ? "selected" : "dismissed",
              approved === true ? decision.reason : "not_approved",
              approved === true ? undefined : "Terminal command denied or approval cancelled",
            );
          }
        } catch {
          if (signal?.aborted) {
            cancel();
          } else {
            finish(
              "failed",
              "approval_failed",
              "Terminal approval failed; command was not executed",
            );
          }
        }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      approvalQueue.push(startApproval);
      startNextApproval();
    });
  };

  pi.on("session_start", (_event, ctx) => {
    yoloEnabled = false;
    autoSelectedDecisionSampleIndex = 0;
    try {
      getConfig();
      updateStatus();
      emit("policy", "success", { yoloMode: false });
    } catch {
      publishStatus("blocked");
      emit("policy", "failed", { reason: "invalid_config" });
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Invalid terminal permission configuration; terminal execution is blocked.",
          "error",
        );
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
    const reason = await authorize(
      event.input["command"],
      event.toolName,
      ctx.cwd,
      ctx,
      event.parentToolCallId ? "nested_tool" : "tool",
      "requires_approval" in event.input ? event.input["requires_approval"] : undefined,
    );
    return reason === undefined ? undefined : { block: true, reason };
  });

  pi.on("user_bash", async (event, ctx) => {
    const reason = await authorize(event.command, "bash", event.cwd, ctx, "user_bash");
    // Throwing blocks user-bash instead of falling through to Pi's native execution.
    if (reason !== undefined) throw new Error(reason);
    return undefined;
  });

  pi.on("session_shutdown", () => {
    yoloEnabled = false;
  });

  pi.registerCommand("yolo", {
    description: "Toggle fully autonomous terminal execution for this session (if backend permits)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /yolo (toggles on/off for this session)", "warning");
        return;
      }
      let config: TerminalConfig;
      try {
        config = getConfig();
      } catch {
        emit("policy", "failed", { reason: "invalid_config" });
        ctx.ui.notify(
          "Invalid terminal permission configuration; terminal execution is blocked.",
          "error",
        );
        return;
      }
      if (!yoloEnabled && !config.yoloAvailable) {
        emit("yolo", "blocked", { reason: "policy_disabled", yoloMode: false });
        ctx.ui.notify("YOLO is unavailable: backend policy does not permit it.", "warning");
        return;
      }
      if (!yoloEnabled && !ctx.hasUI) {
        emit("yolo", "blocked", { reason: "approval_unavailable", yoloMode: false });
        return;
      }
      if (ctx.signal?.aborted) return;
      yoloEnabled = !yoloEnabled;
      emit("yolo", "success", {
        reason: yoloEnabled ? "yolo_enabled" : "yolo_disabled",
        yoloMode: yoloEnabled,
      });
      updateStatus();
      ctx.ui.notify(
        yoloEnabled
          ? "YOLO on for this session: terminal commands run without approval. Blocklists are best-effort, not a sandbox. Run /yolo to turn off."
          : "YOLO off: Standard mode restored.",
        yoloEnabled ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("terminal-permissions", {
    description: "Show terminal mode, YOLO availability, and command restrictions",
    handler: async (_args, ctx) => {
      let config: TerminalConfig;
      try {
        config = getConfig();
      } catch {
        ctx.ui.notify(
          "Invalid terminal permission configuration; terminal execution is blocked.",
          "error",
        );
        return;
      }
      ctx.ui.notify(
        [
          `Mode: ${yoloEnabled ? "YOLO" : "Standard"}`,
          `YOLO available: ${config.yoloAvailable ? "yes — toggle with /yolo" : "no (backend policy)"}`,
          `Require approval (Standard only): ${config.requireApprovalCommands.map((rule) => rule.text).join(", ") || "none"}`,
          `Blocked (best-effort): ${config.blockedCommands.map((rule) => rule.text).join(", ") || "none"}`,
          `Approval timeout: ${config.approvalTimeoutMs / 1000}s`,
        ].join("\n"),
        "info",
      );
    },
  });
}
