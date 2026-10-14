import { isTrue } from "../../../../launcher/debug-preview.ts";

export type PiInvocationKind = "administrative" | "interactive" | "noninteractive";

export interface PiInvocationEnvironment {
  readonly ci: boolean;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
}

// Pi routes these on its first argument. Anything Axon prepends would turn
// the command into a prompt, so forwarded administration must stay untouched.
const ADMINISTRATIVE_COMMANDS = new Set([
  "auth",
  "config",
  "install",
  "list",
  "mcp",
  "remove",
  "uninstall",
  "update",
]);
const ADMINISTRATIVE_FLAGS = new Set(["--help", "-h", "--version", "-v"]);
const NONINTERACTIVE_FLAGS = new Set(["--print", "-p", "--export"]);
const OPTION_TERMINATOR = "--";
const OFFLINE_FLAG = "--offline";
const OFFLINE_ENVIRONMENT_VARIABLE = "PI_OFFLINE";

/**
 * Pi stops option parsing at `--`; everything after it is a message or file.
 * Only the tokens before it may change how Axon classifies a launch.
 */
export function piOptionTokens(argumentsVector: readonly string[]): readonly string[] {
  const terminatorIndex = argumentsVector.indexOf(OPTION_TERMINATOR);
  return terminatorIndex === -1 ? argumentsVector : argumentsVector.slice(0, terminatorIndex);
}

export function currentPiInvocationEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PiInvocationEnvironment {
  const ciValue = (Reflect.get(environment, "CI") as string | undefined)?.toLowerCase();
  return {
    ci: ciValue === "1" || ciValue === "true" || ciValue === "yes",
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
  };
}

export function classifyPiInvocation(
  argumentsVector: readonly string[],
  environment: PiInvocationEnvironment = currentPiInvocationEnvironment(),
): PiInvocationKind {
  const first = argumentsVector[0];
  const options = piOptionTokens(argumentsVector);
  if (
    (first !== undefined && ADMINISTRATIVE_COMMANDS.has(first)) ||
    options.some((argument) => ADMINISTRATIVE_FLAGS.has(argument))
  ) {
    return "administrative";
  }

  const modeIndex = options.indexOf("--mode");
  const mode = modeIndex === -1 ? undefined : options[modeIndex + 1];
  if (
    environment.ci ||
    !environment.stdinIsTty ||
    !environment.stdoutIsTty ||
    mode === "json" ||
    mode === "rpc" ||
    options.some((argument) => NONINTERACTIVE_FLAGS.has(argument))
  ) {
    return "noninteractive";
  }

  return "interactive";
}

/**
 * Mirrors Pi's own offline detection: `--offline` before `--` or a truthy
 * `PI_OFFLINE`. Offline launches must not start Axon network work either.
 */
export function isPiOffline(
  environment: NodeJS.ProcessEnv,
  argumentsVector: readonly string[],
): boolean {
  return (
    piOptionTokens(argumentsVector).includes(OFFLINE_FLAG) ||
    isTrue(Reflect.get(environment, OFFLINE_ENVIRONMENT_VARIABLE) as string | undefined)
  );
}
