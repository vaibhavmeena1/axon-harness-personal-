import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { CommandWords } from "./command-parser.ts";

export type InspectionDecision = "inspection" | "review" | "unknown";
type ValueKind = "text" | "count" | "path";
interface ArgumentProfile {
  readonly shortFlags: string;
  readonly longFlags?: readonly string[];
  readonly values?: Readonly<Record<string, ValueKind>>;
  readonly pattern?: boolean;
  readonly revisions?: boolean;
  /**
   * Git reads diff.external and textconv drivers from user/repository config, so
   * diff output is inspection only when both helpers are disabled. "always", or
   * the flags that request diff output.
   */
  readonly disableHelpers?: "always" | readonly string[];
}
export type WorkspacePathChecker = (value: string) => boolean;
const HELPER_FLAGS = ["no-ext-diff", "no-textconv"] as const;

const FILE_PROFILES: Readonly<Record<string, ArgumentProfile>> = {
  ls: {
    shortFlags: "aAdFfhiklmnqrstRS1",
    longFlags: ["all", "almost-all", "directory", "human-readable"],
  },
  cat: { shortFlags: "AbEenstTuv" },
  head: { shortFlags: "qv", values: { n: "count", c: "count", lines: "count", bytes: "count" } },
  tail: { shortFlags: "qv", values: { n: "count", c: "count", lines: "count", bytes: "count" } },
  wc: { shortFlags: "cmlwL", longFlags: ["bytes", "chars", "lines", "words", "max-line-length"] },
  grep: {
    shortFlags: "EFGivwxnHhlcsoqrbI",
    longFlags: [
      "fixed-strings",
      "extended-regexp",
      "ignore-case",
      "line-number",
      "files-with-matches",
      "count",
    ],
    values: {
      e: "text",
      regexp: "text",
      f: "path",
      file: "path",
      A: "count",
      B: "count",
      C: "count",
      m: "count",
      include: "text",
      exclude: "text",
      "exclude-dir": "text",
    },
    pattern: true,
  },
  rg: {
    shortFlags: "nNHiSswxlcvoqFUPu0",
    longFlags: [
      "files",
      "hidden",
      "no-ignore",
      "no-ignore-vcs",
      "line-number",
      "no-line-number",
      "ignore-case",
      "smart-case",
      "fixed-strings",
      "word-regexp",
      "count",
      "count-matches",
      "files-with-matches",
      "files-without-match",
      "only-matching",
      "no-heading",
      "heading",
      "stats",
      "multiline",
      "null",
      "no-config",
      "no-messages",
    ],
    values: {
      e: "text",
      regexp: "text",
      f: "path",
      file: "path",
      g: "text",
      glob: "text",
      t: "text",
      type: "text",
      T: "text",
      "type-not": "text",
      A: "count",
      B: "count",
      C: "count",
      m: "count",
      "max-count": "count",
      "max-depth": "count",
      context: "count",
      "after-context": "count",
      "before-context": "count",
    },
    pattern: true,
  },
};

const GIT_PROFILES: Readonly<Record<string, ArgumentProfile>> = {
  status: {
    shortFlags: "sbz",
    longFlags: [
      "short",
      "branch",
      "show-stash",
      "porcelain",
      "porcelain=v1",
      "porcelain=v2",
      "untracked-files",
      "untracked-files=all",
      "untracked-files=normal",
      "untracked-files=no",
      "ignored",
    ],
  },
  diff: {
    shortFlags: "pUsbw",
    longFlags: [
      "stat",
      "shortstat",
      "numstat",
      "name-only",
      "name-status",
      "summary",
      "check",
      "cached",
      "staged",
      "no-ext-diff",
      "no-textconv",
      "no-color",
      "color=never",
      "exit-code",
      "quiet",
      "word-diff",
      "ignore-space-at-eol",
      "ignore-all-space",
      "ignore-space-change",
      "binary",
      "patch",
      "raw",
    ],
    values: { U: "count", unified: "count" },
    revisions: true,
    disableHelpers: "always",
  },
  log: {
    shortFlags: "p",
    longFlags: [
      "oneline",
      "graph",
      "all",
      "decorate",
      "no-decorate",
      "stat",
      "name-only",
      "name-status",
      "no-color",
      "color=never",
      "no-ext-diff",
      "no-textconv",
      "reverse",
      "first-parent",
      "merges",
      "no-merges",
      "date-order",
      "topo-order",
      "patch",
    ],
    values: {
      n: "count",
      "max-count": "count",
      format: "text",
      pretty: "text",
      since: "text",
      until: "text",
      author: "text",
      grep: "text",
    },
    revisions: true,
    disableHelpers: ["p", "patch", "stat"],
  },
  show: {
    shortFlags: "ps",
    longFlags: [
      "stat",
      "name-only",
      "name-status",
      "summary",
      "no-patch",
      "no-color",
      "color=never",
      "no-ext-diff",
      "no-textconv",
      "oneline",
      "patch",
    ],
    values: { format: "text", pretty: "text" },
    revisions: true,
    disableHelpers: "always",
  },
  "ls-files": {
    shortFlags: "zcmos",
    longFlags: [
      "cached",
      "modified",
      "others",
      "deleted",
      "stage",
      "exclude-standard",
      "full-name",
    ],
  },
};

// These are not inspection tools, even if a broad prefix such as "git" was allowed.
const MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "install",
  "mkdir",
  "touch",
  "tee",
  "dd",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "kill",
  "pkill",
  "killall",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "python",
  "python3",
  "node",
  "bun",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "uv",
  "make",
  "docker",
  "kubectl",
  "brew",
]);

/**
 * Explicit operands must remain in the workspace, including their resolved symlinks.
 * Create one checker per decision: it resolves the workspace once and caches operands.
 */
export function createWorkspacePathChecker(cwd: string): WorkspacePathChecker {
  let workspace: string | undefined;
  const results = new Map<string, boolean>();
  const check = (value: string): boolean => {
    if (value === "-") return true;
    if (!value || value.startsWith("~") || value.includes("://")) return false;
    try {
      workspace ??= realpathSync(cwd);
      const target = realpathSync(resolve(cwd, value));
      const path = relative(workspace, target);
      if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return false;
      // Avoid automatically opening devices, sockets, and FIFOs. This is not a sandbox:
      // recursive reads and Git still rely on trusted programs and repository configuration.
      const status = statSync(target);
      return status.isFile() || status.isDirectory();
    } catch {
      return false;
    }
  };
  return (value) => {
    let result = results.get(value);
    if (result === undefined) {
      result = check(value);
      results.set(value, result);
    }
    return result;
  };
}

function validValue(
  kind: ValueKind,
  value: string | undefined,
  isWorkspacePath: WorkspacePathChecker,
): boolean {
  if (value === undefined || value.length === 0) return false;
  // Optional-value flags differ between programs. Never swallow a following
  // option (for example git log --format --output=result) as inert value text.
  if (value.startsWith("-") && !(kind === "path" && value === "-")) return false;
  if (kind === "count") return /^\+?\d{1,9}$/.test(value);
  return kind !== "path" || isWorkspacePath(value);
}

/** Whitelist options, including clustered short flags and attached option values. */
function inspectArguments(
  argumentsVector: CommandWords,
  profile: ArgumentProfile,
  isWorkspacePath: WorkspacePathChecker,
): boolean {
  const flags = new Set<string>();
  let optionsEnded = false;
  let patternSeen = !profile.pattern || argumentsVector.includes("--files");
  for (let index = 0; index < argumentsVector.length; index += 1) {
    const argument = argumentsVector[index];
    if (argument === undefined) return false;
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      const name = argument.slice(2, separator === -1 ? undefined : separator);
      flags.add(name);
      if (profile.longFlags?.includes(argument.slice(2))) continue;
      const kind =
        profile.values && Object.hasOwn(profile.values, name) ? profile.values[name] : undefined;
      if (kind === undefined) return false;
      const value = separator === -1 ? argumentsVector[++index] : argument.slice(separator + 1);
      if (!validValue(kind, value, isWorkspacePath)) return false;
      if (name === "regexp" || name === "file") patternSeen = true;
      continue;
    }
    if (!optionsEnded && argument !== "-" && argument.startsWith("-")) {
      for (let offset = 1; offset < argument.length; offset += 1) {
        const flag = argument[offset];
        if (flag === undefined) return false;
        flags.add(flag);
        const kind =
          profile.values && Object.hasOwn(profile.values, flag) ? profile.values[flag] : undefined;
        if (kind !== undefined) {
          const value = argument.slice(offset + 1) || argumentsVector[++index];
          if (!validValue(kind, value, isWorkspacePath)) return false;
          if (flag === "e" || flag === "f") patternSeen = true;
          break;
        }
        if (!profile.shortFlags.includes(flag)) return false;
      }
      continue;
    }
    if (!patternSeen) {
      patternSeen = true;
    } else if (profile.revisions && !optionsEnded) {
      // Revision expressions are data, not command callbacks. Pathspecs after --
      // must pass workspace checks; reject explicit external paths before it too.
      if (isAbsolute(argument) || argument.split("/").includes("..")) return false;
    } else if (!isWorkspacePath(argument)) {
      return false;
    }
  }
  const helpers = profile.disableHelpers;
  if (helpers === "always" || helpers?.some((flag) => flags.has(flag))) {
    return HELPER_FLAGS.every((flag) => flags.has(flag));
  }
  return true;
}

function inspectFind(
  argumentsVector: CommandWords,
  isWorkspacePath: WorkspacePathChecker,
): boolean {
  const paths: string[] = [];
  let index = 0;
  while (index < argumentsVector.length) {
    const argument = argumentsVector[index];
    if (argument === undefined || argument.startsWith("-")) break;
    paths.push(argument);
    index += 1;
  }
  if (!paths.every((path) => path !== "-" && isWorkspacePath(path))) return false;
  for (; index < argumentsVector.length; index += 1) {
    const argument = argumentsVector[index];
    if (argument === undefined) return false;
    if (["-print", "-print0", "-empty", "-prune", "-quit", "-a", "-o"].includes(argument)) continue;
    const value = argumentsVector[++index];
    if (value === undefined) return false;
    if (["-name", "-iname", "-path", "-ipath"].includes(argument)) continue;
    if (argument === "-type" && /^[bcdflps]$/.test(value)) continue;
    if (["-maxdepth", "-mindepth"].includes(argument) && /^\d{1,9}$/.test(value)) continue;
    return false;
  }
  return true;
}

function inspectSed(argumentsVector: CommandWords, isWorkspacePath: WorkspacePathChecker): boolean {
  // Only bounded print expressions, never arbitrary sed scripts (-i, w, e, r, etc.).
  if (argumentsVector[0] !== "-n") return false;
  const expression = argumentsVector[1];
  if (expression === undefined || !/^\d+(?:,\d+)?p$/.test(expression)) return false;
  return argumentsVector.slice(2).every((path) => !path.startsWith("-") && isWorkspacePath(path));
}

/** Unknown programs never acquire trust just because the LLM marks a call safe. */
export function classifyInspectionCommand(
  words: CommandWords,
  cwd: string,
  isWorkspacePath: WorkspacePathChecker = createWorkspacePathChecker(cwd),
): InspectionDecision {
  const executable = words[0];
  if (executable === undefined) return "review";
  // An explicit path can name an unrelated executable with a familiar basename.
  if (executable.includes("/")) return "review";
  if (MUTATING_COMMANDS.has(executable)) return "review";
  const argumentsVector = words.slice(1);
  if (executable === "pwd") {
    return argumentsVector.every((argument) => ["-L", "-P"].includes(argument))
      ? "inspection"
      : "review";
  }
  const profile = Object.hasOwn(FILE_PROFILES, executable) ? FILE_PROFILES[executable] : undefined;
  if (profile !== undefined) {
    return inspectArguments(argumentsVector, profile, isWorkspacePath) ? "inspection" : "review";
  }
  if (executable === "find")
    return inspectFind(argumentsVector, isWorkspacePath) ? "inspection" : "review";
  if (executable === "sed")
    return inspectSed(argumentsVector, isWorkspacePath) ? "inspection" : "review";
  if (executable === "git") {
    let subcommandIndex = 0;
    while (
      ["--no-pager", "--literal-pathspecs", "--no-optional-locks"].includes(
        argumentsVector[subcommandIndex] ?? "",
      )
    ) {
      subcommandIndex += 1;
    }
    const subcommand = argumentsVector[subcommandIndex];
    const gitProfile =
      subcommand !== undefined && Object.hasOwn(GIT_PROFILES, subcommand)
        ? GIT_PROFILES[subcommand]
        : undefined;
    if (gitProfile === undefined) return "review";
    return inspectArguments(argumentsVector.slice(subcommandIndex + 1), gitProfile, isWorkspacePath)
      ? "inspection"
      : "review";
  }
  return "unknown";
}
