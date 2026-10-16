import { homedir } from "node:os";
import { join } from "node:path";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { type CommandWords, parseCommands } from "../../terminal-permissions/command-parser.ts";
import { classifyInspectionCommand } from "../../terminal-permissions/inspection-commands.ts";

/**
 * Permission guard for native bash, nested codemode calls, powershell, and !/!!.
 * Lists contain literal command prefixes, not regexes/globs. Rules are compared
 * as words: "git status" never grants "git reset". Each pipeline/chain segment
 * is checked independently. Inspection profiles verify arguments before automatic
 * approval; prefix lists cannot waive unsafe flags or unknown programs. The LLM
 * must supply requires_approval, which can request review but never waive it.
 * This is an approval guard, not an OS sandbox:
 * allowed programs/scripts can perform arbitrary work, as can other extensions.
 *
 * PI_TERMINAL_YOLO_MODE=true auto-approves supported commands except restrictions.
 * PI_TERMINAL_AUTO_APPROVE_COMMANDS='["ls","git status"]'
 * PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS='["rm","sudo"]'
 * PI_TERMINAL_BLOCKED_COMMANDS='["git reset --hard"]'
 * PI_TERMINAL_APPROVAL_TIMEOUT_MS=60000
 * PI_TERMINAL_MANAGED_CONFIG is reserved for the Axon launcher's backend policy.
 */
// Keep this bus contract in sync with axon.ts; both extensions ship standalone.
export const TERMINAL_HEADER_CHANNEL = "axon:terminal-status";
type TerminalHeaderState = "approval" | "yolo" | "blocked";

interface CommandPrefix {
  readonly text: string;
  readonly words: CommandWords;
}

interface TerminalConfig {
  readonly yoloMode: boolean;
  readonly allowYoloMode: boolean;
  readonly autoApproveCommands: readonly CommandPrefix[];
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
  inspection_command: "Verified inspection command and arguments",
  inspection_review: "Command or arguments are not a verified inspection operation",
  yolo_mode: "YOLO mode",
  auto_approval: "Auto-approval prefix and verified inspection arguments",
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

function environmentBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean`);
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
    "allowYoloMode",
    "autoApproveCommands",
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
  const allowYoloMode =
    managed === undefined ? true : booleanSetting(policy["allowYoloMode"], "allowYoloMode");
  const yoloMode = managed === undefined ? false : booleanSetting(policy["yoloMode"], "yoloMode");
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
    // Local preferences cannot override an admin's YOLO prohibition.
    yoloMode: allowYoloMode && environmentBoolean("PI_TERMINAL_YOLO_MODE", yoloMode),
    allowYoloMode,
    autoApproveCommands: list("autoApproveCommands", "PI_TERMINAL_AUTO_APPROVE_COMMANDS"),
    requireApprovalCommands: list(
      "requireApprovalCommands",
      "PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS",
    ),
    blockedCommands: list("blockedCommands", "PI_TERMINAL_BLOCKED_COMMANDS"),
    approvalTimeoutMs: timeout,
  };
}

function matchesPrefix(words: CommandWords, rule: CommandPrefix, restrict: boolean): boolean {
  const matches = (candidate: CommandWords): boolean =>
    rule.words.every((word, index) => {
      const actual = candidate[index];
      // Restrictions catch executable paths without granting those paths implicitly.
      return actual === word || (restrict && index === 0 && actual?.split("/").at(-1) === word);
    });
  if (matches(words)) return true;
  if (!restrict || words[0]?.split("/").at(-1) !== "git") return false;
  // The inspection profile accepts these global options. They must not hide a
  // required/blocked Git subcommand behind a harmless presentation option.
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
  shell: string,
  config: TerminalConfig,
  yoloMode: boolean,
  cwd: string,
  requiresApproval: boolean,
  customShell: boolean,
): Decision {
  if (!command.trim() || hasControlCharacters(command, true)) {
    return { action: "block", reason: "invalid_command" };
  }
  const commands = shell === "bash" ? parseCommands(command) : undefined;
  if (commands === undefined) {
    // Do not let expansions, wrappers, or a different shell hide a blocked command.
    return config.blockedCommands.length > 0
      ? { action: "block", reason: "unverified_syntax" }
      : { action: "approve", reason: "shell_syntax" };
  }
  if (
    commands.some((words) =>
      config.blockedCommands.some((rule) => matchesPrefix(words, rule, true)),
    )
  ) {
    return { action: "block", reason: "blocked_command" };
  }
  if (commands.some((words) => SHELL_WRAPPERS.has(words[0]?.split("/").at(-1) ?? ""))) {
    return config.blockedCommands.length > 0
      ? {
          action: "block",
          reason: "unverified_wrapper",
        }
      : { action: "approve", reason: "shell_wrapper" };
  }
  if (
    commands.some((words) =>
      config.requireApprovalCommands.some((rule) => matchesPrefix(words, rule, true)),
    )
  ) {
    return { action: "approve", reason: "required_approval" };
  }
  if (requiresApproval) return { action: "approve", reason: "model_requested_approval" };
  if (customShell) return { action: "approve", reason: "shell_configuration" };
  if (yoloMode) return { action: "allow", reason: "yolo_mode" };
  if (commands.every((words) => classifyInspectionCommand(words, cwd) === "inspection")) {
    const matchesConfiguredPrefixes = commands.every((words) =>
      config.autoApproveCommands.some((rule) => matchesPrefix(words, rule, false)),
    );
    return {
      action: "allow",
      reason: matchesConfiguredPrefixes ? "auto_approval" : "inspection_command",
    };
  }
  // Prefixes are not proof of safety: git diff --output, find -exec, and even
  // unknown programs matching an old allow rule must still receive review.
  return { action: "approve", reason: "inspection_review" };
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
      "Always provide requires_approval. Set it to false only for inspection commands " +
      "with read-only arguments; set it to true for writes, deletion, installs, network " +
      "transfers, privilege changes, arbitrary code execution, or uncertainty. " +
      "The runtime independently checks safety; false never bypasses permission rules.";
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
              "Whether the model believes this command needs explicit user approval. When uncertain, use true.",
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
  let yoloOverride: boolean | undefined;
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
  const updateStatus = (config: TerminalConfig): void => {
    const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
    publishStatus(yoloMode ? "yolo" : "approval");
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
    const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
    const decision = decide(
      effectiveCommand,
      shell,
      config,
      yoloMode,
      cwd,
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
    yoloOverride = undefined;
    autoSelectedDecisionSampleIndex = 0;
    try {
      const config = getConfig();
      updateStatus(config);
      emit("policy", "success", { yoloMode: config.yoloMode });
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

  pi.registerCommand("terminal-permissions", {
    description: "Inspect terminal permissions or set YOLO mode: status | yolo on | yolo off",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      const startedAt = Date.now();
      let config: TerminalConfig;
      try {
        config = getConfig();
      } catch {
        emit("policy", "failed", {
          reason: "invalid_config",
          durationMs: Date.now() - startedAt,
        });
        ctx.ui.notify(
          "Invalid terminal permission configuration; terminal execution is blocked.",
          "error",
        );
        return;
      }

      if (action === "yolo off") {
        yoloOverride = false;
        emit("yolo", "success", { reason: "yolo_disabled", yoloMode: false });
      } else if (action === "yolo on") {
        const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
        if (!config.allowYoloMode) {
          emit("yolo", "blocked", { reason: "policy_disabled", yoloMode });
          ctx.ui.notify("YOLO mode is disabled by the managed terminal policy.", "warning");
          return;
        }
        if (!ctx.hasUI) {
          emit("yolo", "blocked", { reason: "approval_unavailable", yoloMode });
          return;
        }
        const signal = ctx.signal;
        emit("yolo", "pending", { reason: "yolo_enabled", yoloMode });
        let approved: boolean;
        try {
          approved = await ctx.ui.confirm(
            "Enable YOLO mode?",
            "Supported terminal commands will run without approval. Required-approval and blocked commands still apply.",
            {
              timeout: config.approvalTimeoutMs,
              ...(signal === undefined ? {} : { signal }),
            },
          );
        } catch {
          emit("yolo", "failed", {
            reason: "approval_failed",
            yoloMode,
            durationMs: Date.now() - startedAt,
          });
          ctx.ui.notify("Terminal approval failed; YOLO mode was not changed.", "error");
          return;
        }
        if (approved !== true || signal?.aborted) {
          emit("yolo", signal?.aborted ? "cancelled" : "dismissed", {
            reason: signal?.aborted ? "cancelled" : "not_approved",
            yoloMode,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        yoloOverride = true;
        emit("yolo", "success", {
          reason: "yolo_enabled",
          yoloMode: true,
          durationMs: Date.now() - startedAt,
        });
      } else if (action !== "" && action !== "status") {
        ctx.ui.notify("Usage: /terminal-permissions [status | yolo on | yolo off]", "warning");
        return;
      }
      updateStatus(config);
      const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
      const yoloLabel = `${yoloMode ? "on" : "off"}${config.allowYoloMode ? "" : " (disabled by policy)"}`;
      ctx.ui.notify(
        [
          `YOLO: ${yoloLabel}`,
          "Inspection profiles: on (read-only arguments and workspace file operands)",
          `Auto-approve: ${config.autoApproveCommands.map((rule) => rule.text).join(", ") || "none"} (inspection-only)`,
          `Require approval: ${config.requireApprovalCommands.map((rule) => rule.text).join(", ") || "none"}`,
          `Blocked: ${config.blockedCommands.map((rule) => rule.text).join(", ") || "none"}`,
          `Approval timeout: ${config.approvalTimeoutMs / 1000}s`,
          "Unknown commands and unsafe arguments require approval unless YOLO is on.",
          "Model requires_approval=true always requests review; false never grants permission.",
          "Lists use literal prefixes; complex syntax and wrappers require review.",
        ].join("\n"),
        "info",
      );
    },
  });
}
