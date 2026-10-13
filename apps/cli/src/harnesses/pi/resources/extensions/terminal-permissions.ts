import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Permission guard for native bash, nested codemode calls, powershell, and !/!!.
 * Lists contain literal command prefixes, not regexes/globs. Rules are compared
 * as words: "git status" never grants "git reset". Each pipeline/chain segment
 * is checked independently. This is an approval guard, not an OS sandbox:
 * allowed programs/scripts can perform arbitrary work, as can other extensions.
 *
 * PI_TERMINAL_YOLO_MODE=true auto-approves supported commands except restrictions.
 * PI_TERMINAL_AUTO_APPROVE_COMMANDS='["ls","git status"]'
 * PI_TERMINAL_REQUIRE_APPROVAL_COMMANDS='["rm","sudo"]'
 * PI_TERMINAL_BLOCKED_COMMANDS='["git reset --hard"]'
 * PI_TERMINAL_APPROVAL_TIMEOUT_MS=60000
 * PI_TERMINAL_MANAGED_CONFIG is reserved for the Axon launcher's backend policy.
 */
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
  yolo_mode: "YOLO mode",
  auto_approval: "Auto-approval list",
  unmatched_command: "Command is not auto-approved",
} as const;
type Decision = {
  readonly action: "allow" | "approve" | "block";
  readonly reason: keyof typeof DECISION_REASONS;
};
type TerminalShell = "bash" | "powershell";
type TerminalSource = "tool" | "nested_tool" | "user_bash";
type CommandWords = readonly string[];

const AUTO_SELECTED_DECISION_SAMPLE_INTERVAL = 100;

// Alphabetic Bash control words; time is handled as a command wrapper below.
const CONTROL_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "in",
  "coproc",
]);
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

/** Deliberately small grammar: never infer auto-approval for expansions or shell programs. */
function parseCommands(command: string): CommandWords[] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | undefined;
  const finishWord = () => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };
  const finishCommand = (): boolean => {
    finishWord();
    const executable = words[0];
    if (!executable || !/^[a-zA-Z0-9_./-]+$/.test(executable) || CONTROL_WORDS.has(executable)) {
      return false;
    }
    commands.push(words);
    words = [];
    return true;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) break;
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        if (quote === '"' && /[$`\\]/.test(character)) return undefined;
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
    } else if (character === " " || character === "\t") {
      finishWord();
    } else if (character === ";" || character === "\n" || character === "|" || character === "&") {
      if (character === "&" && command[index + 1] !== "&") return undefined;
      if (!finishCommand()) return undefined;
      if ((character === "&" || character === "|") && command[index + 1] === character) index += 1;
    } else {
      if (!/[a-zA-Z0-9_./:=,@%+-]/.test(character)) return undefined;
      wordStarted = true;
      word += character;
    }
  }
  if (quote !== undefined || !finishCommand()) return undefined;
  return commands;
}

/** Shared with the launcher so managed policies use the extension's exact grammar. */
export function isSingleCommandPrefix(command: string): boolean {
  const parsed = parseCommands(command);
  return parsed !== undefined && parsed.length === 1;
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
  return rule.words.every((word, index) => {
    const actual = words[index];
    // Restrictions also catch explicit executable paths, without granting those paths implicitly.
    return actual === word || (restrict && index === 0 && actual?.split("/").at(-1) === word);
  });
}

function decide(
  command: string,
  shell: string,
  config: TerminalConfig,
  yoloMode: boolean,
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
  if (
    yoloMode ||
    commands.every((words) =>
      config.autoApproveCommands.some((rule) => matchesPrefix(words, rule, false)),
    )
  ) {
    return { action: "allow", reason: yoloMode ? "yolo_mode" : "auto_approval" };
  }
  return { action: "approve", reason: "unmatched_command" };
}

export default function terminalPermissions(pi: ExtensionAPI): void {
  let yoloOverride: boolean | undefined;
  let autoSelectedDecisionSampleIndex = 0;
  // Serialize confirmation dialogs when codemode issues concurrent calls.
  let approvalQueue: Promise<void> = Promise.resolve();
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
  const updateStatus = (ctx: ExtensionContext, config: TerminalConfig) => {
    if (ctx.hasUI) {
      const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
      ctx.ui.setStatus("terminal-permissions", `Terminal: ${yoloMode ? "YOLO" : "approval"}`);
    }
  };
  const authorize = async (
    command: unknown,
    shell: TerminalShell,
    cwd: string,
    ctx: ExtensionContext,
    source: TerminalSource,
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
    const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
    const decision = decide(command, shell, config, yoloMode);
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
    const pending = approvalQueue.then(async () => {
      if (signal?.aborted) {
        emit("approval", "cancelled", {
          ...details,
          reason: "cancelled",
          durationMs: Date.now() - queuedAt,
        });
        return "Terminal execution cancelled";
      }
      emit("approval", "pending", { ...details, reason: decision.reason });
      try {
        const approved = await ctx.ui.confirm(
          "Allow terminal command?",
          `${reason}\nWorking directory: ${cwd}\nShell: ${shell}\n\n${command}`,
          {
            timeout: config.approvalTimeoutMs,
            ...(signal === undefined ? {} : { signal }),
          },
        );
        const allowed = approved === true && !signal?.aborted;
        // Pi returns false for denial, dismissal, and timeout; do not invent a specific cause.
        emit("approval", allowed ? "selected" : signal?.aborted ? "cancelled" : "dismissed", {
          ...details,
          reason: allowed ? decision.reason : signal?.aborted ? "cancelled" : "not_approved",
          durationMs: Date.now() - queuedAt,
        });
        return allowed ? undefined : "Terminal command denied or approval cancelled";
      } catch {
        emit("approval", signal?.aborted ? "cancelled" : "failed", {
          ...details,
          reason: signal?.aborted ? "cancelled" : "approval_failed",
          durationMs: Date.now() - queuedAt,
        });
        return "Terminal approval failed; command was not executed";
      }
    });
    approvalQueue = pending.then(() => {});
    return pending;
  };

  pi.on("session_start", (_event, ctx) => {
    yoloOverride = undefined;
    autoSelectedDecisionSampleIndex = 0;
    try {
      const config = getConfig();
      updateStatus(ctx, config);
      emit("policy", "success", { yoloMode: config.yoloMode });
    } catch {
      emit("policy", "failed", { reason: "invalid_config" });
      if (ctx.hasUI) {
        ctx.ui.setStatus("terminal-permissions", "Terminal: blocked (invalid config)");
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
      let config: TerminalConfig | undefined;
      try {
        config = getConfig();
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
          const approved = await ctx.ui.confirm(
            "Enable YOLO mode?",
            "Supported terminal commands will run without approval. Required-approval and blocked commands still apply.",
            {
              timeout: config.approvalTimeoutMs,
              ...(signal === undefined ? {} : { signal }),
            },
          );
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
        updateStatus(ctx, config);
        const yoloMode = config.allowYoloMode && (yoloOverride ?? config.yoloMode);
        const yoloLabel = `${yoloMode ? "on" : "off"}${config.allowYoloMode ? "" : " (disabled by policy)"}`;
        ctx.ui.notify(
          [
            `YOLO: ${yoloLabel}`,
            `Auto-approve: ${config.autoApproveCommands.map((rule) => rule.text).join(", ") || "none"}`,
            `Require approval: ${config.requireApprovalCommands.map((rule) => rule.text).join(", ") || "none"}`,
            `Blocked: ${config.blockedCommands.map((rule) => rule.text).join(", ") || "none"}`,
            `Approval timeout: ${config.approvalTimeoutMs / 1000}s`,
            "Unmatched commands require approval unless YOLO is on.",
            "Lists use literal command prefixes; complex syntax and wrappers require review.",
          ].join("\n"),
          "info",
        );
      } catch {
        emit(action === "yolo on" || action === "yolo off" ? "yolo" : "policy", "failed", {
          reason: config === undefined ? "invalid_config" : "approval_failed",
          durationMs: Date.now() - startedAt,
        });
        ctx.ui.notify(
          config === undefined
            ? "Invalid terminal permission configuration; terminal execution is blocked."
            : "Terminal approval failed; YOLO mode was not changed.",
          "error",
        );
      }
    },
  });
}
