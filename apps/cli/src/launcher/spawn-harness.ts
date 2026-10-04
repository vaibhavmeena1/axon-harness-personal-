import { scheduleBackgroundUpdate } from "../updater/update.ts";
import type { LaunchSpec } from "./contracts.ts";
import { LauncherError } from "./errors.ts";
import { exitLikeChild, LAUNCHER_EXIT_STATUS } from "./exit-status.ts";

const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

export async function spawnHarness(specification: LaunchSpec): Promise<never> {
  let subprocess: Bun.Subprocess<"inherit", "inherit", "inherit">;
  let spawnError: Error | undefined;

  try {
    subprocess = Bun.spawn([specification.executable, ...specification.arguments], {
      cwd: specification.cwd,
      env: specification.environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      onExit: (_subprocess, _exitCode, _signalCode, error) => {
        spawnError = error;
      },
    });
  } catch (error) {
    specification.dispose?.();
    throw new LauncherError(
      `failed to start harness executable: ${specification.executable}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { cause: error, remediation: "Run ddcli doctor for executable diagnostics." },
    );
  }

  // The terminal sends SIGINT to the whole foreground process group, including the
  // harness. Catch it in the wrapper so the harness can restore terminal state; do
  // not forward it and accidentally deliver the signal twice.
  const ignoreTerminalInterrupt = (): void => {};
  process.on("SIGINT", ignoreTerminalInterrupt);

  const forwardingHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const forwardSignal = (): void => {
      if (subprocess.exitCode === null && subprocess.signalCode === null) {
        subprocess.kill(signal);
      }
    };

    forwardingHandlers.set(signal, forwardSignal);
    process.on(signal, forwardSignal);
  }

  try {
    await subprocess.exited;
  } finally {
    process.off("SIGINT", ignoreTerminalInterrupt);
    for (const [signal, handler] of forwardingHandlers) {
      process.off(signal, handler);
    }
    specification.dispose?.();
  }

  if (spawnError !== undefined) {
    throw new LauncherError(
      `failed to start harness executable: ${specification.executable}`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { cause: spawnError, remediation: "Run ddcli doctor for executable diagnostics." },
    );
  }

  // A detached best-effort worker checks for updates after the interactive session.
  // It cannot delay startup or change the harness's exit status.
  scheduleBackgroundUpdate();
  return exitLikeChild({
    exitCode: subprocess.exitCode,
    signalCode: subprocess.signalCode,
  });
}
