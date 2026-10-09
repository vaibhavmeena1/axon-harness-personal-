/**
 * Bounded terminal/host classification for `terminal.type`. Only a fixed set of values is ever
 * exported; environment values themselves are never copied into telemetry.
 */
export const TERMINAL_TYPES = [
  "vscode",
  "cursor",
  "windsurf",
  "zed",
  "jetbrains",
  "iterm",
  "apple_terminal",
  "ghostty",
  "warp",
  "wezterm",
  "kitty",
  "alacritty",
  "hyper",
  "windows_terminal",
  "tmux",
  "screen",
  "ssh",
  "other",
  "none",
] as const;

export type TerminalType = (typeof TERMINAL_TYPES)[number];

const TERM_PROGRAMS: Readonly<Record<string, TerminalType>> = {
  "iterm.app": "iterm",
  apple_terminal: "apple_terminal",
  ghostty: "ghostty",
  warpterminal: "warp",
  wezterm: "wezterm",
  hyper: "hyper",
  zed: "zed",
  kitty: "kitty",
  alacritty: "alacritty",
};

type Environment = Readonly<Record<string, string | undefined>>;

function vscodeFork(env: Environment): TerminalType {
  const hint = `${env["VSCODE_GIT_ASKPASS_MAIN"] ?? ""} ${env["__CFBundleIdentifier"] ?? ""}`;
  if (env["CURSOR_TRACE_ID"] || /cursor/i.test(hint)) return "cursor";
  if (/windsurf|codeium/i.test(hint)) return "windsurf";
  return "vscode";
}

/**
 * Classify the hosting terminal from well-known variables. Emulator markers are checked before
 * multiplexers and SSH so tmux inside a recognizable terminal reports the outer terminal. A
 * non-TTY process with no recognizable host is `none` (scripted/RPC use).
 */
export function detectTerminalType(
  env: Environment = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): TerminalType {
  const program = env["TERM_PROGRAM"]?.toLowerCase();
  if (program === "vscode") return vscodeFork(env);
  if (env["TERMINAL_EMULATOR"]?.startsWith("JetBrains")) return "jetbrains";
  if (program && TERM_PROGRAMS[program]) return TERM_PROGRAMS[program];
  if (env["ZED_TERM"]) return "zed";
  if (env["WT_SESSION"]) return "windows_terminal";
  if (env["KITTY_WINDOW_ID"]) return "kitty";
  if (env["ALACRITTY_SOCKET"] || env["ALACRITTY_LOG"]) return "alacritty";
  if (env["WEZTERM_PANE"]) return "wezterm";
  if (env["TMUX"] || program === "tmux") return "tmux";
  if (env["STY"]) return "screen";
  if (env["SSH_CONNECTION"] || env["SSH_TTY"]) return "ssh";
  return isTTY ? "other" : "none";
}
