import { Command, CommanderError } from "commander";

import { BUILD_INFO } from "../build-info.ts";
import { currentPiInvocationEnvironment } from "../harnesses/pi/setup/packages/invocation.ts";
import { resolveHarnessRegistration } from "../harnesses/registry.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../product/identity.ts";
import { resolveAxonPaths } from "../product/paths.ts";
import { checkForUpdate, installUpdate } from "../updater/update.ts";
import { ensureAxonSession } from "./auth/preflight.ts";
import { type AuthLoginOptions, runAuthLogin, runAuthStatus } from "./commands/auth.ts";
import { runDoctor } from "./commands/doctor.ts";
import { printHarnesses } from "./commands/harnesses.ts";
import { printPaths } from "./commands/paths.ts";
import { runSessions, runSessionsInteractive } from "./commands/sessions.ts";
import { runSetup, type SetupOptions } from "./commands/setup.ts";
import { runUninstall, type UninstallOptions } from "./commands/uninstall.ts";

function setExitStatus(status: number): void {
  if (status !== 0) {
    process.exitCode = status;
  }
}

function createLauncherProgram(): Command {
  const program = new Command();
  program
    .name(PRODUCT_IDENTITY.command)
    .description(`${PRODUCT_IDENTITY.displayName} Pi launcher`)
    .usage("<harness> [harness arguments...] | <command> [options]")
    .helpOption("-h, --help", "display launcher help")
    .version(BUILD_INFO.version, "-V, --version", "display launcher version")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("harnesses")
    .description("list supported harness IDs")
    .action(() => {
      printHarnesses();
    });

  program
    .command("paths")
    .description("show managed Axon paths")
    .action(() => {
      printPaths(resolveAxonPaths());
    });

  const auth = program.command("auth").description("manage the local Axon session");
  auth
    .command("login")
    .description("sign in to Axon from your browser")
    .option("--browser", "open the browser without a selection prompt")
    .action(async (options: AuthLoginOptions) => {
      await runAuthLogin(resolveAxonPaths(), options);
    });
  auth
    .command("status")
    .description("verify the saved Axon session with the auth service")
    .action(async () => {
      await runAuthStatus(resolveAxonPaths());
    });

  const sessions = program
    .command("sessions")
    .description("manage session backups interactively, or use explicit subcommands for scripts")
    .action(() => runSessionsInteractive());
  sessions
    .command("list")
    .description("list latest owned remote backups")
    .action(() => runSessions("list"));
  sessions
    .command("status")
    .description("show administrator policy, confirmed and pending backup status")
    .action(() => runSessions("status"));
  sessions
    .command("retry")
    .description("explicitly retry repaired/access-restored snapshots")
    .action(() => runSessions("retry"));
  sessions
    .command("restore")
    .argument("<session-id>")
    .requiredOption("--cwd <checkout>", "existing local checkout")
    .option("--yes", "confirm this explicit download/fork without prompting")
    .action((id: string, options: { cwd: string; yes?: boolean }) =>
      runSessions("restore", id, options),
    );
  sessions
    .command("delete")
    .argument("<session-id>")
    .option("--yes", "confirm remote backup deletion")
    .action((id: string, options: { yes?: boolean }) => runSessions("delete", id, options));

  program
    .command("doctor")
    .description("diagnose the launcher and installed harnesses")
    .argument("[harness]", "stable harness ID")
    .action(async (harness: string | undefined) => {
      const environment = process.env;
      const status = await runDoctor(
        {
          cwd: process.cwd(),
          environment,
          paths: resolveAxonPaths(environment),
        },
        harness,
      );
      setExitStatus(status);
    });

  program
    .command("setup")
    .description("prepare a managed harness")
    .argument("<harness>", "stable harness ID (currently pi)")
    .option("--sync-packages", "install or repair required packages")
    .action(async (harness: string, options: SetupOptions) => {
      await runSetup(harness, options);
    });

  program
    .command("update")
    .description("download and install the latest verified macOS arm64 release")
    .option("--check", "report whether a newer release is available without installing")
    .action(async (options: { check?: boolean }) => {
      if (options.check) {
        try {
          const available = await checkForUpdate();
          console.log(available ? `axon ${available} is available` : "axon is up to date");
        } catch (error) {
          throw new LauncherError(
            "could not check for axon updates",
            LAUNCHER_EXIT_STATUS.updateFailure,
            {
              cause: error,
              remediation: "Check network connectivity and retry axon update --check.",
            },
          );
        }
      } else {
        const installed = await installUpdate();
        console.log(installed ? `Updated axon to ${installed}` : "axon is up to date");
      }
    });

  program
    .command("uninstall")
    .description("remove the managed binary while preserving user data by default")
    .option("--remove-runtimes", "also remove cached immutable runtimes")
    .action(async (options: UninstallOptions) => {
      await runUninstall(resolveAxonPaths(), options);
    });

  program.hook("preAction", async (_command, actionCommand) => {
    const name = actionCommand.name();
    if (!["harnesses", "paths", "doctor", "setup"].includes(name)) return;
    // Let the action report invalid harness/operation usage without prompting.
    const harness = actionCommand.args[0];
    if (
      (name === "doctor" && harness !== undefined && !resolveHarnessRegistration(harness)) ||
      (name === "setup" &&
        (harness !== "pi" || actionCommand.opts<SetupOptions>().syncPackages !== true))
    )
      return;
    const invocation = currentPiInvocationEnvironment();
    await ensureAxonSession(resolveAxonPaths(), {
      interactive: !invocation.ci && invocation.stdinIsTty && invocation.stdoutIsTty,
    });
  });

  program.addHelpText(
    "after",
    `\nHarnesses:\n  ${PRODUCT_IDENTITY.command} pi [pi arguments...]\n\nEverything after a harness ID is passed to that harness without launcher parsing.`,
  );

  return program;
}

export async function runLauncherProgram(argumentsVector: readonly string[]): Promise<void> {
  const program = createLauncherProgram();

  if (argumentsVector.length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync([...argumentsVector], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) {
        process.exitCode = LAUNCHER_EXIT_STATUS.usage;
      }
      return;
    }

    throw error;
  }
}
