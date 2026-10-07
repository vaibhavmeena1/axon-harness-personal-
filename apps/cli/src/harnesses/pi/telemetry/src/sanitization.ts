import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Attributes } from "@opentelemetry/api";

const MAX_SUMMARY_LENGTH = 256;
const SECRET_ASSIGNMENT =
  /["']?\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token)["']?\s*([=:])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi;
const SECRET_FLAG =
  /(--(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|token))(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_URL = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;

function truncate(value: string, maximum = MAX_SUMMARY_LENGTH): string {
  return value.length > maximum ? `${value.slice(0, maximum)}…` : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PATH_PATTERN_CACHE = new Map<string, RegExp>();
const PATH_PATTERN_CACHE_LIMIT = 16;

function pathPattern(path: string): RegExp {
  const cached = PATH_PATTERN_CACHE.get(path);
  if (cached) return cached;
  if (PATH_PATTERN_CACHE.size >= PATH_PATTERN_CACHE_LIMIT) PATH_PATTERN_CACHE.clear();
  const pattern = new RegExp(escapeRegExp(path), "g");
  PATH_PATTERN_CACHE.set(path, pattern);
  return pattern;
}

function defaultHomeDirectory(): string | undefined {
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeText(
  value: string,
  cwd: string,
  maximum = MAX_SUMMARY_LENGTH,
  homeDirectory: string | undefined = defaultHomeDirectory(),
): string {
  let sanitized = value.replace(PRIVATE_KEY, "<private-key>");
  sanitized = sanitized.replace(CREDENTIAL_URL, "$1<credentials>@");
  sanitized = sanitized.replace(BEARER, "Bearer <redacted>");
  sanitized = sanitized.replace(SECRET_FLAG, "$1=<redacted>");
  sanitized = sanitized.replace(SECRET_ASSIGNMENT, "$1$2<redacted>");

  sanitized = sanitized.replace(pathPattern(resolve(cwd)), "<project>");
  if (homeDirectory) sanitized = sanitized.replace(pathPattern(resolve(homeDirectory)), "<home>");
  sanitized = sanitized.replace(/(^|[\s"'=])\/(?:[^\s"'|;&]+)/g, "$1<absolute-path>");
  return truncate(sanitized.replace(/\s+/g, " ").trim(), maximum);
}

export function sanitizePath(path: string, cwd: string): string {
  const absolute = resolve(cwd, path);
  const projectRelative = relative(resolve(cwd), absolute);
  if (projectRelative === "") return ".";
  if (
    !projectRelative.startsWith(`..${sep}`) &&
    projectRelative !== ".." &&
    !isAbsolute(projectRelative)
  ) {
    return truncate(projectRelative.split(sep).join("/"));
  }
  return `<external>/${truncate(basename(absolute), 96)}`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" ? value : undefined;
}

export function summarizeShellCommand(command: string, _cwd: string): Attributes {
  // Arbitrary shell text is neither process metadata nor safe content to export.
  return { "pi.command.length": command.length };
}

export function summarizeToolInput(toolName: string, input: unknown, cwd: string): Attributes {
  const record = objectRecord(input);
  if (!record) return { "pi.tool.input_size": 0 };

  const serializedSize = (() => {
    try {
      return JSON.stringify(input).length;
    } catch {
      return 0;
    }
  })();
  const path = stringField(record, "path") ?? stringField(record, "cwd");
  const base: Attributes = { "pi.tool.input_size": serializedSize };

  if (toolName === "bash" || toolName === "powershell") {
    const command = stringField(record, "command");
    return command ? { ...base, ...summarizeShellCommand(command, cwd) } : base;
  }
  if (["read", "write", "edit", "ls"].includes(toolName)) {
    return path ? { ...base, "pi.path": sanitizePath(path, cwd) } : base;
  }
  if (toolName === "find" || toolName === "grep") {
    const pattern = stringField(record, "pattern");
    return {
      ...base,
      ...(path ? { "pi.path": sanitizePath(path, cwd) } : {}),
      ...(pattern ? { "pi.pattern.length": pattern.length } : {}),
    };
  }

  return {
    ...base,
    "pi.tool.input_keys": Object.keys(record).sort().slice(0, 20),
  };
}

export interface ToolOutputSummary {
  readonly textLength: number;
  readonly imageCount: number;
  readonly partCount: number;
  readonly exitCode?: number;
  readonly wallTimeSeconds?: number;
}

/**
 * Measure a tool result without retaining it: text lengths and image counts only. Image bytes and
 * structured `details` are never read, and the result is never serialized.
 */
export function summarizeToolOutput(result: unknown, builtinBash = false): ToolOutputSummary {
  const record = objectRecord(result);
  const structured = builtinBash ? objectRecord(record?.["structuredContent"]) : undefined;
  const exitCode = structured?.["exit_code"];
  const wallTime = structured?.["wall_time_seconds"];
  const metadata = {
    ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(typeof wallTime === "number" && Number.isFinite(wallTime) && wallTime >= 0
      ? { wallTimeSeconds: wallTime }
      : {}),
  };
  const content = record?.["content"];
  if (!Array.isArray(content)) return { textLength: 0, imageCount: 0, partCount: 0, ...metadata };
  let textLength = 0;
  let imageCount = 0;
  for (const part of content) {
    const record = objectRecord(part);
    if (record?.["type"] === "text" && typeof record["text"] === "string")
      textLength += record["text"].length;
    else if (record?.["type"] === "image") imageCount += 1;
  }
  return { textLength, imageCount, partCount: content.length, ...metadata };
}

export function sanitizeError(error: unknown, cwd: string): { type: string; message?: string } {
  if (error instanceof Error) {
    return {
      type: ["Error", "TypeError", "RangeError", "TimeoutError", "tool_execution_error"].includes(
        error.name,
      )
        ? error.name
        : "Error",
      ...(error.message ? { message: sanitizeText(error.message, cwd) } : {}),
    };
  }
  if (typeof error === "string") return { type: "Error", message: sanitizeText(error, cwd) };
  return { type: "Error" };
}
